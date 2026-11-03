import type { DatedRun } from './models.js';

/** Hours for the original fictional pilot; account slots for workbook data, where each account uses one slot. */
export type CapacityUnits = { kind: 'hours' } | { kind: 'account-slots'; maxAccounts: number };
export const HOURS: CapacityUnits = { kind: 'hours' };
export const amount = (units: CapacityUnits, n: number) => units.kind === 'hours' ? `${n} hours/week` : `${n} account slot${n === 1 ? '' : 's'}`;
const reason = (value: string) => value.replace(/hours\/week/g, 'account slots').replace(/Missing essential skills: ([\w-]+)/, 'Role is not $1');

/** Restate a run computed with one "hour" per account in account-slot wording. Scores and ordering are unchanged. */
export function inSlots(run: DatedRun, maxAccounts: number): DatedRun {
  const { startDate, endDate, requiredSkills } = run.request;
  const retained = run.retained.map(r => {
    const facts = [`${r.remainingHours} of ${maxAccounts} account slots free throughout ${startDate} to ${endDate}`,
      `${r.hoursAfterAssignment} slot${r.hoursAfterAssignment === 1 ? '' : 's'} would remain after this account`, `role: ${requiredSkills.join(', ')}`,
      ...r.facts.slice(3).map(f => f.replace('years of experience', 'years since hire'))];
    return { ...r, facts, explanation: facts.join('; ') + '.' };
  });
  return { ...run, retained, displayed: retained.slice(0, run.displayed.length), excluded: run.excluded.map(e => ({ ...e, reasons: e.reasons.map(reason) })) };
}
