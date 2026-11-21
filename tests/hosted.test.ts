import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createReceiverHandler } from '../src/hosted/app.js';
import { PILOT_REQUEST, PILOT_SELECT, runPilotJob, type PilotJob } from '../src/slack/pilot.js';
import { harness, values, who } from './pilot-harness.js';

const secret = 'test-signing-secret';
/** A local stand-in for slack.com/api that records each Web API call. */
async function fakeSlack() {
  const calls: { method: string; params: Record<string, string> }[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const method = req.url!.split('/').pop()!, params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method, params: Object.keys(params).length ? params : (body ? JSON.parse(body) : {}) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(method === 'views.open' ? { ok: true, view: { id: 'V123' } } : method === 'auth.test' ? { ok: true, team_id: who.teamId, user_id: 'U0BOT', bot_id: 'B0BOT' } : { ok: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, base, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
/** A Lambda Function URL (payload v2) event carrying a Slack request signed like Slack signs it. */
type LambdaEvent = Parameters<ReturnType<typeof createReceiverHandler>>[0];
const event = (body: string, { signingSecret = secret, ts = Math.floor(Date.now() / 1000) } = {}) => ({
  version: '2.0', routeKey: '$default', rawPath: '/', rawQueryString: '', requestContext: { http: { method: 'POST' } }, isBase64Encoded: true,
  body: Buffer.from(body).toString('base64'),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(ts),
    'x-slack-signature': `v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${body}`).digest('hex')}` },
}) as unknown as LambdaEvent;
const command = (text: string, name = '/resource-pilot', responseUrl = 'http://127.0.0.1:1/unused') => new URLSearchParams({ token: 'legacy', team_id: who.teamId, user_id: who.userId,
  command: name, text, trigger_id: 'trigger-1', response_url: responseUrl, channel_id: 'C0TEST', api_app_id: 'A0TEST' }).toString();
const submission = (callback: string, view: { private_metadata?: string }, stateValues: unknown) => `payload=${encodeURIComponent(JSON.stringify({
  type: 'view_submission', api_app_id: 'A0TEST', team: { id: who.teamId }, user: { id: who.userId },
  view: { id: 'V900', callback_id: callback, private_metadata: view.private_metadata ?? '{}', state: { values: stateValues }, hash: 'h' } }))}`;
async function receiver() {
  const slack = await fakeSlack(), jobs: PilotJob[] = [];
  const handle = createReceiverHandler({ token: 'xoxb-test', signingSecret: secret, teamId: who.teamId, fictional: true, slackApiUrl: `${slack.base}/api/`,
    dispatch: async job => { jobs.push(JSON.parse(JSON.stringify(job))); } });
  return { slack, jobs, handle };
}

test('signed slash command is acknowledged, opens a loading modal, and dispatches a serializable job', async () => {
  const r = await receiver();
  try {
    const response = await r.handle(event(command('')), {});
    assert.equal(response.statusCode, 200);
    const open = r.slack.calls.find(c => c.method === 'views.open')!;
    assert.match(open.params.view!, /Loading pilot access/); assert.equal(open.params.trigger_id, 'trigger-1');
    assert.deepEqual(r.jobs, [{ kind: 'command', teamId: who.teamId, userId: who.userId, text: '', viewId: 'V123' }]);
  } finally { await r.slack.close(); }
});
test('unsigned, wrongly signed, and replayed requests are rejected before any handler runs', async () => {
  const r = await receiver();
  try {
    assert.equal((await r.handle(event(command(''), { signingSecret: 'wrong' }), {})).statusCode, 401);
    assert.equal((await r.handle(event(command(''), { ts: Math.floor(Date.now() / 1000) - 600 }), {})).statusCode, 401);
    const unsigned = { ...event(command('')), headers: { 'content-type': 'application/x-www-form-urlencoded' } } as LambdaEvent;
    assert.equal((await r.handle(unsigned, {})).statusCode, 401);
    assert.equal(r.jobs.length, 0); assert.ok(!r.slack.calls.some(c => c.method === 'views.open'));
  } finally { await r.slack.close(); }
});
test('form validation errors return synchronously in the HTTP response without dispatching', async () => {
  const r = await receiver();
  try {
    const response = await r.handle(event(submission(PILOT_REQUEST, {}, { ...values, openings: { value: { type: 'plain_text_input', value: '0' } } })), {});
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.response_action, 'errors'); assert.ok(body.errors.openings);
    assert.equal(r.jobs.length, 0);
  } finally { await r.slack.close(); }
});
test('hosted selection acknowledges with a loading view, and the worker job completes the flow from JSON', async () => {
  const h = await harness(), r = await receiver();
  try {
    await h.command(''); await h.submit(PILOT_REQUEST, h.views.at(-1), values);
    const select = h.views.at(-1), choice = { decision: { value: { selected_option: { value: 'approve' } } }, candidates: { value: { selected_options: [{ value: 'ivy-iota' }] } } };
    const response = await r.handle(event(submission(PILOT_SELECT, select, choice)), {});
    const body = JSON.parse(response.body);
    assert.equal(body.response_action, 'update'); assert.match(JSON.stringify(body.view), /Checking current availability/);
    assert.equal(r.jobs.length, 1); assert.equal(r.jobs[0]!.viewId, 'V900');
    await runPilotJob(r.jobs[0]!, h.client as never, h.service);
    assert.match(JSON.stringify(h.views.at(-1)), /Confirm test assignments/); assert.match(JSON.stringify(h.views.at(-1)), /Ivy Iota/);
  } finally { await r.slack.close(); }
});
test('the original demo command answers entirely inside the receiver', async () => {
  const r = await receiver();
  try {
    const response = await r.handle(event(command('', '/resource-demo', `${r.slack.base}/respond`)), {});
    assert.equal(response.statusCode, 200);
    const reply = r.slack.calls.find(c => c.method === 'respond')!;
    assert.match(JSON.stringify(reply.params), /FICTIONAL DATA DEMO/); assert.equal(r.jobs.length, 0);
  } finally { await r.slack.close(); }
});
test('a dispatch failure replaces the loading view with a clear failure instead of hanging', async () => {
  const slack = await fakeSlack();
  try {
    const handle = createReceiverHandler({ token: 'xoxb-test', signingSecret: secret, teamId: who.teamId, fictional: true, slackApiUrl: `${slack.base}/api/`,
      dispatch: async () => { throw new Error('throttled'); } });
    assert.equal((await handle(event(command('')), {})).statusCode, 200);
    const update = slack.calls.find(c => c.method === 'views.update')!;
    assert.match(update.params.view!, /could not be started. Nothing was saved/);
  } finally { await slack.close(); }
});
