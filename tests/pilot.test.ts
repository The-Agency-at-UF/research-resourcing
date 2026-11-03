import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema } from '../src/recommendations/models.js';
import { capacityForPeriod, recommendForPeriod } from '../src/pilot/capacity.js';
import { dateSchema, datedRequestSchema, datedResearcherSchema, PilotError, type DatedResearcher } from '../src/pilot/models.js';
import { MemoryPilotStore } from '../src/pilot/store.js';
import { PilotService } from '../src/pilot/service.js';
import { seedPilot } from '../src/pilot/seed.js';

export const config = configSchema.parse(JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8')));
export const actor = { teamId: 'TB67278DB', userId: 'U0AS0D7GQMB' };
export const input = { accountId: 'sample-health', accountName: 'Fictional Health Account', hoursPerResearcher: 4, openings: 2,
  requiredSkills: ['survey-design'], preferredSkills: [], minimumExperienceYears: 0, careerInterests: [], startDate: '2026-11-02', endDate: '2026-11-30' };
const researcher = (overrides: Partial<DatedResearcher> = {}) => datedResearcherSchema.parse({ id: 'a', name: 'Sample A', active: true,
  weeklyCapacityHours: 10, maxAccounts: 3, skills: ['survey-design'], experienceYears: 3, interests: [], industryExperienceIds: [],
  availableFrom: '2026-01-01', availableUntil: '2027-12-31', assignments: [], ...overrides });
const assignment = (startDate: string, endDate: string, hoursPerWeek = 6, accountId = 'other', id = 'existing') => ({
  id, accountId, startDate, endDate, hoursPerWeek, status: 'active' as const,
});
export async function setup() {
  const store = new MemoryPilotStore(); await seedPilot(store, config);
  return { store, service: new PilotService(store, actor.teamId) };
}
export async function prepare(service: PilotService, request = input, selected = ['sample-sam']) {
  const requestId = await service.createRequest(actor, request), run = await service.recommendations(actor, requestId);
  return { requestId, ...(await service.prepareApproval(actor, requestId, run.runId, selected)) };
}
test('calendar dates validate real leap dates, reversed ranges and format', () => {
  for (const value of ['2026-02-29', '2026-11-31', '2026-1-01', 'not-a-date', '0000-01-01']) assert.equal(dateSchema.safeParse(value).success, false);
  assert.equal(dateSchema.parse('2028-02-29'), '2028-02-29');
  assert.equal(datedRequestSchema.safeParse({ ...input, endDate: '2026-11-01' }).success, false);
});
test('dated researchers reject legacy totals, missing schedules and duplicate assignment IDs', () => {
  assert.equal(datedResearcherSchema.safeParse({ ...researcher(), committedHours: 0 }).success, false);
  assert.equal(datedResearcherSchema.safeParse({ ...researcher(), assignments: undefined }).success, false);
  assert.throws(() => researcher({ assignments: [assignment('2026-11-02', '2026-11-03'), assignment('2026-11-04', '2026-11-05')] }));
});
test('inclusive boundaries, adjacency and non-overlapping same-account work', () => {
  const r = researcher({ assignments: [assignment('2026-10-30', '2026-11-06', 10, input.accountId)] });
  assert.equal(recommendForPeriod([r], { ...input, startDate: '2026-11-07' }, config).eligibleCount, 1);
  assert.equal(recommendForPeriod([r], { ...input, startDate: '2026-11-06' }, config).eligibleCount, 0);
  const reason = recommendForPeriod([r], { ...input, startDate: '2026-11-06' }, config).excluded[0]!.reasons.join(' ');
  assert.match(reason, /2026-11-06 to 2026-11-06/); assert.match(reason, /Already assigned/);
});
test('partial overlapping commitments sum during their overlap and identify limiting dates', () => {
  const r = researcher({ assignments: [assignment('2026-11-02', '2026-11-10', 4, 'a', 'a'), assignment('2026-11-09', '2026-11-20', 4, 'b', 'b')] });
  const capacity = capacityForPeriod(r, input);
  assert.equal(capacity.minFreeHours, 2); assert.equal(capacity.maxAccounts, 2);
  assert.match(capacity.reasons.join(' '), /2026-11-09 to 2026-11-10/);
});
test('exact capacity qualifies, cancelled commitments do not consume hours', () => {
  const r = researcher({ assignments: [assignment('2026-11-02', '2026-11-30'), { ...assignment('2026-11-02', '2026-11-30', 10, 'b', 'cancelled'), status: 'cancelled' }] });
  const run = recommendForPeriod([r], input, config);
  assert.equal(run.retained[0]!.hoursAfterAssignment, 0); assert.equal(run.eligibleCount, 1);
});
test('decimal-hour subtraction noise does not exclude exactly enough capacity', () => {
  const r = researcher({ weeklyCapacityHours: 12, assignments: [assignment('2026-11-02', '2026-11-30', 4.4, 'a', 'a'), assignment('2026-11-02', '2026-11-30', 4.4, 'b', 'b')] });
  const run = recommendForPeriod([r], { ...input, hoursPerResearcher: 3.2 }, config);
  assert.equal(run.eligibleCount, 1); assert.equal(run.retained[0]!.hoursAfterAssignment, 0);
  assert.equal(recommendForPeriod([r], { ...input, hoursPerResearcher: 3.20001 }, config).eligibleCount, 0);
});
test('account load uses maximum simultaneous distinct accounts, not union across the period', () => {
  const r = researcher({ maxAccounts: 2, assignments: [assignment('2026-11-02', '2026-11-08', 1, 'a', 'a'), assignment('2026-11-09', '2026-11-30', 1, 'b', 'b')] });
  assert.equal(recommendForPeriod([r], input, config).eligibleCount, 1);
  assert.equal(recommendForPeriod([{ ...r, maxAccounts: 1 }], input, config).eligibleCount, 0);
});
test('availability window, skills and active status still restrict dated recommendations', () => {
  for (const overrides of [{ availableUntil: '2026-11-29' }, { availableFrom: '2026-11-03' }, { skills: [] }, { active: false }]) {
    assert.equal(recommendForPeriod([researcher(overrides)], input, config).eligibleCount, 0);
  }
});
test('dated ranking uses worst-period bandwidth and retains five/displays three', () => {
  const run = recommendForPeriod(Array.from({ length: 7 }, (_, i) => researcher({ id: `r${i}`, assignments: i ? [assignment('2026-11-09', '2026-11-10', i)] : [] })), { ...input, hoursPerResearcher: 1 }, config);
  assert.equal(run.retained.length, 5); assert.equal(run.displayed.length, 3); assert.equal(run.retained[0]!.researcherId, 'r0');
  assert.match(run.displayed[0]!.explanation, /throughout 2026-11-02 to 2026-11-30/);
});
test('invalid and duplicate dated records are excluded rather than inferred', () => {
  const r = researcher(); const run = recommendForPeriod([r, r, { id: 'missing' }], input, config);
  assert.equal(run.eligibleCount, 0); assert.ok(run.excluded.every(e => e.dataIssue));
});
test('pilot seed refuses to overwrite state', async () => {
  const { store } = await setup(); await assert.rejects(seedPilot(store, config), /Refusing/);
});
test('authorization denies wrong team, unknown users and disabled managers', async () => {
  const { store, service } = await setup();
  for (const who of [{ ...actor, teamId: 'TOTHER' }, { ...actor, userId: 'UUNKNOWN' }]) await assert.rejects(service.createRequest(who, input), (e: unknown) => e instanceof PilotError && e.code === 'unauthorized');
  const row = (await store.get(`MANAGER#${actor.userId}`))!;
  await store.commit([{ ...row, version: 2, data: { enabled: false, name: 'Roger' } }], [{ key: row.key, version: 1 }]);
  await assert.rejects(service.requests(actor), /Only configured/);
});
test('selection does not reserve capacity; partial batches and restart preserve assignments', async () => {
  const { store, service } = await setup(), prepared = await prepare(service);
  assert.equal((await store.get<DatedResearcher>('RESEARCHER#sample-sam'))!.data.assignments.length, 0);
  await service.approve(actor, prepared.approvalId);
  const restarted = new PilotService(store, actor.teamId), state = await restarted.request(actor, prepared.requestId);
  assert.equal(state.data.status, 'partial'); assert.deepEqual(state.data.filledResearcherIds, ['sample-sam']);
  const run = await restarted.recommendations(actor, prepared.requestId);
  assert.equal(run.run.request.openings, 1); assert.ok(!run.run.retained.some(r => r.researcherId === 'sample-sam'));
  const second = await restarted.prepareApproval(actor, prepared.requestId, run.runId, [run.run.retained[0]!.researcherId]);
  await restarted.approve(actor, second.approvalId);
  assert.equal((await restarted.request(actor, prepared.requestId)).data.status, 'filled');
  await assert.rejects(restarted.recommendations(actor, prepared.requestId), /filled/);
});
test('selection rejects duplicates, outsiders and excessive batches', async () => {
  const { service } = await setup(), requestId = await service.createRequest(actor, { ...input, openings: 1 }), run = await service.recommendations(actor, requestId);
  for (const selected of [[], ['sample-sam', 'sample-sam'], ['outsider'], ['sample-sam', 'sample-avery']]) await assert.rejects(service.prepareApproval(actor, requestId, run.runId, selected));
});
test('repeated and simultaneous confirmation returns one immutable approval', async () => {
  const { store, service } = await setup(), p = await prepare(service);
  const results = await Promise.all([service.approve(actor, p.approvalId), service.approve(actor, p.approvalId)]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(await service.approve(actor, p.approvalId), results[0]);
  assert.equal((await store.list('APPROVAL#')).length, 1);
  assert.equal((await store.get<DatedResearcher>('RESEARCHER#sample-sam'))!.data.assignments.length, 1);
});
test('concurrent conflicting batches are atomic and cannot overbook', async () => {
  const { store, service } = await setup();
  const a = await prepare(service, { ...input, hoursPerResearcher: 8 }, ['sample-sam', 'sample-jordan']);
  const b = await prepare(service, { ...input, hoursPerResearcher: 8 }, ['sample-sam', 'sample-riley']);
  const outcomes = await Promise.allSettled([service.approve(actor, a.approvalId), service.approve(actor, b.approvalId)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const losingId = outcomes[0]!.status === 'fulfilled' ? b.approvalId : a.approvalId;
  const total = (await store.list<DatedResearcher>('RESEARCHER#')).reduce((sum, row) => sum + row.data.assignments.filter(assignment => assignment.id.startsWith(`${losingId}_`)).length, 0);
  assert.equal(total, 0); assert.equal((await store.list('APPROVAL#')).length, 1);
});
test('changed availability, configuration and manager versions invalidate review', async () => {
  for (const key of ['RESEARCHER#sample-sam', 'CONFIG', `MANAGER#${actor.userId}`]) {
    const { store, service } = await setup(), p = await prepare(service), row = (await store.get(key))!;
    await store.commit([{ ...row, version: row.version + 1 }], [{ key, version: row.version }]);
    await assert.rejects(service.approve(actor, p.approvalId), /changed/);
    assert.equal((await store.list('APPROVAL#')).length, 0);
  }
});
test('permission revocation after review denies approval and another manager cannot reuse a review', async () => {
  const { store, service } = await setup(), p = await prepare(service);
  await assert.rejects(service.approve({ ...actor, userId: 'U06QLUN31L0' }, p.approvalId), /another manager/);
  const row = (await store.get(`MANAGER#${actor.userId}`))!;
  await store.commit([{ ...row, version: 2, data: { enabled: false } }], [{ key: row.key, version: 1 }]);
  await assert.rejects(service.approve(actor, p.approvalId), /Only configured/);
});
test('changed recommendation rows block preparation; unknown accounts and tampered IDs fail', async () => {
  const { store, service } = await setup(), requestId = await service.createRequest(actor, input), run = await service.recommendations(actor, requestId);
  const row = (await store.get('RESEARCHER#sample-sam'))!;
  await store.commit([{ ...row, version: 2 }], [{ key: row.key, version: 1 }]);
  await assert.rejects(service.prepareApproval(actor, requestId, run.runId, ['sample-sam']), /availability changed/);
  await assert.rejects(service.createRequest(actor, { ...input, accountId: 'unknown' }));
  await assert.rejects(service.request(actor, '../anything'), /Invalid/);
});
test('declining closes remaining openings, preserves approved work, and invalidates outstanding reviews', async () => {
  const { store, service } = await setup(), p = await prepare(service);
  await service.approve(actor, p.approvalId);
  const state = await service.request(actor, p.requestId);
  await service.decline(actor, p.requestId, state.version);
  assert.deepEqual((await service.request(actor, p.requestId)).data.filledResearcherIds, ['sample-sam']);
  assert.equal((await store.get<DatedResearcher>('RESEARCHER#sample-sam'))!.data.assignments.length, 1);
  await assert.rejects(service.recommendations(actor, p.requestId), /declined/);
  assert.equal((await store.list('DECLINE#')).length, 1);
});
test('lost successful commit response is recovered through approval ID', async () => {
  const { store, service } = await setup(), p = await prepare(service), commit = store.commit.bind(store);
  let lost = false;
  store.commit = async (puts, checks) => { await commit(puts, checks); if (puts.some(p => p.key.startsWith('APPROVAL#')) && !lost) { lost = true; throw new Error('Lost network response'); } };
  const approved = await service.approve(actor, p.approvalId);
  assert.equal(approved.id, p.approvalId); assert.equal((await store.list('APPROVAL#')).length, 1);
});
test('a change after the fresh read but before commit still blocks every write', async () => {
  const { store, service } = await setup(), p = await prepare(service, input, ['sample-sam', 'sample-jordan']);
  const originalCommit = store.commit.bind(store); let injected = false;
  store.commit = async (puts, checks) => {
    if (!injected && puts.some(row => row.key.startsWith('APPROVAL#'))) {
      injected = true;
      const researcher = (await store.get('RESEARCHER#sample-sam'))!;
      await originalCommit([{ ...researcher, version: researcher.version + 1 }], [{ key: researcher.key, version: researcher.version }]);
    }
    return originalCommit(puts, checks);
  };
  await assert.rejects(service.approve(actor, p.approvalId), /changed/);
  assert.equal((await store.list('APPROVAL#')).length, 0);
  assert.equal((await store.get<DatedResearcher>('RESEARCHER#sample-jordan'))!.data.assignments.length, 0);
});
