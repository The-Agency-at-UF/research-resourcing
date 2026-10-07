import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { recommend } from '../src/recommendations/scoring.js';
import { saveRecommendationRun } from '../src/integrations/dynamodb.js';

test('audit persistence sends one transaction containing the run and exactly the retained five', async t => {
  const keys = ['AWS_REGION', 'RECOMMENDATION_RUNS_TABLE', 'RECOMMENDATION_RESULTS_TABLE'];
  const previous = keys.map(k => process.env[k]);
  t.after(() => { keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); });
  process.env.AWS_REGION = 'us-east-1';
  process.env.RECOMMENDATION_RUNS_TABLE = 'fictional-runs';
  process.env.RECOMMENDATION_RESULTS_TABLE = 'fictional-results';
  let captured: unknown;
  const send = mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => { captured = command; return {}; });
  t.after(() => send.mock.restore());
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  const run = recommend(load('fixtures/researchers.json'), load('fixtures/request.json'), load('config/scoring.json'));
  assert.equal(await saveRecommendationRun(run, 'fictional-run'), 'fictional-run');
  assert.equal(send.mock.callCount(), 1);
  assert.ok(captured instanceof TransactWriteCommand);
  const items = captured.input.TransactItems!;
  assert.equal(items.length, 6);
  assert.equal(items[0]?.Put?.Item?.approval_status, 'awaiting_manager');
  assert.deepEqual(items.slice(1).map(item => item.Put?.Item?.researcher_id), run.retained.map(r => r.researcherId));
  assert.ok(items.every(item => item.Put?.ConditionExpression?.includes('attribute_not_exists')));
});
