import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Account, DatedResearcher, ImportReport, RequestState } from '../src/resourcing/models.js';
import { workbookSeed } from '../src/resourcing/seed.js';
import { RESOURCING_REQUEST } from '../src/slack/resourcing.js';
import { parseWorkbook } from '../src/workbook/parse.js';
import { profilesSchema } from '../src/workbook/profiles.js';
import { recommendFromWorkbook, workbookResearchers } from '../src/workbook/researchers.js';
import { sampleProfiles, sampleWorkbook } from '../src/workbook/sample.js';
import { harness, settings, workbookConfig, values } from './harness.js';

const profiles = profilesSchema.parse(sampleProfiles());
const request = JSON.parse(readFileSync(new URL('../fixtures/workbook-request.json', import.meta.url), 'utf8'));
const rank = (tools: string[] = [], withProfiles = true) =>
  recommendFromWorkbook(parseWorkbook(sampleWorkbook()), { ...request, tools }, workbookConfig, settings, {}, withProfiles ? profiles : undefined);

test('profile tags are normalized and unknown fields are refused', () => {
  assert.deepEqual(profiles.accounts['Northwind Bakery'], ['food-and-beverage']);
  assert.deepEqual(profiles.researchers[0]!.industryExperience, ['entertainment']);
  assert.throws(() => profilesSchema.parse({ source: 's', researchers: [{ name: 'A', notes: 'free text' }] }));
});

test('profiles add interests, industry, tools, and a personal cap without changing load', () => {
  const { researchers, warnings, tools } = workbookResearchers(parseWorkbook(sampleWorkbook()), settings, '2026-11-16', {}, profiles);
  const byId = new Map(researchers.map(r => [r.id, r]));
  assert.deepEqual(byId.get('ed-epsilon')!.skills, ['strategist', 'quid']);
  assert.deepEqual(byId.get('ed-epsilon')!.profile, { hoursPerWeek: 4 });
  assert.equal(byId.get('ivy-iota')!.weeklyCapacityHours, 1);
  // A cap below current load holds at the load: no overbooking is reported and nothing new is added.
  assert.equal(byId.get('ana-alpha')!.weeklyCapacityHours, 2);
  assert.equal(byId.get('lee-lead')!.profile, undefined);
  assert.deepEqual(tools, ['excel', 'quid', 'semrush']);
  assert.ok(warnings.some(w => w.includes('Ana Alpha: asked for at most 1 account')));
  assert.ok(warnings.some(w => w.includes('Zed Nobody matches no roster member')));
  assert.ok(warnings.some(w => w.startsWith('No 1:1 profile for') && w.includes('Bo Beta')));
  assert.equal(byId.get('jo-kappa')!.availableUntil, '2026-12-11');
  assert.ok(warnings.includes('Jo Kappa: available until 2026-12-11 per their 1:1, before graduation'));
});

test('account industries and helpful tools change ranking and explanations, never eligibility', () => {
  const plain = rank([], false), profiled = rank(), tooled = rank(['quid']);
  assert.ok(!plain.run.retained.some(r => /1:1|interest/.test(r.explanation)));
  const ed = profiled.run.retained.find(r => r.researcherId === 'ed-epsilon')!;
  assert.match(ed.explanation, /interested in entertainment; experience in entertainment; reported about 4 hours\/week/);
  const ivy = profiled.run.retained.find(r => r.researcherId === 'ivy-iota')!;
  assert.match(ivy.explanation, /^1 of 1 account slots free/); assert.match(ivy.explanation, /asked for at most 1 account/);
  assert.deepEqual(tooled.run.retained.map(r => r.researcherId), ['ed-epsilon', 'ivy-iota']);
  assert.match(tooled.run.retained[1]!.explanation, /no listed use of quid/);
  assert.equal(tooled.run.eligibleCount, profiled.run.eligibleCount);
  assert.ok(profiled.run.excluded.find(e => e.researcherId === 'ana-alpha')!.reasons.includes('Asked for at most 1 account at their 1:1'));
});

test('a request for an untagged account says interests are not scored', () => {
  const result = recommendFromWorkbook(parseWorkbook(sampleWorkbook()), { ...request, accountName: 'Internal Comms' }, workbookConfig, settings, {}, profiles);
  assert.ok(result.warnings.some(w => w.includes('"Internal Comms" has no industry tags')));
  assert.equal(result.run.request.industryId, undefined);
});

test('the seed stores account industries and tools; the Slack form offers tools and scores the account industry', async () => {
  const rows = workbookSeed(parseWorkbook(sampleWorkbook()), settings, workbookConfig, { source: 'sample', fictional: true, asOf: '2026-11-02', profiles });
  const byKey = new Map(rows.map(r => [r.key, r.data]));
  assert.deepEqual((byKey.get('ACCOUNT#fictional-screening-co') as Account).industries, ['entertainment', 'media']);
  assert.equal((byKey.get('ACCOUNT#internal-comms') as Account).industries, undefined);
  assert.equal((byKey.get('IMPORT') as ImportReport).source, 'sample + fictional sample 1:1s');

  const h = await harness({}, undefined, { profiles });
  await h.command('');
  const form = h.views.at(-1);
  const toolBlock = form.blocks.find((b: any) => b.block_id === 'tools');
  assert.deepEqual(toolBlock.element.options.map((o: any) => o.value), ['excel', 'quid', 'semrush']);
  await h.submit(RESOURCING_REQUEST, form, { ...values, tools: { value: { type: 'multi_static_select', selected_options: [{ value: 'quid' }] } } });
  const saved = (await h.store.list<RequestState>('REQUEST#'))[0]!.data.request;
  assert.deepEqual([saved.preferredSkills, saved.careerInterests, saved.industryId], [['quid'], ['entertainment', 'media'], 'entertainment']);
  const shortlist = JSON.stringify(h.views.at(-1).blocks);
  assert.match(shortlist, /Industry: entertainment, media/); assert.match(shortlist, /1\. Ed Epsilon/);
  assert.equal((await h.store.get<DatedResearcher>('RESEARCHER#ivy-iota'))!.data.profile?.accountCap, 1);

  const without = await harness();
  await without.command('');
  assert.ok(!without.views.at(-1).blocks.some((b: any) => b.block_id === 'tools'));
});
