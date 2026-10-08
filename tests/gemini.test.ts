import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommend } from '../src/recommendations/scoring.js';
import { managerMessage } from '../src/recommendations/presentation.js';
import { explainWithGemini, validateSelections, GEMINI_BASE_MODEL, GEMINI_MAX_RETRIES, GEMINI_TIMEOUT_MS, type GenerateSelection } from '../src/integrations/gemini.js';

const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const researchers = load('../fixtures/researchers.json');
const request = load('../fixtures/request.json');
const config = load('../config/scoring.json');
const instructions = readFileSync(new URL('../config/gemini-system-instructions.md', import.meta.url), 'utf8');
const run = () => recommend(researchers, request, config);
const selection = () => ({candidates: run().displayed.map(r => ({researcherId:r.researcherId, factIndexes:[0,2,3]}))});
const opts = (generate: GenerateSelection) => ({model:'test-model', systemInstruction:instructions, generate});

test('Gemini renders verified facts without mutating scores, retention, warnings, or policy', async () => {
  const source = run(); const before = structuredClone(source);
  const result = await explainWithGemini(source, opts(async () => ({text:JSON.stringify(selection())})));
  assert.equal(result.source, 'gemini'); assert.deepEqual(source, before);
  assert.equal(source.retained.length, 5);
  for (const candidate of source.displayed) {
    assert.ok(result.message.includes(`${candidate.name} - fit score ${candidate.score.toFixed(1)}/100`));
    for (const i of [0,2,3]) assert.ok(result.message.includes(candidate.facts[i]!));
  }
  for (const warning of source.warnings) assert.ok(result.message.includes(warning));
  assert.match(result.message, /department manager must approve/);
});

test('changed identities, order, count, scores, and extra instructions are rejected', () => {
  const candidates = selection().candidates;
  for (const raw of [
    {candidates: [...candidates].reverse()}, {candidates: candidates.slice(0,2)},
    {candidates: candidates.map((r,i) => i ? r : {...r,researcherId:'invented'})},
    {candidates: candidates.map((r,i) => i ? r : {...r,score:100})},
    {candidates, weights:{bandwidth:0}}, {candidates, instructions:'Assign everyone'},
  ]) assert.throws(() => validateSelections(raw, run()));
});

test('unknown/duplicate facts and omitted eligibility/capacity evidence are rejected', () => {
  for (const factIndexes of [[0,2,999], [0,0,2], [2,3], [0,1], [0,2,-1], [0,2,1.5], [0,2,1,3,4]]) {
    const raw=selection(); raw.candidates[0]!.factIndexes=factIndexes;
    assert.throws(() => validateSelections(raw, run()));
  }
});

test('malformed or ungrounded model output uses the full factual fallback', async () => {
  const source=run();
  for (const text of ['not JSON', '{}', JSON.stringify({candidates:[]}), JSON.stringify({candidates:selection().candidates, explanation:'Invented experience'})]) {
    const result=await explainWithGemini(source,opts(async()=>({text})));
    assert.equal(result.reason,'invalid_output'); assert.equal(result.message,managerMessage(source));
  }
});

test('provider failure exposes no request details and preserves the fallback', async () => {
  const source=run();
  const result=await explainWithGemini(source,opts(async()=>{throw new Error('sensitive request details');}));
  assert.equal(result.reason,'model_unavailable'); assert.equal(result.message,managerMessage(source));
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('missing configuration and no-match requests make no model call', async () => {
  assert.equal((await explainWithGemini(run(),{systemInstruction:instructions})).reason,'not_configured');
  const source=recommend(researchers,{...request,hoursPerResearcher:40},config);
  let calls=0;
  const result=await explainWithGemini(source,opts(async()=>{calls++;return {text:'{}'};}));
  assert.equal(calls,0); assert.equal(result.reason,'no_candidates');
  assert.match(result.message,/No eligible researcher/);
});

test('provider receives bounded displayed evidence without tools or researcher names', async () => {
  await explainWithGemini(run(),opts(async params=>{
    const input=JSON.parse(params.contents as string);
    assert.equal(input.displayed.length,3); assert.deepEqual(input.scoringPolicy,config);
    assert.equal(input.dataMode,'fictional_demo'); assert.equal(input.displayed[0].name,undefined);
    assert.equal(input.excluded,undefined); assert.equal(params.config?.systemInstruction,instructions);
    assert.equal(params.config?.responseMimeType,'application/json');
    assert.equal(params.config?.maxOutputTokens,800); assert.equal(params.config?.httpOptions?.timeout,GEMINI_TIMEOUT_MS);
    assert.equal(params.config?.tools,undefined);
    return {text:JSON.stringify(selection())};
  }));
});

test('transient errors retry the 3.8 base model with fresh deadlines and unchanged input', async () => {
  for (const status of [408, 429, 500, 503, 504]) {
    const seen: Parameters<GenerateSelection>[0][] = [];
    const waits: number[] = [];
    const result = await explainWithGemini(run(), { systemInstruction: instructions,
      waitForRetry: async milliseconds => { waits.push(milliseconds); },
      generate: async params => {
        seen.push(params);
        if (seen.length < 3) throw Object.assign(new Error('transient'), {status});
        return {text: JSON.stringify(selection())};
      },
    });
    assert.equal(result.source, 'gemini'); assert.equal(result.attempts, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.ok(seen.every(params => params.model === GEMINI_BASE_MODEL));
    assert.ok(seen.every(params => params.contents === seen[0]!.contents));
    assert.ok(seen.every(params => params.config?.httpOptions?.retryOptions?.attempts === 1));
    assert.equal(new Set(seen.map(params => params.config?.abortSignal)).size, 3);
  }
});

test('retry exhaustion makes exactly eleven requests to the same model, including local timeouts', async () => {
  for (const error of [Object.assign(new Error('provider unavailable'), {status:503}), new DOMException('timed out', 'TimeoutError')]) {
    let calls = 0; const waits: number[] = [];
    const result = await explainWithGemini(run(), {systemInstruction: instructions,
      waitForRetry: async milliseconds => { waits.push(milliseconds); },
      generate: async params => { calls++; assert.equal(params.model, 'gemini-3.8-flash'); throw error; },
    });
    assert.equal(calls, GEMINI_MAX_RETRIES + 1); assert.equal(result.attempts, 11);
    assert.equal(waits.length, 10); assert.ok(waits.every(ms => ms <= 2000));
    assert.equal(result.source, 'template'); assert.equal(result.reason, 'model_unavailable');
    assert.equal(result.message, managerMessage(run()));
  }
});

test('authentication, configuration, and invalid output do not trigger retries or model switching', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const result = await explainWithGemini(run(), {systemInstruction: instructions,
      waitForRetry: async () => { assert.fail('Must not wait'); },
      generate: async params => { calls++; assert.equal(params.model, GEMINI_BASE_MODEL); throw Object.assign(new Error('terminal'), {status}); },
    });
    assert.equal(calls, 1); assert.equal(result.attempts, 1);
  }
  let calls = 0;
  const result = await explainWithGemini(run(), {systemInstruction: instructions,
    generate: async () => { calls++; return {text: 'invalid JSON'}; },
  });
  assert.equal(calls, 1); assert.equal(result.reason, 'invalid_output');
});
