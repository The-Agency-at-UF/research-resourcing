import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { configSchema } from '../src/recommendations/models.js';
import { parseWorkbook } from '../src/workbook/parse.js';
import { recommendFromWorkbook, workbookMessage, workbookResearchers, workbookSettingsSchema } from '../src/workbook/researchers.js';
import { sampleWorkbook } from '../src/workbook/sample.js';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const config = configSchema.parse(read('config/scoring-workbook.json'));
const settings = workbookSettingsSchema.parse(read('config/workbook.json'));
const request = read('fixtures/workbook-request.json');
const reasons = (run: { excluded: { researcherId: string; reasons: string[] }[] }, id: string) => run.excluded.find(e => e.researcherId === id)?.reasons.join('; ') ?? '';

test('workbook config keeps account load out of the score because slots already measure bandwidth', () => {
  assert.equal(config.weights.accountLoad, 0);
  assert.ok(config.weights.bandwidth > Math.max(config.weights.skills, config.weights.experience));
});
test('parses roster and grid by layout, per-section headers, checkbox forms, and skips Exceptions', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sampleWorkbook().xlsx.writeBuffer());
  const parsed = parseWorkbook(workbook);
  assert.equal(parsed.roster.length, 12);
  assert.ok(!parsed.roster.some(r => r.name.includes('(DM)') || r.name === 'NEW HIRES' || r.name === 'Fall 2026'));
  const byName = Object.fromEntries(parsed.grid.map(g => [g.name, g]));
  assert.deepEqual(byName['Ana Alpha']?.accountIds, ['northwind-bakery', 'contoso-health']);
  assert.deepEqual(byName['Lee Lead']?.accountIds, ['northwind-bakery', 'contoso-health', 'internal-comms']);
  assert.deepEqual(byName['Kit Other']?.accountIds, ['fabrikam-podcast']);
  assert.deepEqual(byName['Flo Zeta']?.graduationDates, ['2026-05', '2027-05']);
  assert.equal(byName['Ivy Iota']?.section, 'new-hires');
  assert.equal(byName['Bo Beta']?.note, '* - Confirm this');
  assert.ok(!parsed.accounts.has('old-client-a'));
  assert.ok(parsed.issues.some(i => i.includes('Exceptions')));
});
test('missing layouts are reported instead of producing an empty roster silently', () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Blank').addRow(['nothing']);
  assert.equal(parseWorkbook(workbook).issues.length, 2);
});
test('merging flags data problems instead of guessing', () => {
  const { researchers, excluded, warnings, managers } = workbookResearchers(parseWorkbook(sampleWorkbook()), settings, '2026-11-16');
  const ids = researchers.map(r => r.id);
  assert.deepEqual(managers, ['Pat Sample']);
  assert.ok(!ids.includes('pat-sample'));
  assert.match(reasons({ excluded }, 'cy-gamma'), /Hire term missing/);
  assert.match(reasons({ excluded }, 'gus-eta'), /Not on the resourcing grid/);
  assert.match(reasons({ excluded }, 'hal-tehta'), /possible spelling difference from "Hal Theta"/);
  assert.match(reasons({ excluded }, 'kit-other'), /Not on the Research member roster/);
  assert.equal(researchers.find(r => r.id === 'flo-zeta')?.availableUntil, '2026-05-31');
  assert.equal(researchers.find(r => r.id === 'ed-epsilon')?.availableUntil, '2027-05-31');
  assert.equal(researchers.find(r => r.id === 'bo-beta')?.availableUntil, '2026-12-15');
  assert.ok(!warnings.some(w => w.startsWith('Bo Beta: graduation')), 'same month on roster and grid is not a conflict');
  assert.equal(researchers.find(r => r.id === 'bo-beta')?.assignments[0]?.accountId, 'unlisted-1');
  assert.ok(warnings.some(w => w.includes('"# of Accounts" is 1 but 0 boxes')));
  assert.equal(researchers.find(r => r.id === 'lee-lead')?.skills[0], 'strategist');
  assert.equal(researchers.find(r => r.id === 'ana-alpha')?.skills[0], 'analyst');
});
test('an alias merges a misspelled grid row with its roster entry', () => {
  const { researchers } = workbookResearchers(parseWorkbook(sampleWorkbook()), settings, '2026-11-16', { 'Hal Tehta': 'Hal Theta' });
  assert.deepEqual(researchers.find(r => r.id === 'hal-theta')?.assignments.map(a => a.accountId), ['contoso-health']);
});
test('role, account slots, same-account work, and graduation decide eligibility', () => {
  const { run } = recommendFromWorkbook(parseWorkbook(sampleWorkbook()), request, config, settings);
  assert.deepEqual(run.retained.map(r => r.researcherId), ['ivy-iota', 'ed-epsilon']);
  assert.match(reasons(run, 'lee-lead'), /0 account slots available/);
  assert.match(reasons(run, 'di-delta'), /Already assigned to this account/);
  assert.match(reasons(run, 'flo-zeta'), /does not cover the request/);
  assert.match(reasons(run, 'ana-alpha'), /Role is not strategist/);
  assert.match(run.retained[0]!.facts[0]!, /^3 of 3 account slots free/);
  assert.ok(!run.retained.some(r => r.explanation.includes('hours')));
});
test('assignments outside the assumed semester window do not consume slots', () => {
  const { run } = recommendFromWorkbook(parseWorkbook(sampleWorkbook()), { ...request, startDate: '2027-01-11', endDate: '2027-04-30' }, config, settings);
  assert.ok(run.retained.some(r => r.researcherId === 'lee-lead'));
  assert.ok(run.retained.some(r => r.researcherId === 'di-delta'), 'fall work on the same account no longer overlaps');
});
test('analyst requests and unknown accounts produce honest manager output', () => {
  const result = recommendFromWorkbook(parseWorkbook(sampleWorkbook()), { ...request, role: 'analyst', accountName: 'Brand New Client', openings: 3 }, config, settings);
  assert.deepEqual(result.run.retained.map(r => r.researcherId), ['jo-kappa', 'bo-beta', 'ana-alpha']);
  assert.ok(result.warnings.some(w => w.includes('not a column on the grid')));
  const message = workbookMessage(result);
  assert.match(message, /3 analyst opening\(s\)/);
  assert.match(message, /must approve/);
  assert.throws(() => recommendFromWorkbook(parseWorkbook(sampleWorkbook()), { ...request, role: 'designer' } as never, config, settings));
});
