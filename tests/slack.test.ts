import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { App, Middleware, SlackCommandMiddlewareArgs, SlackViewMiddlewareArgs, ViewOutput, ViewSubmitAction, types } from '@slack/bolt';
import { parseRequestForm, requestModal, resultModal } from '../src/slack/request-form.js';
import { registerDemoHandlers } from '../src/slack/handlers.js';
import { recommend } from '../src/recommendations/scoring.js';
import type { RecommendationRun } from '../src/recommendations/models.js';
import { explainWithGemini, type ExplanationResult } from '../src/integrations/gemini.js';

const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const data = { researchers: load('../fixtures/researchers.json'), request: load('../fixtures/request.json'), config: load('../config/scoring.json') };
const defaults = { accountId: 'sample-health', accountName: 'Fictional Health Account', hoursPerResearcher: '4', openings: '2',
  requiredSkills: 'survey-design', preferredSkills: 'data-analysis, interviewing', minimumExperienceYears: '0',
  careerInterests: 'consumer-research', industryId: 'healthcare' };
const state = (overrides: Partial<Record<keyof typeof defaults, string | null>> = {}): ViewOutput['state']['values'] =>
  Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([key, value]) => [key, { value: { type: 'plain_text_input', value } }]));

test('Slack form creates the same request and shortlist as the CLI fixture', () => {
  const parsed = parseRequestForm(state());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.request, data.request);
  const run = recommend(data.researchers, parsed.request, data.config);
  assert.equal(run.retained.length, 5);
  assert.equal(run.displayed.length, 3);
  assert.equal(run.retained[0]?.name, 'Sample Sam');
});
test('Slack validation points to invalid fields without silently accepting blank numbers', () => {
  for (const value of ['', ' ', '0', '-1', 'Infinity', '4 hours']) {
    const parsed = parseRequestForm(state({ hoursPerResearcher: value }));
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors.hoursPerResearcher);
  }
  for (const value of ['0', '1.5', '101']) {
    const parsed = parseRequestForm(state({ openings: value }));
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors.openings);
  }
  const parsed = parseRequestForm(state({ accountId: '', accountName: ' ', minimumExperienceYears: '-2' }));
  assert.ok(!parsed.ok);
  assert.deepEqual(Object.keys(parsed.errors).sort(), ['accountId', 'accountName', 'minimumExperienceYears']);
});
test('optional empty criteria stay absent and skill tags normalize and deduplicate', () => {
  const parsed = parseRequestForm(state({ hoursPerResearcher: '4.5', requiredSkills: ' SURVEY-DESIGN, survey-design, ',
    preferredSkills: null, industryId: null, careerInterests: '' }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.request.requiredSkills, ['survey-design']);
  assert.deepEqual(parsed.request.preferredSkills, []);
  assert.equal(parsed.request.industryId, undefined);
  assert.equal(parsed.request.hoursPerResearcher, 4.5);
});
test('large or infeasible requests produce honest no-match and partial results', () => {
  const noMatch = parseRequestForm(state({ hoursPerResearcher: '40' }));
  assert.ok(noMatch.ok);
  assert.equal(recommend(data.researchers, noMatch.request, data.config).status, 'no_eligible');
  const partial = parseRequestForm(state({ openings: '10' }));
  assert.ok(partial.ok);
  const run = recommend(data.researchers, partial.request, data.config);
  assert.equal(run.status, 'partial');
  assert.equal(run.retained.length, 5);
  assert.match(JSON.stringify(resultModal(run)), /Only 7 eligible researchers/);
});
test('form bounds keep result text within Slack limits and user text stays literal', () => {
  const overlong = parseRequestForm(state({ accountName: 'a'.repeat(81) }));
  assert.ok(!overlong.ok);
  assert.ok(overlong.errors.accountName);
  const parsed = parseRequestForm(state({ accountName: '<!channel> *Fictional*' }));
  assert.ok(parsed.ok);
  const modal = resultModal(recommend(data.researchers, parsed.request, data.config));
  for (const block of modal.blocks) {
    assert.ok(block.type === 'section');
    const section = block as types.SectionBlock;
    assert.equal(section.text?.type, 'plain_text');
    assert.ok((section.text?.text.length ?? 0) <= 3000);
  }
  assert.match(JSON.stringify(modal), /<!channel>/);
  assert.equal(modal.submit, undefined);
  assert.match(JSON.stringify(requestModal()), /fictional project details/i);
});

// Capture the real Bolt listeners and invoke them with simulated Slack envelopes. No API calls or messages are sent.
function harness(explain?: (run: RecommendationRun) => Promise<ExplanationResult>) {
  let command!: Middleware<SlackCommandMiddlewareArgs>;
  let submission!: Middleware<SlackViewMiddlewareArgs<ViewSubmitAction>>;
  const app = {
    command: (_name: string, listener: typeof command) => { command = listener; },
    view: (_name: string, listener: typeof submission) => { submission = listener; },
  } as unknown as Pick<App, 'command' | 'view'>;
  const records: RecommendationRun[] = [];
  const explanations: Array<ExplanationResult | undefined> = [];
  const acknowledgements: unknown[] = [];
  const responses: unknown[] = [];
  const opened: unknown[] = [];
  const order: string[] = [];
  registerDemoHandlers(app, 'expected-team', data, async (run, explanation) => { order.push('record'); records.push(run); explanations.push(explanation); }, explain);
  return {
    records, explanations, acknowledgements, responses, opened, order,
    command: async (text = '', team = 'expected-team', failOpen = false) => command({
      command: { text, team_id: team, trigger_id: 'test-trigger' },
      ack: async (value: unknown) => { order.push('ack'); acknowledgements.push(value); },
      respond: async (value: unknown) => { responses.push(value); },
      client: { views: { open: async (value: unknown) => { if (failOpen) throw new Error('simulated'); opened.push(value); } } },
    } as unknown as Parameters<typeof command>[0]),
    submit: async (values = state(), team = 'expected-team') => submission({
      body: { team: { id: team } }, view: { state: { values } },
      ack: async (value: unknown) => { order.push('ack'); acknowledgements.push(value); },
    } as unknown as Parameters<typeof submission>[0]),
  };
}
test('form command opens a modal; standard demo remains ephemeral and keeps five', async () => {
  const h = harness();
  await h.command('form');
  assert.equal(h.opened.length, 1);
  assert.equal(h.responses.length, 0);
  assert.equal(h.records.length, 0);
  await h.command();
  assert.match(JSON.stringify(h.responses), /ephemeral/);
  assert.equal(h.records[0]?.retained.length, 5);
});
test('valid submission updates the private modal before storing the full run', async () => {
  const h = harness();
  await h.submit(state({ hoursPerResearcher: '9', openings: '1' }));
  assert.deepEqual(h.order, ['ack', 'record']);
  assert.match(JSON.stringify(h.acknowledgements), /response_action.*update/);
  assert.equal(h.responses.length, 0);
  assert.equal(h.records[0]?.request.hoursPerResearcher, 9);
  assert.equal(h.records[0]?.displayed.length, 2);
});
test('invalid submissions keep the form open and untrusted workspaces get no results', async () => {
  const h = harness();
  await h.submit(state({ hoursPerResearcher: '0' }));
  assert.deepEqual(h.acknowledgements, [{ response_action: 'errors', errors: { hoursPerResearcher: 'Enter weekly hours greater than zero, such as 4 or 4.5.' } }]);
  await h.command('form', 'wrong-team');
  await h.submit(state(), 'wrong-team');
  assert.equal(h.records.length, 0);
  assert.equal(h.opened.length, 0);
  assert.equal(h.responses.length, 0);
});
test('unknown command options and modal API failure return private guidance', async () => {
  const h = harness();
  await h.command('anything');
  await h.command('form', 'expected-team', true);
  assert.equal(h.responses.length, 2);
  assert.match(JSON.stringify(h.responses), /interactivity settings/);
  assert.ok(!JSON.stringify(h.responses).includes('simulated'));
});

test('AI command acknowledges before generation, privately displays validated facts, and records the original ranking', async () => {
  const original = recommend(data.researchers, data.request, data.config);
  const h = harness(async run => {
    assert.deepEqual(h.order, ['ack']);
    return explainWithGemini(run, { model: 'test-model', systemInstruction: 'test instructions', generate: async () => ({
      text: JSON.stringify({ candidates: run.displayed.map(r => ({ researcherId: r.researcherId, factIndexes: [0, 2, 3] })) }),
    }) });
  });
  await h.command('ai');
  assert.equal(h.responses.length, 2);
  assert.match(JSON.stringify(h.responses[0]), /10 retries against the same model/);
  assert.match(JSON.stringify(h.responses[1]), /replace_original.*true/);
  assert.match(JSON.stringify(h.responses[1]), /Provider requests: 1/);
  assert.match(JSON.stringify(h.responses), /Gemini connected: verified fact selection/);
  assert.match(JSON.stringify(h.responses), /ephemeral/);
  assert.equal(h.explanations[0]?.source, 'gemini');
  assert.deepEqual(h.records[0], original);
});

test('AI provider failure is clearly labeled as fallback in Slack', async () => {
  const h = harness(run => explainWithGemini(run, { model: 'test-model', systemInstruction: 'test instructions',
    generate: async () => { throw new Error('private provider details'); },
  }));
  await h.command('ai');
  assert.match(JSON.stringify(h.responses), /Template fallback.*model_unavailable/);
  assert.ok(!JSON.stringify(h.responses).includes('private provider details'));
  assert.equal(h.explanations[0]?.source, 'template');
});

test('AI without configuration falls back; ordinary commands and other workspaces never call Gemini', async () => {
  const unconfigured = harness();
  await unconfigured.command('ai');
  assert.match(JSON.stringify(unconfigured.responses), /not_configured/);
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('Must not call'); });
  await h.command();
  await h.command('form');
  await h.command('ai', 'wrong-team');
  await h.submit();
  assert.equal(calls, 0);
});
