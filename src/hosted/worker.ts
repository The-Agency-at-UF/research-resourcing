import { webApi } from '@slack/bolt';
import scoring from '../../config/scoring-workbook.json' with { type: 'json' };
import workbook from '../../config/workbook.json' with { type: 'json' };
import { configuredPilotStore } from '../pilot/dynamodb-store.js';
import { idList, seedSettings, verifyPilotTarget } from '../pilot/runtime.js';
import { PilotService } from '../pilot/service.js';
import { configSchema } from '../recommendations/models.js';
import { workbookSettingsSchema } from '../workbook/researchers.js';
import { workbookUpload } from '../workbook/upload.js';
import { runPilotJob, type PilotJob, type PilotOptions } from '../slack/pilot.js';
import { loadParameters } from './parameters.js';

// Invoked asynchronously by the receiver with one pilot job; never exposed publicly. Retries are disabled in the template.
const { SLACK_BOT_TOKEN } = await loadParameters(['SLACK_BOT_TOKEN'] as const);
// A couple of quick retries for transient Slack errors, well inside the 60-second function timeout.
const client = new webApi.WebClient(SLACK_BOT_TOKEN, { retryConfig: { retries: 2, maxTimeout: 2000 } });
const settings = workbookSettingsSchema.parse(workbook);
const upload = { read: workbookUpload(settings), maxAccounts: settings.maxAccounts, config: configSchema.parse(scoring) };
let ready: Promise<ReturnType<typeof configuredPilotStore>> | undefined;
export async function handler(job: PilotJob, context: { invokedFunctionArn: string }) {
  ready ??= verifyPilotTarget(context.invokedFunctionArn.split(':')[4]).then(() => configuredPilotStore()).catch(error => { ready = undefined; throw error; });
  const store = await ready;
  // Read per job: a Slack upload can initialize the namespace, which changes its units and label.
  const { units, fictional } = await seedSettings(store);
  const options: PilotOptions = { notify: idList(process.env.PILOT_NOTIFY), hqChannel: idList(process.env.PILOT_HQ_CHANNEL)[0], fictional, workbook: upload };
  await runPilotJob(job, client, new PilotService(store, process.env.SLACK_TEAM_ID ?? '', undefined, units), options);
}
