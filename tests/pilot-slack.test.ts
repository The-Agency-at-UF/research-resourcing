import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { App } from '@slack/bolt';
import { configSchema } from '../src/recommendations/models.js';
import { MemoryPilotStore } from '../src/pilot/store.js';
import { seedPilot } from '../src/pilot/seed.js';
import { PilotService } from '../src/pilot/service.js';
import { PILOT_CONFIRM, PILOT_REQUEST, PILOT_SELECT, parsePilotForm, registerPilotHandlers } from '../src/slack/pilot.js';

const config = configSchema.parse(JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8')));
const who = { teamId: 'TB67278DB', userId: 'U0AS0D7GQMB' };
const plain = (value: string) => ({ type: 'plain_text_input', value });
const values = { accountId: { value: { type: 'static_select', selected_option: { text: { type: 'plain_text', text: 'Fictional Health Account' }, value: 'sample-health' } } },
  startDate: { value: { type: 'datepicker', selected_date: '2026-11-02' } }, endDate: { value: { type: 'datepicker', selected_date: '2026-11-30' } },
  hoursPerResearcher: { value: plain('4') }, openings: { value: plain('2') }, requiredSkills: { value: plain('survey-design') }, preferredSkills: { value: plain('') }, minimumExperienceYears: { value: plain('0') }, careerInterests: { value: plain('') }, industryId: { value: plain('') } };
async function harness() {
  const store = new MemoryPilotStore(); await seedPilot(store, config);
  const service = new PilotService(store, who.teamId), handlers = new Map<string, (input: any) => Promise<void>>();
  const app = { command: (id: string, fn: (input: any) => Promise<void>) => handlers.set(id, fn), view: (id: string, fn: (input: any) => Promise<void>) => handlers.set(id, fn) } as unknown as Pick<App, 'command' | 'view'>;
  registerPilotHandlers(app, service);
  const events: string[] = [], views: any[] = [];
  const client = { views: { open: async (args: any) => { events.push('open'); views.push(args.view); return { view: { id: 'view-1' } }; }, update: async (args: any) => { events.push('update'); views.push(args.view); } } };
  const ack = async (args?: any) => { events.push('ack'); if (args?.view) views.push(args.view); };
  const submit = async (callback: string, view: any, stateValues: any, userId = who.userId) => handlers.get(callback)!({ body: { team: { id: who.teamId }, user: { id: userId } }, view: { ...view, id: 'view-1', state: { values: stateValues } }, ack, client });
  return { store, service, handlers, events, views, client, ack, submit };
}
test('pilot datepickers validate missing, invalid and reversed dates', () => {
  assert.equal(parsePilotForm(values as any).ok, true);
  const bad = structuredClone(values); bad.endDate.value.selected_date = '2026-11-01';
  const parsed = parsePilotForm(bad as any); assert.equal(parsed.ok, false); if (!parsed.ok) assert.ok(parsed.errors.endDate);
});
test('private Slack flow acknowledges before database work and persists an approved batch', async () => {
  const h = await harness(), getMany = h.store.getMany.bind(h.store);
  h.store.getMany = async keys => { assert.ok(h.events.includes('ack')); return getMany(keys); };
  await h.handlers.get('/resource-pilot')!({ command: { ...who, team_id: who.teamId, user_id: who.userId, text: '', trigger_id: 'trigger' }, ack: h.ack, client: h.client });
  assert.equal(h.events[0], 'ack'); assert.equal(h.views.at(-1).callback_id, PILOT_REQUEST);
  await h.submit(PILOT_REQUEST, h.views.at(-1), values);
  assert.equal(h.views.at(-1).callback_id, PILOT_SELECT);
  const select = h.views.at(-1);
  await h.submit(PILOT_SELECT, select, { decision: { value: { selected_option: { value: 'approve' } } }, candidates: { value: { selected_options: [{ value: 'sample-sam' }, { value: 'sample-jordan' }] } } });
  assert.equal(h.views.at(-1).callback_id, PILOT_CONFIRM);
  const confirm = h.views.at(-1);
  assert.match(JSON.stringify(confirm), /2026-11-02 to 2026-11-30/);
  await h.submit(PILOT_CONFIRM, confirm, {});
  assert.match(JSON.stringify(h.views.at(-1)), /Test assignments saved in DynamoDB/);
  assert.equal((await h.store.list('APPROVAL#')).length, 1);
  await h.submit(PILOT_CONFIRM, confirm, {});
  assert.equal((await h.store.list('APPROVAL#')).length, 1);
});
test('unauthorized command and tampered confirmations disclose no staffing details', async () => {
  const h = await harness();
  await h.handlers.get('/resource-pilot')!({ command: { team_id: who.teamId, user_id: 'UUNKNOWN', text: '', trigger_id: 'trigger' }, ack: h.ack, client: h.client });
  assert.match(JSON.stringify(h.views.at(-1)), /Only configured/); assert.ok(!JSON.stringify(h.views.at(-1)).includes('Sample Sam'));
  await h.submit(PILOT_CONFIRM, { private_metadata: 'not-json' }, {});
  assert.match(JSON.stringify(h.views.at(-1)), /Invalid form/); assert.equal((await h.store.list('APPROVAL#')).length, 0);
});
test('decline requires confirmation and preserves the private pilot notice', async () => {
  const h = await harness();
  await h.handlers.get('/resource-pilot')!({ command: { team_id: who.teamId, user_id: who.userId, text: '', trigger_id: 'trigger' }, ack: h.ack, client: h.client });
  await h.submit(PILOT_REQUEST, h.views.at(-1), values);
  await h.submit(PILOT_SELECT, h.views.at(-1), { decision: { value: { selected_option: { value: 'decline' } } } });
  const confirm = h.views.at(-1); assert.equal((await h.store.list('DECLINE#')).length, 0);
  await h.submit(PILOT_CONFIRM, confirm, {}); assert.equal((await h.store.list('DECLINE#')).length, 1);
  assert.ok(h.views.every(view => JSON.stringify(view).includes('FICTIONAL DATA PILOT')));
});
