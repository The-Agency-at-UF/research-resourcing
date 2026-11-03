import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configuredPilotStore } from '../src/pilot/dynamodb-store.js';
import { seedPilot } from '../src/pilot/seed.js';
import { PilotService } from '../src/pilot/service.js';
import { verifyPilotTarget } from '../src/pilot/runtime.js';
import { configSchema } from '../src/recommendations/models.js';
import type { DatedResearcher } from '../src/pilot/models.js';

test('real DynamoDB: atomic conflicting batches, idempotency, seed protection and restart', async () => {
  await verifyPilotTarget();
  const originalNamespace = process.env.PILOT_NAMESPACE;
  process.env.PILOT_NAMESPACE = `integration-${randomUUID()}`;
  try {
    const store = configuredPilotStore(), config = configSchema.parse(JSON.parse(readFileSync('config/scoring.json', 'utf8')));
    await seedPilot(store, config); await assert.rejects(seedPilot(store, config), /Refusing/);
    const actor = { teamId: 'TB67278DB', userId: 'U0AS0D7GQMB' }, service = new PilotService(store, actor.teamId);
    const request = { accountId: 'sample-health', accountName: 'Fictional Health Account', hoursPerResearcher: 8, openings: 2,
      requiredSkills: ['survey-design'], preferredSkills: [], minimumExperienceYears: 0, careerInterests: [], startDate: '2026-11-02', endDate: '2026-11-30' };
    const prepare = async (ids: string[]) => {
      const requestId = await service.createRequest(actor, request), run = await service.recommendations(actor, requestId);
      return service.prepareApproval(actor, requestId, run.runId, ids);
    };
    const a = await prepare(['sample-sam', 'sample-jordan']), b = await prepare(['sample-sam', 'sample-riley']);
    const outcomes = await Promise.allSettled([service.approve(actor, a.approvalId), service.approve(actor, b.approvalId)]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const winner = outcomes[0]!.status === 'fulfilled' ? a : b, loser = winner === a ? b : a;
    const freshService = new PilotService(configuredPilotStore(), actor.teamId);
    const approved = await freshService.approve(actor, winner.approvalId);
    assert.equal(approved.assignmentIds.length, 2);
    assert.equal((await freshService.request(actor, winner.review.requestId)).data.status, 'filled');
    assert.equal((await freshService.request(actor, loser.review.requestId)).data.filledResearcherIds.length, 0);
    assert.equal((await store.list('APPROVAL#')).length, 1);
    const schedules = await store.list<DatedResearcher>('RESEARCHER#');
    assert.equal(schedules.flatMap(r => r.data.assignments).filter(a => a.id.startsWith(loser.approvalId)).length, 0);
    assert.equal(schedules.flatMap(r => r.data.assignments).filter(a => a.id.startsWith(winner.approvalId)).length, 2);
    console.log(`Verified isolated DynamoDB namespace ${process.env.PILOT_NAMESPACE}; records retained for inspection.`);
  } finally { if (originalNamespace === undefined) delete process.env.PILOT_NAMESPACE; else process.env.PILOT_NAMESPACE = originalNamespace; }
});

test('real DynamoDB: workbook seed, role-based approval, cancellation, notices, HQ and metrics', async () => {
  const { workbookSeed, seedRows } = await import('../src/pilot/seed.js');
  const { parseWorkbook } = await import('../src/workbook/parse.js');
  const { workbookSettingsSchema } = await import('../src/workbook/researchers.js');
  const { sampleWorkbook } = await import('../src/workbook/sample.js');
  const { seedSettings } = await import('../src/pilot/runtime.js');
  await verifyPilotTarget();
  const originalNamespace = process.env.PILOT_NAMESPACE;
  process.env.PILOT_NAMESPACE = `integration-workbook-${randomUUID()}`;
  try {
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    const store = configuredPilotStore();
    await seedRows(store, workbookSeed(parseWorkbook(sampleWorkbook()), workbookSettingsSchema.parse(read('config/workbook.json')),
      configSchema.parse(read('config/scoring-workbook.json')), { source: 'fictional sample workbook', fictional: true, asOf: '2026-11-02' }));
    const { units, fictional } = await seedSettings(store);
    assert.deepEqual(units, { kind: 'account-slots', maxAccounts: 3 }); assert.equal(fictional, true);
    const actor = { teamId: 'TB67278DB', userId: 'U0AS0D7GQMB' }, service = new PilotService(store, actor.teamId, undefined, units);
    const requestId = await service.createRequest(actor, { accountId: 'fictional-screening-co', accountName: 'Fictional Screening Co', hoursPerResearcher: 1, openings: 2,
      requiredSkills: ['strategist'], preferredSkills: [], minimumExperienceYears: 0, careerInterests: [], startDate: '2026-11-16', endDate: '2026-12-11' });
    const run = await service.recommendations(actor, requestId);
    assert.deepEqual(run.run.retained.map(r => r.researcherId), ['ivy-iota', 'ed-epsilon']);
    assert.match(run.run.retained[0]!.explanation, /3 of 3 account slots free/);
    const prepared = await service.prepareApproval(actor, requestId, run.runId, ['ivy-iota', 'ed-epsilon']);
    const approval = await service.approve(actor, prepared.approvalId);
    assert.equal(await service.claimNotice(approval.id), true); assert.equal(await service.claimNotice(approval.id), false);
    const cancelled = await service.changeAssignment(actor, 'ivy-iota', 0, { action: 'cancel' });
    assert.equal(cancelled.reopenedRequest, true);
    assert.equal((await service.request(actor, requestId)).data.status, 'partial');
    await service.saveHqLocation({ channel: 'C0TESTHQ', ts: '1.0' });
    const hq = (await service.hqLocation())!; await service.saveHqLocation({ channel: 'C0TESTHQ', ts: '2.0' }, hq);
    assert.equal((await service.hqLocation())!.data.ts, '2.0');
    const metrics = await service.metrics(actor);
    assert.deepEqual(metrics.acceptance, { selections: 2, shown: 2, approvalsMeasured: 1, topPicks: 1 });
    assert.deepEqual(metrics.changes, { cancelled: 1, rescheduled: 0 });
    console.log(`Verified workbook flow in DynamoDB namespace ${process.env.PILOT_NAMESPACE}; records retained for inspection.`);
  } finally { if (originalNamespace === undefined) delete process.env.PILOT_NAMESPACE; else process.env.PILOT_NAMESPACE = originalNamespace; }
});
