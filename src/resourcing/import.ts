import { createHash } from 'node:crypto';
import type { ScoringConfig } from '../recommendations/models.js';
import { datedResearcherSchema, type Account, type Assignment, type DatedResearcher, type ImportReport } from './models.js';
import type { Check, Row } from './store.js';

/** A parsed upload waiting for a manager to apply it. Only derived staffing facts are stored, never the file. */
export interface ImportDraft {
  fileNames: string[]; uploadedBy: string; createdAt: string; maxAccounts: number;
  researchers: DatedResearcher[]; accounts: Account[]; report: ImportReport;
  /** Scoring policy used only when the upload initializes an empty namespace. */
  config: ScoringConfig;
  appliedAt?: string;
}
export interface CurrentState {
  researchers: Row<DatedResearcher>[]; accounts: Row<Account>[]; report?: Row<ImportReport>;
  /** Assignments a manager cancelled or moved in Slack; a re-import never overrides those decisions. */
  changedAssignmentIds: Set<string>;
}

// Seeds before assignments were tagged used `<researcher>_<account>` IDs, which approvals (`<uuid>_<researcher>`) never produce.
const fromWorkbook = (r: DatedResearcher, a: Assignment) => a.source === 'workbook' || a.id === `${r.id}_${a.accountId}`;
const overlaps = (a: Assignment, b: Assignment) => a.startDate <= b.endDate && b.startDate <= a.endDate;
// Years since hire move every day; they are recomputed on the next real change rather than rewriting every row.
const comparable = ({ experienceYears: _years, assignments: _assignments, ...rest }: DatedResearcher) => JSON.stringify(rest);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge an uploaded workbook into live staffing state. Workbook-derived assignments follow the grid; approvals and manager changes
 * made in Slack are kept. Assignments are never removed or reordered (positions address them), so a box unchecked in the
 * workbook cancels its assignment. Researchers missing from the upload become inactive with their assignments intact.
 */
export function planImport(draft: ImportDraft, current: CurrentState) {
  const puts: Row[] = [], checks: Check[] = [], lines: string[] = [];
  const accountNames = new Map([...current.accounts.map(a => [a.data.id, a.data.name] as const), ...draft.accounts.map(a => [a.id, a.name] as const)]);
  const account = (id: string) => accountNames.get(id) ?? id;
  const incoming = new Map(draft.researchers.map(r => [r.id, r]));

  for (const row of current.researchers) {
    const old = row.data, fresh = incoming.get(old.id);
    if (!fresh) {
      if (old.active) {
        puts.push({ ...row, version: row.version + 1, data: { ...old, active: false } }); checks.push({ key: row.key, version: row.version });
        lines.push(`${old.name}: no longer in the workbook; marked inactive, existing assignments kept`);
      }
      continue;
    }
    const assignments = [...old.assignments], wanted = new Map(fresh.assignments.map(a => [a.id, a]));
    assignments.forEach((a, i) => {
      if (!fromWorkbook(old, a)) return;
      const next = wanted.get(a.id);
      if (current.changedAssignmentIds.has(a.id)) {
        if (next && a.status === 'cancelled') lines.push(`${old.name}: ${account(a.accountId)} is checked in the workbook but was cancelled in Slack; keeping the cancellation`);
        return;
      }
      if (next && !same({ ...a, source: 'workbook' }, next)) {
        assignments[i] = next;
        if (a.status === 'cancelled') lines.push(`${old.name}: added back to ${account(a.accountId)}`);
      } else if (!next && a.status === 'active') {
        assignments[i] = { ...a, status: 'cancelled' };
        lines.push(`${old.name}: removed from ${account(a.accountId)}`);
      }
    });
    for (const a of fresh.assignments) {
      if (assignments.some(e => e.id === a.id)) continue;
      // An approval already copied into Excel is the same assignment: count it once.
      if (assignments.some(e => !fromWorkbook(old, e) && e.status === 'active' && e.accountId === a.accountId && overlaps(e, a))) {
        lines.push(`${old.name}: ${account(a.accountId)} is already approved in Slack; counted once`); continue;
      }
      assignments.push(a); lines.push(`${old.name}: added to ${account(a.accountId)}`);
    }
    const merged = datedResearcherSchema.parse({ ...fresh, active: true, assignments });
    if (comparable(merged) !== comparable(old) || !same(merged.assignments, old.assignments)) {
      if (comparable({ ...merged, assignments: [] }) !== comparable({ ...old, assignments: [] })) {
        const changed = (['name', 'skills', 'maxAccounts', 'availableFrom', 'availableUntil', 'away', 'interests', 'industryExperienceIds', 'profile', 'active'] as const)
          .filter(k => !same(merged[k], old[k]));
        if (changed.length) lines.push(`${old.name}: ${changed.map(k => ({ maxAccounts: 'account cap', industryExperienceIds: 'industry experience', profile: '1:1 profile', active: 'reactivated', away: 'away periods' } as Record<string, string>)[k] ?? k.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`)).join(', ')} updated`);
      }
      puts.push({ key: row.key, version: row.version + 1, data: merged }); checks.push({ key: row.key, version: row.version });
    }
  }
  const existing = new Set(current.researchers.map(r => r.data.id));
  for (const r of draft.researchers.filter(r => !existing.has(r.id))) {
    puts.push({ key: `RESEARCHER#${r.id}`, version: 1, data: r }); checks.push({ key: `RESEARCHER#${r.id}`, version: null });
    lines.push(`${r.name}: new ${r.skills[0]}${r.assignments.length ? ` on ${r.assignments.map(a => account(a.accountId)).join(', ')}` : ''}`);
  }
  const accounts = new Map(current.accounts.map(a => [a.data.id, a]));
  for (const a of draft.accounts) {
    const row = accounts.get(a.id);
    if (row && same(row.data, a)) continue;
    puts.push({ key: `ACCOUNT#${a.id}`, version: (row?.version ?? 0) + 1, data: a }); checks.push({ key: `ACCOUNT#${a.id}`, version: row?.version ?? null });
    lines.push(row ? `Account ${a.name}: industries ${a.industries?.join(', ') || 'cleared'}` : `New account: ${a.name}${a.industries?.length ? ` (${a.industries.join(', ')})` : ''}`);
  }
  const changes = lines.length;
  lines.sort((a, b) => a.localeCompare(b));
  if (!changes) lines.push('No researcher, assignment, or account changes.');
  lines.push(`Import issues after this update: ${draft.report.excluded.length} excluded, ${draft.report.warnings.length} warning(s). Review them with /resourcing issues.`);
  puts.push({ key: 'IMPORT', version: (current.report?.version ?? 0) + 1, data: draft.report }); checks.push({ key: 'IMPORT', version: current.report?.version ?? null });
  // The preview fingerprint: apply goes ahead only if it would make exactly the changes the manager reviewed.
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  return { puts, checks, lines, changes, hash };
}
