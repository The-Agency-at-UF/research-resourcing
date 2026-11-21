// Shared Slack pilot harness: a workbook-seeded memory store and recorded Slack calls.
import { readFileSync } from 'node:fs';
import type { App } from '@slack/bolt';
import { configSchema } from '../src/recommendations/models.js';
import { MemoryPilotStore } from '../src/pilot/store.js';
import { seedRows, workbookSeed } from '../src/pilot/seed.js';
import { parseWorkbook } from '../src/workbook/parse.js';
import { workbookSettingsSchema } from '../src/workbook/researchers.js';
import type { Profiles } from '../src/workbook/profiles.js';
import { sampleWorkbook } from '../src/workbook/sample.js';
import { PilotService } from '../src/pilot/service.js';
import { PILOT_CONFIRM, PILOT_REQUEST, PILOT_SELECT, parsePilotForm, registerPilotHandlers, type PilotOptions } from '../src/slack/pilot.js';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
export const workbookConfig = configSchema.parse(read('config/scoring-workbook.json'));
export const settings = workbookSettingsSchema.parse(read('config/workbook.json'));
export const slots = { kind: 'account-slots' as const, maxAccounts: 3 };
export const who = { teamId: 'TB67278DB', userId: 'U0AS0D7GQMB' };
export const plain = (value: string) => ({ type: 'plain_text_input', value });
export const option = (value: string) => ({ type: 'static_select', selected_option: { text: { type: 'plain_text', text: value }, value } });
export const values = { accountId: { value: option('fictional-screening-co') }, role: { value: option('strategist') }, openings: { value: plain('2') },
  startDate: { value: { type: 'datepicker', selected_date: '2026-11-16' } }, endDate: { value: { type: 'datepicker', selected_date: '2026-12-11' } }, minimumExperienceYears: { value: plain('') } };
export async function harness(options: PilotOptions = {}, clock = () => new Date('2026-11-02T15:00:00Z'), profiles?: Profiles) {
  const store = new MemoryPilotStore();
  await seedRows(store, workbookSeed(parseWorkbook(sampleWorkbook()), settings, workbookConfig, { source: 'fictional sample workbook', fictional: true, asOf: '2026-11-02', profiles }));
  const service = new PilotService(store, who.teamId, clock, slots), handlers = new Map<string, (input: any) => Promise<void>>();
  const app = { command: (id: string, fn: (input: any) => Promise<void>) => handlers.set(id, fn), view: (id: string, fn: (input: any) => Promise<void>) => handlers.set(id, fn) } as unknown as Pick<App, 'command' | 'view'>;
  const logs: string[] = [];
  registerPilotHandlers(app, service, { log: message => logs.push(message), ...options });
  const events: string[] = [], views: any[] = [], posts: any[] = [], edits: any[] = [];
  const client = { views: { open: async (args: any) => { events.push('open'); views.push(args.view); return { view: { id: 'view-1' } }; }, update: async (args: any) => { events.push('update'); views.push(args.view); } },
    chat: { postMessage: async (args: any) => { posts.push(args); return { ts: `ts-${posts.length}` }; }, update: async (args: any) => { edits.push(args); return {}; } } };
  const ack = async (args?: any) => { events.push('ack'); if (args?.view) views.push(args.view); };
  const submit = async (callback: string, view: any, stateValues: any, userId = who.userId) => handlers.get(callback)!({ body: { team: { id: who.teamId }, user: { id: userId } }, view: { ...view, id: 'view-1', state: { values: stateValues } }, ack, client });
  const command = async (text: string, userId = who.userId) => handlers.get('/resource-pilot')!({ command: { team_id: who.teamId, user_id: userId, text, trigger_id: 'trigger' }, ack, client });
  return { store, service, handlers, events, views, client, ack, submit, command, posts, edits, logs };
}
