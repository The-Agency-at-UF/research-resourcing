import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommend } from '../src/recommendations/scoring.js';
import { managerMessage } from '../src/recommendations/presentation.js';
import { handler } from '../src/lambda.js';

const config = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8'));
const request = { accountId: 'account-a', accountName: 'Sample Account', hoursPerResearcher: 4, openings: 1,
  requiredSkills: ['survey-design'], preferredSkills: ['data-analysis'], minimumExperienceYears: 0, careerInterests: [] };
const researcher = (id = 'r-1', overrides = {}) => ({ id, name: `Sample ${id}`, active: true, weeklyCapacityHours: 10,
  committedHours: 2, maxAccounts: 3, currentAccountIds: [], skills: ['survey-design', 'data-analysis'],
  experienceYears: 2, interests: [], industryExperienceIds: [], ...overrides });

test('retains five unique candidates and displays three, even when seven qualify', () => {
  const run = recommend(Array.from({ length: 7 }, (_, i) => researcher(`r-${i}`)), request, config);
  assert.equal(run.eligibleCount, 7);
  assert.equal(run.retained.length, 5);
  assert.equal(run.displayed.length, 3);
  assert.equal(new Set(run.retained.map(r => r.researcherId)).size, 5);
  assert.equal(run.retained[0]?.researcherId, 'r-0');
  assert.ok(!managerMessage(run).includes('Sample r-3'));
});
test('manager display is configurable to two', () => {
  assert.equal(recommend([researcher('a'), researcher('b'), researcher('c')], request, { ...config, displayCount: 2 }).displayed.length, 2);
});
test('high skills and experience cannot override insufficient hours', () => {
  const run = recommend([researcher('a', { committedHours: 7, experienceYears: 10 })], request, config);
  assert.equal(run.status, 'no_eligible');
  assert.match(run.excluded[0]?.reasons.join(' ') ?? '', /Only 3 hours/);
});
test('exactly enough capacity is eligible', () => {
  const run = recommend([researcher('a', { committedHours: 6 })], request, config);
  assert.equal(run.retained[0]?.hoursAfterAssignment, 0);
});
test('essential skills are mandatory regardless of score', () => {
  assert.equal(recommend([researcher('a', { skills: ['data-analysis'] })], request, config).eligibleCount, 0);
});
test('inactive researchers and full account loads are excluded', () => {
  const run = recommend([researcher('a', { active: false }), researcher('b', { maxAccounts: 1, currentAccountIds: ['other'] })], request, config);
  assert.equal(run.excluded.length, 2);
  assert.equal(run.eligibleCount, 0);
});
test('already assigned researchers are not proposed for a new opening on that account', () => {
  assert.equal(recommend([researcher('a', { currentAccountIds: ['account-a'] })], request, config).eligibleCount, 0);
});
test('minimum experience is an eligibility requirement', () => {
  assert.equal(recommend([researcher()], { ...request, minimumExperienceYears: 3 }, config).eligibleCount, 0);
});
test('missing capacity data and conflicting totals are flagged, not inferred', () => {
  const incomplete: Record<string, unknown> = researcher('incomplete'); delete incomplete.committedHours;
  const run = recommend([incomplete, researcher('conflict', { committedHours: 11 })], request, config);
  assert.equal(run.eligibleCount, 0);
  assert.ok(run.excluded.every(r => r.dataIssue));
  assert.ok(run.warnings.some(w => w.includes('incomplete or conflicting')));
});
test('conflicting duplicate IDs are all excluded', () => {
  const run = recommend([researcher('same'), researcher('same', { committedHours: 0 })], request, config);
  assert.equal(run.eligibleCount, 0);
  assert.ok(run.excluded.every(r => r.dataIssue));
});
test('skills normalize case and whitespace and ignore duplicate tags', () => {
  const run = recommend([researcher('a', { skills: [' Survey-Design ', 'DATA-ANALYSIS', 'data-analysis'] })], request, config);
  assert.equal(run.eligibleCount, 1);
  assert.equal(run.retained[0]?.breakdown.skills.value, 1);
});
test('more remaining capacity wins when other criteria are equal', () => {
  const run = recommend([researcher('busy', { committedHours: 5 }), researcher('free', { committedHours: 0 })], request, config);
  assert.equal(run.retained[0]?.researcherId, 'free');
});
test('legal weight changes alter ranking while bandwidth stays the largest criterion', () => {
  const candidates = [researcher('capacity', { committedHours: 1, skills: ['survey-design'] }), researcher('fit', { committedHours: 3 })];
  const capacityConfig = { ...config, weights: { bandwidth: .7, skills: .1, experience: .05, interests: .05, accountLoad: .05, industry: .05 } };
  const fitConfig = { ...config, weights: { bandwidth: .4, skills: .35, experience: .1, interests: .05, accountLoad: .05, industry: .05 } };
  assert.equal(recommend(candidates, request, capacityConfig).retained[0]?.researcherId, 'capacity');
  assert.equal(recommend(candidates, request, fitConfig).retained[0]?.researcherId, 'fit');
});
test('invalid weights, display limits, requests, and non-finite values fail explicitly', () => {
  assert.throws(() => recommend([], request, { ...config, weights: { ...config.weights, bandwidth: .1 } }));
  assert.throws(() => recommend([], request, { ...config, displayCount: 5 }));
  assert.throws(() => recommend([], { ...request, hoursPerResearcher: 0 }, config));
  assert.throws(() => recommend([], { ...request, openings: 0 }, config));
  assert.equal(recommend([researcher('a', { experienceYears: Infinity })], request, config).eligibleCount, 0);
});
test('unused criteria receive no weight and fit scores stay within 0 to 100', () => {
  const run = recommend([researcher()], { ...request, requiredSkills: [], preferredSkills: [] }, config);
  const top = run.retained[0]!;
  assert.equal(top.breakdown.skills.value, null);
  assert.equal(top.breakdown.skills.effectiveWeight, 0);
  assert.equal(top.breakdown.interests.effectiveWeight, 0);
  assert.equal(top.breakdown.industry.effectiveWeight, 0);
  assert.ok(Math.abs(Object.values(top.breakdown).reduce((sum, b) => sum + b.effectiveWeight, 0) - 1) < 1e-9);
  assert.ok(top.score >= 0 && top.score <= 100);
});
test('insufficient candidates for multiple openings is partial and requires unique selections', () => {
  const run = recommend([researcher()], { ...request, openings: 2 }, config);
  assert.equal(run.status, 'partial');
  assert.ok(run.warnings.some(w => w.includes('only one opening')));
});
test('no match and empty datasets return a manager-readable result', () => {
  const run = recommend([], request, config);
  assert.equal(run.status, 'no_eligible');
  assert.match(managerMessage(run), /No eligible researcher/);
});
test('ranking does not mutate source data, request, or configuration', () => {
  const data = [researcher()]; const before = JSON.stringify({ data, request, config });
  recommend(data, request, config);
  assert.equal(JSON.stringify({ data, request, config }), before);
});
test('direct-invoke Lambda handler validates inputs and returns the five-candidate result', async () => {
  const result = await handler({ researchers: [researcher()], request, config });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).retained.length, 1);
  assert.equal((await handler({})).statusCode, 400);
});
