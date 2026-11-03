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
