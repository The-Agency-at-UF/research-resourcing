import { webApi } from '@slack/bolt';
import { configuredPilotStore } from '../pilot/dynamodb-store.js';
import { idList, seedSettings, verifyPilotTarget } from '../pilot/runtime.js';
import { PilotService } from '../pilot/service.js';
import { runPilotJob, type PilotJob, type PilotOptions } from '../slack/pilot.js';
import { loadParameters } from './parameters.js';

// Invoked asynchronously by the receiver with one pilot job; never exposed publicly. Retries are disabled in the template.
const { SLACK_BOT_TOKEN } = await loadParameters(['SLACK_BOT_TOKEN'] as const);
// A couple of quick retries for transient Slack errors, well inside the 60-second function timeout.
const client = new webApi.WebClient(SLACK_BOT_TOKEN, { retryConfig: { retries: 2, maxTimeout: 2000 } });
let ready: Promise<{ service: PilotService; options: PilotOptions }> | undefined;
export async function handler(job: PilotJob, context: { invokedFunctionArn: string }) {
  ready ??= (async () => {
    await verifyPilotTarget(context.invokedFunctionArn.split(':')[4]);
    const store = configuredPilotStore(), { units, fictional } = await seedSettings(store);
    return { service: new PilotService(store, process.env.SLACK_TEAM_ID ?? '', undefined, units),
      options: { notify: idList(process.env.PILOT_NOTIFY), hqChannel: idList(process.env.PILOT_HQ_CHANNEL)[0], fictional } };
  })().catch(error => { ready = undefined; throw error; });
  const { service, options } = await ready;
  await runPilotJob(job, client, service, options);
}
