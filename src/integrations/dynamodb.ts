import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { RecommendationRun } from '../recommendations/models.js';

/** Optional persistence adapter; the demo does not invoke this or modify cloud data. */
export async function saveRecommendationRun(run: RecommendationRun, runId: string = randomUUID()) {
  const runsTable = process.env.RECOMMENDATION_RUNS_TABLE;
  const resultsTable = process.env.RECOMMENDATION_RESULTS_TABLE;
  if (!runsTable || !resultsTable || !process.env.AWS_REGION) throw new Error('Configure AWS_REGION and both recommendation table names');
  const createdAt = new Date().toISOString();
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  await client.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: runsTable, ConditionExpression: 'attribute_not_exists(run_id)', Item: {
      run_id: runId, account_id: run.request.accountId, created_at: createdAt, request: run.request,
      config: run.config, status: run.status, eligible_count: run.eligibleCount,
      excluded: run.excluded, warnings: run.warnings,
      approval_status: run.status === 'no_eligible' ? 'no_eligible' : 'awaiting_manager',
    } } },
    ...run.retained.map(candidate => ({ Put: { TableName: resultsTable,
      ConditionExpression: 'attribute_not_exists(run_id) AND attribute_not_exists(researcher_id)',
      Item: { run_id: runId, researcher_id: candidate.researcherId, ...candidate },
    } })),
  ] }));
  return runId;
}
