import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatedResearcher, ImportReport, RequestState, SeedInfo } from '../src/pilot/models.js';
import { computeMetrics, resourcingText } from '../src/pilot/reports.js';
import { seedRows, workbookSeed } from '../src/pilot/seed.js';
import { MemoryPilotStore } from '../src/pilot/store.js';
import { PILOT_CHANGE, PILOT_CONFIRM, PILOT_REQUEST, PILOT_SELECT } from '../src/slack/pilot.js';
import { parseWorkbook } from '../src/workbook/parse.js';
import { sampleWorkbook } from '../src/workbook/sample.js';
import { harness, settings, who, workbookConfig, values } from './pilot-harness.js';

type Harness = Awaited<ReturnType<typeof harness>>;
const decision = (ids: string[]) => ({ decision: { value: { selected_option: { value: 'approve' } } }, candidates: { value: { selected_options: ids.map(value => ({ value })) } } });
async function approveBatch(h: Harness, ids = ['ivy-iota', 'ed-epsilon']) {
  await h.command('');
  await h.submit(PILOT_REQUEST, h.views.at(-1), values);
  await h.submit(PILOT_SELECT, h.views.at(-1), decision(ids));
  const confirm = h.views.at(-1);
  await h.submit(PILOT_CONFIRM, confirm, {});
  return confirm;
}
const researcher = async (h: Harness, id: string) => (await h.store.get<DatedResearcher>(`RESEARCHER#${id}`))!.data;
const onlyRequest = async (h: Harness) => (await h.store.list<RequestState>('REQUEST#'))[0]!;

test('workbook seed records slots, grid accounts, managers and the import report', async () => {
  const rows = workbookSeed(parseWorkbook(sampleWorkbook()), settings, workbookConfig, { source: 'fictional sample workbook', fictional: true, asOf: '2026-11-02' });
  const byKey = new Map(rows.map(r => [r.key, r.data]));
  assert.deepEqual(byKey.get('SEED'), { fictional: true, schemaVersion: 2, source: 'fictional sample workbook', capacity: 'account-slots', maxAccounts: 3 } satisfies SeedInfo);
  const report = byKey.get('IMPORT') as ImportReport;
  assert.ok(report.excluded.some(e => e.researcherId === 'cy-gamma')); assert.ok(report.warnings.some(w => w.includes('Hal Tehta')));
  assert.ok(byKey.has('ACCOUNT#fabrikam-podcast')); assert.ok(byKey.has('MANAGER#U0AS0D7GQMB'));
  assert.ok(!byKey.has('RESEARCHER#pat-sample'));
  assert.equal((byKey.get('RESEARCHER#lee-lead') as DatedResearcher).assignments.length, 3);
});
test('large seeds commit in transaction-sized chunks with the SEED marker last, and never overwrite', async () => {
  const store = new MemoryPilotStore(), commits: string[][] = [], commit = store.commit.bind(store);
  store.commit = async (puts, checks) => { commits.push(puts.map(p => p.key)); return commit(puts, checks); };
  const rows = [{ key: 'SEED', version: 1, data: {} }, ...Array.from({ length: 230 }, (_, i) => ({ key: `ACCOUNT#a${i}`, version: 1, data: { id: `a${i}`, name: `A${i}` } }))];
  await seedRows(store, rows);
  assert.deepEqual(commits.map(c => c.length), [100, 100, 31]); assert.equal(commits.at(-1)!.at(-1), 'SEED');
  await assert.rejects(seedRows(store, rows), /Refusing/);
});
test('approval notifies operations once and posts then edits the Resourcing HQ message', async () => {
  const h = await harness({ notify: ['U0TESTOPS1', 'C0TESTOPS2'], hqChannel: 'C0TESTHQ' });
  const confirm = await approveBatch(h);
  assert.match(JSON.stringify(h.views.at(-1)), /Test assignments saved in DynamoDB/);
  const notices = h.posts.filter(p => p.channel !== 'C0TESTHQ');
  assert.deepEqual(notices.map(p => p.channel), ['U0TESTOPS1', 'C0TESTOPS2']);
  assert.match(notices[0].text, /FICTIONAL DATA PILOT: Fictional Screening Co — Ivy Iota, Ed Epsilon approved as strategist for 2026-11-16 to 2026-12-11 by <@U0AS0D7GQMB>/);
  const hq = h.posts.find(p => p.channel === 'C0TESTHQ');
  assert.match(hq.text, /Fictional Screening Co: .*Ivy Iota \(from 2026-11-16 to 2026-12-11\)/);
  assert.deepEqual((await h.service.hqLocation())?.data, { channel: 'C0TESTHQ', ts: 'ts-3' });
  await h.submit(PILOT_CONFIRM, confirm, {});
  assert.equal(h.posts.length, 3, 'a repeated confirmation sends no new notices or HQ posts');
  assert.equal(h.edits.length, 1); assert.equal(h.edits[0].ts, 'ts-3');
});
test('notice failures are logged and never turn a saved approval into a failure', async () => {
  const h = await harness({ notify: ['U0TESTOPS1'] });
  h.client.chat.postMessage = async () => { throw Object.assign(new Error('fail'), { data: { error: 'channel_not_found' } }); };
  await approveBatch(h);
  assert.match(JSON.stringify(h.views.at(-1)), /saved in DynamoDB/);
  assert.ok(h.logs.some(l => /Pilot notice to U0TESTOPS1 failed: channel_not_found/.test(l)));
});
test('cancelling an approved assignment frees the slot, reopens the opening, and is recorded once', async () => {
  const h = await harness();
  await approveBatch(h);
  assert.equal((await onlyRequest(h)).data.status, 'filled');
  const done = await h.service.changeAssignment(who, 'ivy-iota', 0, { action: 'cancel' });
  assert.equal(done.reopenedRequest, true);
  const request = await onlyRequest(h);
  assert.equal(request.data.status, 'partial'); assert.deepEqual(request.data.filledResearcherIds, ['ed-epsilon']);
  assert.equal((await researcher(h, 'ivy-iota')).assignments[0]!.status, 'cancelled');
  assert.equal((await h.store.list('CHANGE#')).length, 1);
  await assert.rejects(h.service.changeAssignment(who, 'ivy-iota', 0, { action: 'cancel' }), /active assignment/);
  await assert.rejects(h.service.changeAssignment({ ...who, userId: 'UUNKNOWN' }, 'ed-epsilon', 1, { action: 'cancel' }), /Only configured/);
});
test('rescheduling rechecks availability and capacity without the moved assignment', async () => {
  const h = await harness();
  await approveBatch(h);
  await assert.rejects(h.service.changeAssignment(who, 'ed-epsilon', 1, { action: 'reschedule', startDate: '2027-01-11', endDate: '2027-06-30' }), /do not fit: Availability/);
  await assert.rejects(h.service.changeAssignment(who, 'ed-epsilon', 1, { action: 'reschedule', startDate: '2027-02-01', endDate: '2027-01-01' }), /valid new date range/);
  const moved = await h.service.changeAssignment(who, 'ed-epsilon', 1, { action: 'reschedule', startDate: '2027-01-11', endDate: '2027-04-30' });
  assert.equal(moved.reopenedRequest, false);
  assert.deepEqual((await researcher(h, 'ed-epsilon')).assignments[1]!, { ...(await researcher(h, 'ed-epsilon')).assignments[1]!, startDate: '2027-01-11', endDate: '2027-04-30', status: 'active' });
  assert.equal((await onlyRequest(h)).data.status, 'filled');
  // Lee already holds three accounts in the fall; one of them can still move within the term because it no longer counts against itself.
  await h.service.changeAssignment(who, 'lee-lead', 0, { action: 'reschedule', startDate: '2026-09-01', endDate: '2026-10-30' });
});
test('assignment change modal validates dates, saves, notifies and refreshes HQ', async () => {
  const h = await harness({ notify: ['U0TESTOPS1'], hqChannel: 'C0TESTHQ' });
  await approveBatch(h);
  await h.command('assignments');
  const form = h.views.at(-1); assert.equal(form.callback_id, PILOT_CHANGE);
  assert.match(JSON.stringify(form), /Ivy Iota — Fictional Screening Co \(2026-11-16–2026-12-11\)/);
  const pick = (value: string, change: string) => ({ assignment: { value: { selected_option: { value } } }, change: { value: { selected_option: { value: change } } } });
  const acks: any[] = [];
  await h.handlers.get(PILOT_CHANGE)!({ body: { team: { id: who.teamId }, user: { id: who.userId } }, view: { ...form, id: 'view-1', state: { values: pick('ivy-iota#0', 'reschedule') } }, ack: async (a: any) => acks.push(a), client: h.client });
  assert.equal(acks[0].response_action, 'errors'); assert.ok(acks[0].errors.newStart && acks[0].errors.newEnd);
  const before = h.posts.length;
  await h.submit(PILOT_CHANGE, form, pick('ivy-iota#0', 'cancel'));
  assert.match(JSON.stringify(h.views.at(-1)), /Ivy Iota on Fictional Screening Co: cancelled .*open again/);
  assert.match(h.posts[before].text, /Ivy Iota on Fictional Screening Co cancelled/);
  assert.ok(h.edits.length >= 1, 'HQ message edited in place');
});
test('hq, issues, metrics and help views render for managers', async () => {
  const h = await harness();
  await h.command('hq'); const hq = JSON.stringify(h.views.at(-1));
  assert.match(hq, /Lee Lead 3\/3 accounts/); assert.match(hq, /No current accounts: Ivy Iota, Jo Kappa/);
  assert.match(hq, /Internal Comms: .*Flo Zeta/, 'grid load is shown even after a recorded graduation date');
  await h.command('issues'); const issues = JSON.stringify(h.views.at(-1));
  assert.match(issues, /cy-gamma: Hire term missing/); assert.match(issues, /Hal Tehta/);
  await approveBatch(h);
  await h.command('metrics'); assert.match(JSON.stringify(h.views.at(-1)), /Requests: 1 total, 0 open, 1 filled/);
  await h.command('help'); assert.match(JSON.stringify(h.views.at(-1)), /resource-pilot assignments/);
});
test('metrics measure decision time, acceptance of shown candidates, capacity, and changes', async () => {
  let now = new Date('2026-11-02T15:00:00Z');
  const h = await harness({}, () => now);
  await h.command(''); await h.submit(PILOT_REQUEST, h.views.at(-1), values);
  await h.submit(PILOT_SELECT, h.views.at(-1), decision(['ivy-iota', 'ed-epsilon']));
  now = new Date('2026-11-02T17:30:00Z');
  await h.submit(PILOT_CONFIRM, h.views.at(-1), {});
  await h.service.changeAssignment(who, 'ivy-iota', 0, { action: 'cancel' });
  const lee = (await h.store.get<DatedResearcher>('RESEARCHER#lee-lead'))!;
  const extra = { id: 'manual-overbook', accountId: 'fabrikam-podcast', startDate: '2026-10-01', endDate: '2026-10-31', hoursPerWeek: 1, status: 'active' as const };
  await h.store.commit([{ ...lee, version: lee.version + 1, data: { ...lee.data, assignments: [...lee.data.assignments, extra] } }], [{ key: lee.key, version: lee.version }]);
  const m = computeMetrics(await h.store.list(''));
  assert.equal(m.decisionHours.median, 2.5);
  assert.deepEqual(m.acceptance, { selections: 2, shown: 2, approvalsMeasured: 1, topPicks: 1 });
  assert.deepEqual(m.requests, { total: 1, open: 1, filled: 0, declined: 0 });
  assert.equal(m.capacity.overloaded.length, 1); assert.equal(m.capacity.overloaded[0]!.name, 'Lee Lead');
  assert.deepEqual(m.capacity.overloaded[0]!.periods[0], { from: '2026-10-01', until: '2026-10-31', load: 4, accounts: 4 });
  assert.deepEqual(m.changes, { cancelled: 1, rescheduled: 0 });
});
test('resourcing text labels unlisted grid load and uses hours wording for the original pilot', () => {
  const r = (assignments: DatedResearcher['assignments']) => ({ id: 'a', name: 'A', active: true, weeklyCapacityHours: 10, maxAccounts: 3, skills: [], experienceYears: 1,
    interests: [], industryExperienceIds: [], availableFrom: '2026-01-01', availableUntil: '2027-01-01', assignments });
  const text = resourcingText({ researchers: [r([{ id: 'x', accountId: 'unlisted-1', startDate: '2026-11-01', endDate: '2026-11-30', hoursPerWeek: 4, status: 'active' }])], accounts: [] }, '2026-11-02', { kind: 'hours' }, 'TEST');
  assert.match(text, /Unlisted account: A \(to 2026-11-30\)/); assert.match(text, /A 4\/10 h\/week/);
});
