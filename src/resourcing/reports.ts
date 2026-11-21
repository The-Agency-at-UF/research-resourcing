import { awayConflicts, overloads } from './capacity.js';
import type { Account, Approval, Change, DatedResearcher, RequestState, Review, RunState } from './models.js';
import type { Row } from './store.js';
import type { CapacityUnits } from './units.js';

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2 : undefined;
};
const percent = (part: number, whole: number) => whole ? ` (${Math.round(100 * part / whole)}%)` : '';

/** The brief's success measures: request-to-approval time, recommendation acceptance, and capacity adherence. */
export function computeMetrics(rows: Row[]) {
  const by = <T>(prefix: string) => rows.filter(r => r.key.startsWith(prefix)).map(r => ({ id: r.key.slice(prefix.length), data: r.data as T }));
  const requests = by<RequestState>('REQUEST#'), approvals = by<Approval>('APPROVAL#').map(a => a.data);
  const reviews = new Map(by<Review>('REVIEW#').map(r => [r.id, r.data])), runs = new Map(by<RunState>('RUN#').map(r => [r.id, r.data]));
  const changes = by<Change>('CHANGE#').map(c => c.data), researchers = by<DatedResearcher>('RESEARCHER#').map(r => r.data);
  const decisionHours = requests.flatMap(({ id, data }) => {
    const first = approvals.filter(a => a.requestId === id).map(a => a.approvedAt).sort()[0];
    return data.createdAt && first ? [(Date.parse(first) - Date.parse(data.createdAt)) / 36e5] : [];
  });
  let selections = 0, shown = 0, measured = 0, topPicks = 0;
  for (const approval of approvals) {
    const run = runs.get(reviews.get(approval.id)?.runId ?? '')?.run;
    if (!run) continue;
    measured++;
    if (run.retained[0] && approval.researcherIds.includes(run.retained[0].researcherId)) topPicks++;
    for (const id of approval.researcherIds) {
      selections++;
      const rank = run.retained.findIndex(r => r.researcherId === id) + 1;
      if (rank && rank <= run.displayed.length) shown++;
    }
  }
  return {
    requests: { total: requests.length, open: requests.filter(r => r.data.status === 'awaiting_manager' || r.data.status === 'partial').length,
      filled: requests.filter(r => r.data.status === 'filled').length, declined: requests.filter(r => r.data.status === 'declined').length },
    approvals: approvals.length,
    decisionHours: { count: decisionHours.length, median: median(decisionHours), max: decisionHours.length ? Math.max(...decisionHours) : undefined },
    acceptance: { selections, shown, approvalsMeasured: measured, topPicks },
    capacity: { researchers: researchers.length, overloaded: researchers.map(r => ({ name: r.name, periods: overloads(r) })).filter(o => o.periods.length) },
    changes: { cancelled: changes.filter(c => c.action === 'cancel').length, rescheduled: changes.filter(c => c.action === 'reschedule').length },
  };
}
export type ResourcingMetrics = ReturnType<typeof computeMetrics>;

export function metricsText(m: ResourcingMetrics, asOf: string) {
  const hours = (h: number | undefined) => h === undefined ? 'n/a' : `${h.toFixed(1)} h`;
  return [
    `Metrics as of ${asOf}`,
    `Requests: ${m.requests.total} total, ${m.requests.open} open, ${m.requests.filled} filled, ${m.requests.declined} declined. Approvals: ${m.approvals}.`,
    m.decisionHours.count ? `Request to first approval: median ${hours(m.decisionHours.median)}, slowest ${hours(m.decisionHours.max)} (${m.decisionHours.count} requests).` : 'Request to first approval: no approved requests with a recorded start time yet.',
    m.acceptance.selections ? `Recommendation acceptance: ${m.acceptance.shown} of ${m.acceptance.selections} approved researchers were among those shown${percent(m.acceptance.shown, m.acceptance.selections)}; the top-ranked candidate was chosen in ${m.acceptance.topPicks} of ${m.acceptance.approvalsMeasured} approvals${percent(m.acceptance.topPicks, m.acceptance.approvalsMeasured)}.` : 'Recommendation acceptance: no approvals yet.',
    m.capacity.overloaded.length
      ? `Capacity: ${m.capacity.overloaded.length} of ${m.capacity.researchers} researchers over capacity:\n${m.capacity.overloaded.map(o => `- ${o.name}: ${o.periods.map(p => `${p.from} to ${p.until} (${p.accounts} accounts, load ${p.load})`).join('; ')}`).join('\n')}`
      : `Capacity: all ${m.capacity.researchers} researchers within capacity.`,
    `Assignment changes: ${m.changes.cancelled} cancelled, ${m.changes.rescheduled} rescheduled.`,
  ].join('\n');
}

/** Who is on what from today onward, plus current load; posted as the Resourcing HQ message and shown by /resourcing hq. */
export function resourcingText(snapshot: { researchers: DatedResearcher[]; accounts: Account[] }, today: string, units: CapacityUnits, label: string) {
  const names = new Map(snapshot.accounts.map(a => [a.id, a.name]));
  const byAccount = new Map<string, string[]>();
  for (const r of snapshot.researchers) for (const a of r.assignments) {
    if (a.status !== 'active' || a.endDate < today) continue;
    const account = names.get(a.accountId) ?? (a.accountId.startsWith('unlisted-') ? 'Unlisted account' : a.accountId);
    byAccount.set(account, [...byAccount.get(account) ?? [], `${r.name} (${a.startDate > today ? `from ${a.startDate} ` : ''}to ${a.endDate})`]);
  }
  const load = (r: DatedResearcher) => r.assignments.filter(a => a.status === 'active' && a.startDate <= today && a.endDate >= today).reduce((sum, a) => sum + a.hoursPerWeek, 0);
  const unit = units.kind === 'hours' ? ' h/week' : ' accounts';
  const people = [...snapshot.researchers].sort((a, b) => a.name.localeCompare(b.name));
  const awayNow = (r: DatedResearcher) => (r.away ?? []).some(w => w.from <= today && w.until >= today);
  const free = people.filter(r => load(r) === 0 && r.availableUntil >= today && !awayNow(r));
  const conflicts = people.flatMap(r => awayConflicts(r).filter(c => c.assignmentEnd >= today && c.until >= today)
    .map(c => `${r.name} on ${names.get(c.accountId) ?? c.accountId} (away ${c.from} to ${c.until})`));
  return [
    `${label} — Resourcing HQ as of ${today}`,
    ...[...byAccount].sort(([a], [b]) => a.localeCompare(b)).map(([account, members]) => `${account}: ${members.join(', ')}`),
    byAccount.size ? '' : 'No active assignments.',
    `Current load: ${people.filter(r => load(r) > 0).map(r => `${r.name} ${load(r)}/${r.weeklyCapacityHours}${unit}`).join(', ') || 'none'}`,
    `No current accounts: ${free.map(r => r.name).join(', ') || 'none'}`,
    ...(conflicts.length ? [`Assigned while away: ${conflicts.join('; ')}`] : []),
  ].filter((line, i, all) => line !== '' || i < all.length - 1).join('\n');
}
