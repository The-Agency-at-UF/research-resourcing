import type { ScoringConfig } from '../recommendations/models.js';
import type { ParsedWorkbook } from '../workbook/parse.js';
import { workbookResearchers, type WorkbookSettings } from '../workbook/researchers.js';
import { datedResearcherSchema, type DatedResearcher, type ImportReport, type SeedInfo } from './models.js';
import type { PilotStore, Row } from './store.js';

// Pilot permissions only; never a production allowlist.
const PILOT_MANAGERS = [{ id: 'U06QLUN31L0', name: 'Patricia' }, { id: 'U09SWCWCDL3', name: 'Camila' }, { id: 'U0AS0D7GQMB', name: 'Roger' }];
const managerRows = (): Row[] => PILOT_MANAGERS.map(m => ({ key: `MANAGER#${m.id}`, version: 1, data: { name: m.name, enabled: true } }));

export function pilotSeed(config: ScoringConfig): Row[] {
  const researchers = [
    { id: 'sample-sam', name: 'Sample Sam', hours: 12, assignments: [] },
    { id: 'sample-avery', name: 'Sample Avery', hours: 10, assignments: [{ id: 'existing-avery', accountId: 'sample-retail', startDate: '2026-11-02', endDate: '2026-11-13', hoursPerWeek: 4, status: 'active' }] },
    { id: 'sample-quinn', name: 'Sample Quinn', hours: 10, assignments: [{ id: 'existing-quinn', accountId: 'sample-retail', startDate: '2026-11-09', endDate: '2026-11-20', hoursPerWeek: 6, status: 'active' }] },
    { id: 'sample-jordan', name: 'Sample Jordan', hours: 8, assignments: [] },
    { id: 'sample-riley', name: 'Sample Riley', hours: 8, assignments: [{ id: 'cancelled-riley', accountId: 'sample-retail', startDate: '2026-11-02', endDate: '2026-12-31', hoursPerWeek: 8, status: 'cancelled' }] },
    { id: 'sample-taylor', name: 'Sample Taylor', hours: 6, assignments: [] },
  ].map(r => ({ key: `RESEARCHER#${r.id}`, version: 1, data: datedResearcherSchema.parse({
    id: r.id, name: r.name, active: true, weeklyCapacityHours: r.hours, maxAccounts: 3, skills: ['survey-design', 'data-analysis', 'interviewing'],
    experienceYears: 3, interests: ['consumer-research'], industryExperienceIds: ['healthcare'],
    availableFrom: '2026-01-01', availableUntil: '2027-12-31', assignments: r.assignments,
  }) satisfies DatedResearcher }));
  return [
    { key: 'SEED', version: 1, data: { fictional: true, schemaVersion: 1, capacity: 'hours' } satisfies SeedInfo },
    { key: 'CONFIG', version: 1, data: config },
    { key: 'ACCOUNT#sample-health', version: 1, data: { id: 'sample-health', name: 'Fictional Health Account' } },
    { key: 'ACCOUNT#sample-retail', version: 1, data: { id: 'sample-retail', name: 'Fictional Retail Account' } },
    ...managerRows(), ...researchers,
  ];
}

/** Seed from the Research workbook: researchers in account slots, grid accounts, and the import report shown to managers in Slack. */
export function workbookSeed(parsed: ParsedWorkbook, settings: WorkbookSettings, config: ScoringConfig,
  options: { source: string; fictional: boolean; asOf: string; aliases?: Record<string, string> }): Row[] {
  const { researchers, excluded, warnings } = workbookResearchers(parsed, settings, options.asOf, options.aliases);
  return [
    { key: 'SEED', version: 1, data: { fictional: options.fictional, schemaVersion: 2, source: options.source, capacity: 'account-slots', maxAccounts: settings.maxAccounts } satisfies SeedInfo },
    { key: 'CONFIG', version: 1, data: config },
    { key: 'IMPORT', version: 1, data: { source: options.source, importedAt: options.asOf, warnings,
      excluded: excluded.map(({ researcherId, reasons }) => ({ researcherId, reasons })) } satisfies ImportReport },
    ...[...parsed.accounts].map(([id, name]) => ({ key: `ACCOUNT#${id}`, version: 1, data: { id, name } })),
    ...managerRows(), ...researchers.map(r => ({ key: `RESEARCHER#${r.id}`, version: 1, data: r })),
  ];
}

/** Refuse initialized namespaces. Large seeds commit in 100-item transactions with SEED last, so a partial seed is never marked complete. */
export async function seedRows(store: PilotStore, rows: Row[]) {
  if ((await store.list('')).length) throw new Error('Refusing to overwrite existing pilot state. Use a new isolated namespace for tests.');
  const ordered = [...rows.filter(r => r.key !== 'SEED'), ...rows.filter(r => r.key === 'SEED')];
  for (let i = 0; i < ordered.length; i += 100) {
    const chunk = ordered.slice(i, i + 100);
    await store.commit(chunk, chunk.map(r => ({ key: r.key, version: null })));
  }
}
export const seedPilot = (store: PilotStore, config: ScoringConfig) => seedRows(store, pilotSeed(config));
