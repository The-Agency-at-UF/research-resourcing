import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_CONFIRM, PILOT_REQUEST, PILOT_SELECT, parsePilotForm } from '../src/slack/pilot.js';
import { harness, option, plain, values } from './pilot-harness.js';

test('role-based form builds one slot per opening and validates role, openings and dates', () => {
  const parsed = parsePilotForm(values as any);
  assert.ok(parsed.ok); if (parsed.ok) { assert.deepEqual(parsed.request.requiredSkills, ['strategist']); assert.equal(parsed.request.hoursPerResearcher, 1); assert.equal(parsed.request.minimumExperienceYears, 0); }
  const bad = structuredClone(values); bad.endDate.value.selected_date = '2026-11-01';
  const reversed = parsePilotForm(bad as any); assert.equal(reversed.ok, false); if (!reversed.ok) assert.ok(reversed.errors.endDate);
  const wrong = { ...structuredClone(values), role: { value: option('designer') }, openings: { value: plain('0') } };
  const invalid = parsePilotForm(wrong as any); assert.equal(invalid.ok, false); if (!invalid.ok) { assert.ok(invalid.errors.role); assert.ok(invalid.errors.openings); }
});
test('private Slack flow acknowledges before database work and persists an approved batch', async () => {
  const h = await harness(), getMany = h.store.getMany.bind(h.store);
  h.store.getMany = async keys => { assert.ok(h.events.includes('ack')); return getMany(keys); };
  await h.command('');
  assert.equal(h.events[0], 'ack'); assert.equal(h.views.at(-1).callback_id, PILOT_REQUEST);
  assert.match(JSON.stringify(h.views.at(-1)), /workbook import issue/);
  await h.submit(PILOT_REQUEST, h.views.at(-1), values);
  assert.equal(h.views.at(-1).callback_id, PILOT_SELECT);
  const select = h.views.at(-1);
  await h.submit(PILOT_SELECT, select, { decision: { value: { selected_option: { value: 'approve' } } }, candidates: { value: { selected_options: [{ value: 'ivy-iota' }, { value: 'ed-epsilon' }] } } });
  assert.equal(h.views.at(-1).callback_id, PILOT_CONFIRM);
  const confirm = h.views.at(-1);
  assert.match(JSON.stringify(confirm), /2026-11-16 to 2026-12-11/); assert.match(JSON.stringify(confirm), /account slots remain/);
  assert.match(JSON.stringify(select), /of 3 account slots free/); assert.ok(!JSON.stringify(select).includes('hours/week'));
  await h.submit(PILOT_CONFIRM, confirm, {});
  assert.match(JSON.stringify(h.views.at(-1)), /Test assignments saved in DynamoDB/);
  assert.equal((await h.store.list('APPROVAL#')).length, 1);
  await h.submit(PILOT_CONFIRM, confirm, {});
  assert.equal((await h.store.list('APPROVAL#')).length, 1);
});
test('unauthorized command and tampered confirmations disclose no staffing details', async () => {
  const h = await harness();
  for (const text of ['', 'hq', 'issues', 'metrics', 'assignments']) {
    await h.command(text, 'UUNKNOWN');
    assert.match(JSON.stringify(h.views.at(-1)), /Only configured/); assert.ok(!JSON.stringify(h.views.at(-1)).includes('Ivy Iota'));
  }
  await h.submit(PILOT_CONFIRM, { private_metadata: 'not-json' }, {});
  assert.match(JSON.stringify(h.views.at(-1)), /Invalid form/); assert.equal((await h.store.list('APPROVAL#')).length, 0);
});
test('decline requires confirmation and preserves the private pilot notice', async () => {
  const h = await harness();
  await h.command('');
  await h.submit(PILOT_REQUEST, h.views.at(-1), values);
  await h.submit(PILOT_SELECT, h.views.at(-1), { decision: { value: { selected_option: { value: 'decline' } } } });
  const confirm = h.views.at(-1); assert.equal((await h.store.list('DECLINE#')).length, 0);
  await h.submit(PILOT_CONFIRM, confirm, {}); assert.equal((await h.store.list('DECLINE#')).length, 1);
  assert.ok(h.views.every(view => JSON.stringify(view).includes('FICTIONAL DATA PILOT')));
});
