import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createReceiverHandler } from './app.js';
import { loadParameters } from './parameters.js';

// Lambda Function URL entry point configured as Slack's request URL for commands and interactivity.
const secrets = await loadParameters(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'] as const);
const lambda = new LambdaClient({}), worker = process.env.WORKER_FUNCTION;
if (!worker || !process.env.SLACK_TEAM_ID) throw new Error('Set WORKER_FUNCTION and SLACK_TEAM_ID');
export const handler = createReceiverHandler({
  token: secrets.SLACK_BOT_TOKEN, signingSecret: secrets.SLACK_SIGNING_SECRET, teamId: process.env.SLACK_TEAM_ID, fictional: process.env.PILOT_FICTIONAL !== 'false',
  dispatch: async job => {
    // Asynchronous invocation returns once queued; the worker replaces the loading view.
    await lambda.send(new InvokeCommand({ FunctionName: worker, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(job)) }));
  },
});
