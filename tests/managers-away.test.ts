import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { Manager, ManagerChange } from '../src/pilot/models.js';
import { resourcingText } from '../src/pilot/reports.js';
import { PILOT_MANAGERS } from '../src/slack/pilot.js';
import { parseWorkbook } from '../src/workbook/parse.js';
import { profilesFromWorkbook, profilesSchema, profileSheets } from '../src/workbook/profiles.js';
import { recommendFromWorkbook, workbookResearchers } from '../src/workbook/researchers.js';
import { sampleWorkbook } from '../src/workbook/sample.js';
import { harness, option, settings, slots, who, workbookConfig } from './pilot-harness.js';

const withAway = (away: string[], name = 'Ed Epsilon') => profilesSchema.parse({ source: 'test', researchers: [{ name, away }] });
const strategists = (start: string, end: string, away: string[]) => recommendFromWorkbook(parseWorkbook(sampleWorkbook()),
  { accountName: 'Fictional Screening Co', role: 'strategist', openings: 1, startDate: start, endDate: end }, workbookConfig, settings, {}, withAway(away));

test('an away term blocks only requests that overlap it, using the configured UF calendar', () => {
  const spring = strategists('2027-02-01', '2027-02-28', ['Spring 2027']);
  assert.deepEqual(spring.run.excluded.find(e => e.researcherId === 'ed-epsilon')!.reasons, ['Away 2027-01-11 to 2027-04-30']);
  const summer = strategists('2027-05-12', '2027-05-25', ['Spring 2027']);
  assert.ok(summer.run.retained.some(r => r.researcherId === 'ed-epsilon'));
  const range = strategists('2027-02-01', '2027-02-28', ['2027-02-10 to 2027-02-12']);
  assert.match(range.run.excluded.find(e => e.researcherId === 'ed-epsilon')!.reasons[0]!, /Away 2027-02-10 to 2027-02-12/);
});

test('unreadable away entries hold the researcher back; terms outside the calendar are approximate and warned', () => {
  const unreadable = workbookResearchers(parseWorkbook(sampleWorkbook()), settings, '2026-11-02', {}, withAway(['next spring']));
  assert.match(unreadable.excluded.find(e => e.researcherId === 'ed-epsilon')!.reasons[0]!, /away entry unreadable: "next spring"/);
  const later = workbookResearchers(parseWorkbook(sampleWorkbook()), settings, '2026-11-02', {}, withAway(['Fall 2030']));
  assert.ok(later.warnings.includes('Ed Epsilon: away "Fall 2030" is not in the configured term calendar; using 2030-08-01 to 2030-12-20'));
});

test('assignments during an away term are flagged in import warnings and the HQ view', () => {
  const { researchers, warnings } = workbookResearchers(parseWorkbook(sampleWorkbook()), settings, '2026-11-02', {}, withAway(['Fall 2026']));
  assert.ok(warnings.includes('Ed Epsilon: on Northwind Bakery until 2026-12-11 but away 2026-08-20 to 2026-12-11'));
  const hq = resourcingText({ researchers, accounts: [{ id: 'northwind-bakery', name: 'Northwind Bakery' }] }, '2026-11-02', slots, 'TEST');
  assert.match(hq, /Assigned while away: Ed Epsilon on Northwind Bakery \(away 2026-08-20 to 2026-12-11\)/);
});

test('the Profiles sheet carries away terms', () => {
  const profiles = profilesSchema.parse({ source: 's', researchers: [{ name: 'Ed Epsilon', away: ['Spring 2027', '2027-06-01 to 2027-06-05'] }] });
  assert.deepEqual(profilesFromWorkbook(profileSheets(new ExcelJS.Workbook(), profiles), 's').profiles!.researchers[0]!.away, ['Spring 2027', '2027-06-01 to 2027-06-05']);
});

const SHEA = 'U080ZEXR998';
const pick = (user: string, action: 'add' | 'remove', name = '') => ({ user: { value: { type: 'users_select', selected_user: user } }, action: { value: option(action) }, name: { value: { type: 'plain_text_input', value: name } } });

test('only operations leads open the managers screen, and they need not be staffing managers', async () => {
  const h = await harness({}, undefined, { admins: [SHEA] });
  await h.command('managers');
  assert.match(JSON.stringify(h.views.at(-1).blocks), /Only the configured operations leads/);
  await h.command('managers', SHEA);
  const screen = h.views.at(-1);
  assert.equal(screen.callback_id, PILOT_MANAGERS);
  assert.match(screen.blocks[1].text.text, /Current managers \(3\)/);
  await h.command('', SHEA);
  assert.match(JSON.stringify(h.views.at(-1).blocks), /Only configured pilot managers/);
});

test('adding and removing managers is recorded, announced, and takes effect', async () => {
  const h = await harness({ notify: ['U0OPS1'] }, undefined, { admins: [SHEA] });
  await h.command('managers', SHEA);
  await h.submit(PILOT_MANAGERS, h.views.at(-1), pick('U0NEWMGR1', 'add', 'Nova'), SHEA);
  assert.match(JSON.stringify(h.views.at(-1).blocks), /Nova added as a pilot manager/);
  assert.deepEqual((await h.store.get<Manager>('MANAGER#U0NEWMGR1'))!.data, { name: 'Nova', enabled: true });
  assert.equal(h.posts.at(-1).text, 'FICTIONAL DATA PILOT: <@U0NEWMGR1> added as a pilot manager by <@U080ZEXR998>.');
  await h.command('', 'U0NEWMGR1');
  assert.equal(h.views.at(-1).title.text, 'Pilot staffing request');

  await h.submit(PILOT_MANAGERS, h.views.at(-1), pick('U0NEWMGR1', 'remove'), SHEA);
  assert.equal((await h.store.get<Manager>('MANAGER#U0NEWMGR1'))!.data.enabled, false);
  await h.command('', 'U0NEWMGR1');
  assert.match(JSON.stringify(h.views.at(-1).blocks), /Only configured pilot managers/);
  const records = (await h.store.list<ManagerChange>('MANAGERCHANGE#')).map(r => r.data);
  assert.deepEqual(records.map(r => [r.action, r.userId, r.actor.userId]).sort(), [['add', 'U0NEWMGR1', SHEA], ['remove', 'U0NEWMGR1', SHEA]]);
});

test('the last manager cannot be removed, even by concurrent removals', async () => {
  const h = await harness({}, undefined, { admins: [SHEA] }), lead = { ...who, userId: SHEA };
  await h.service.setManager(lead, 'U06QLUN31L0', 'remove');
  const results = await Promise.allSettled([h.service.setManager(lead, 'U09SWCWCDL3', 'remove'), h.service.setManager(lead, 'U0AS0D7GQMB', 'remove')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await h.service.managers(lead)).filter(m => m.enabled).length, 1);
  const last = (await h.service.managers(lead)).find(m => m.enabled)!;
  await assert.rejects(h.service.setManager(lead, last.userId, 'remove'), /Keep at least one pilot manager/);
  await assert.rejects(h.service.setManager(lead, last.userId, 'add'), /already a pilot manager/);
});
