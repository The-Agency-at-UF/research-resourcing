import { recommend } from '../recommendations/scoring.js';
import { availableHours } from '../recommendations/hours.js';
import type { ScoringConfig } from '../recommendations/models.js';
import { datedRequestSchema, datedResearcherSchema, type DatedResearcher, type DatedRequest, type DatedRun } from './models.js';

const day = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
const date = (value: number) => new Date(value * 86_400_000).toISOString().slice(0, 10);
export function capacityForPeriod(r: DatedResearcher, request: Pick<DatedRequest, 'accountId' | 'hoursPerResearcher' | 'startDate' | 'endDate'>) {
  const start = day(request.startDate), end = day(request.endDate);
  const assignments = r.assignments.filter(a => a.status === 'active' && a.startDate <= request.endDate && a.endDate >= request.startDate);
  const boundaries = [...new Set([start, end + 1, ...assignments.flatMap(a => [Math.max(start, day(a.startDate)), Math.min(end + 1, day(a.endDate) + 1)])])].sort((a, b) => a - b);
  let minFreeHours = r.weeklyCapacityHours, maxAccounts = 0;
  const reasons: string[] = [];
  if (r.availableFrom > request.startDate || r.availableUntil < request.endDate) reasons.push(`Availability ${r.availableFrom} to ${r.availableUntil} does not cover the request`);
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i]!, until = boundaries[i + 1]! - 1;
    const active = assignments.filter(a => day(a.startDate) <= from && day(a.endDate) >= from);
    const free = availableHours(r.weeklyCapacityHours - active.reduce((sum, a) => sum + a.hoursPerWeek, 0), request.hoursPerResearcher, r.weeklyCapacityHours);
    const accounts = new Set(active.map(a => a.accountId)).size;
    minFreeHours = Math.min(minFreeHours, free); maxAccounts = Math.max(maxAccounts, accounts);
    const period = `${date(from)} to ${date(until)}`;
    if (free < request.hoursPerResearcher) reasons.push(`Only ${free} hours/week available on ${period}; ${request.hoursPerResearcher} required`);
    if (accounts >= r.maxAccounts) reasons.push(`Maximum account load reached on ${period}`);
    if (active.some(a => a.accountId === request.accountId)) reasons.push(`Already assigned to this account on ${period}`);
  }
  return { minFreeHours, maxAccounts, reasons };
}

/** Periods where active commitments exceed weekly capacity or the simultaneous account limit. */
export function overloads(r: DatedResearcher) {
  const active = r.assignments.filter(a => a.status === 'active');
  const points = [...new Set(active.flatMap(a => [day(a.startDate), day(a.endDate) + 1]))].sort((a, b) => a - b);
  const found: { from: string; until: string; load: number; accounts: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!, current = active.filter(a => day(a.startDate) <= from && day(a.endDate) >= from);
    const load = current.reduce((sum, a) => sum + a.hoursPerWeek, 0), accounts = new Set(current.map(a => a.accountId)).size;
    if (load > r.weeklyCapacityHours + 1e-9 || accounts > r.maxAccounts) found.push({ from: date(from), until: date(points[i + 1]! - 1), load, accounts });
  }
  return found;
}

const profileFacts = (profile: DatedResearcher['profile']) => !profile ? ['no 1:1 profile on file'] : [
  ...(profile.hoursPerWeek !== undefined ? [`reported about ${profile.hoursPerWeek} hours/week on The Agency at their 1:1`] : []),
  ...(profile.accountCap !== undefined ? [`asked for at most ${profile.accountCap} account${profile.accountCap === 1 ? '' : 's'}`] : []),
];

/** Separate dated boundary; never interpret old snapshot totals as a schedule. */
export function recommendForPeriod(rawResearchers: unknown[], rawRequest: unknown, config: ScoringConfig): DatedRun {
  const request = datedRequestSchema.parse(rawRequest);
  const { startDate: _start, endDate: _end, ...legacyRequest } = request;
  const excluded: DatedRun['excluded'] = [], snapshots: unknown[] = [], profiles = new Map<string, DatedResearcher['profile']>();
  const counts = new Map<string, number>();
  let profiled = false;
  for (const raw of rawResearchers) {
    const id = raw && typeof raw === 'object' && 'id' in raw ? String(raw.id).trim() : '';
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [index, raw] of rawResearchers.entries()) {
    const parsed = datedResearcherSchema.safeParse(raw);
    const rawId = raw && typeof raw === 'object' && 'id' in raw ? String(raw.id).trim() : `row-${index + 1}`;
    if (!parsed.success || (counts.get(rawId) ?? 0) > 1) {
      excluded.push({ researcherId: rawId, dataIssue: true, reasons: !parsed.success ? parsed.error.issues.map(i => i.message) : ['Conflicting duplicate researcher ID'] }); continue;
    }
    const r = parsed.data, capacity = capacityForPeriod(r, request);
    profiled ||= r.profile !== undefined;
    if (capacity.reasons.length) {
      if (r.profile?.accountCap !== undefined && capacity.reasons.some(x => /available on|Maximum account load/.test(x))) capacity.reasons.push(`Asked for at most ${r.profile.accountCap} account${r.profile.accountCap === 1 ? '' : 's'} at their 1:1`);
      excluded.push({ researcherId: r.id, dataIssue: false, reasons: capacity.reasons }); continue;
    }
    profiles.set(r.id, r.profile);
    const { assignments: _assignments, availableFrom: _from, availableUntil: _until, profile: _profile, ...profile } = r;
    // Synthetic slot IDs represent the peak simultaneous count, never a union of non-overlapping accounts.
    snapshots.push({ ...profile, committedHours: r.weeklyCapacityHours - capacity.minFreeHours,
      currentAccountIds: Array.from({ length: capacity.maxAccounts }, (_, i) => `capacity-slot-${i}`) });
  }
  // The same-account overlap check above is independent of synthetic account slot IDs.
  const run = recommend(snapshots, { ...legacyRequest, accountId: `request:${request.accountId}` }, config);
  const warnings = [...run.warnings];
  if (excluded.some(e => e.dataIssue) && !warnings.some(w => w.includes('incomplete'))) warnings.push('Some researcher records are incomplete or conflicting; manager review is required.');
  const retained = run.retained.map(candidate => {
    const facts = candidate.facts.map((fact, i) => i === 0 ? `At least ${candidate.remainingHours} hours/week available throughout ${request.startDate} to ${request.endDate}; request needs ${request.hoursPerResearcher}` : i === 4 ? `${fact.replace('currently used', 'used at peak')} during the requested period` : fact);
    // Only workbook namespaces seeded with 1:1 profiles mention them.
    if (profiled) facts.push(...profileFacts(profiles.get(candidate.researcherId)));
    return { ...candidate, facts, explanation: facts.join('; ') + '.' };
  });
  return { ...run, request, retained, displayed: retained.slice(0, config.displayCount), excluded: [...excluded, ...run.excluded], warnings };
}
