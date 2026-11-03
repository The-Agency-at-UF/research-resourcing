import type { ScoringConfig } from '../recommendations/models.js';
import { datedResearcherSchema, type DatedResearcher } from './models.js';
import type { PilotStore, Row } from './store.js';

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
    { key: 'SEED', version: 1, data: { fictional: true, schemaVersion: 1 } },
    { key: 'CONFIG', version: 1, data: config },
    { key: 'ACCOUNT#sample-health', version: 1, data: { id: 'sample-health', name: 'Fictional Health Account' } },
    { key: 'ACCOUNT#sample-retail', version: 1, data: { id: 'sample-retail', name: 'Fictional Retail Account' } },
    ...[{ id: 'U06QLUN31L0', name: 'Patricia' }, { id: 'U09SWCWCDL3', name: 'Camila' }, { id: 'U0AS0D7GQMB', name: 'Roger' }].map(m => ({
      key: `MANAGER#${m.id}`, version: 1, data: { name: m.name, enabled: true },
    })), ...researchers,
  ];
}
export async function seedPilot(store: PilotStore, config: ScoringConfig) {
  if ((await store.list('')).length) throw new Error('Refusing to overwrite existing pilot state. Use a new isolated namespace for tests.');
  const rows = pilotSeed(config);
  await store.commit(rows, rows.map(r => ({ key: r.key, version: null })));
}
