import { webApi } from '@slack/bolt';
import scoring from '../../config/scoring-workbook.json' with { type: 'json' };
import workbook from '../../config/workbook.json' with { type: 'json' };
import { configuredStore } from '../resourcing/dynamodb-store.js';
import { idList, seedSettings, verifyAwsTarget } from '../resourcing/runtime.js';
import { ResourcingService } from '../resourcing/service.js';
import { configSchema } from '../recommendations/models.js';
import { workbookSettingsSchema } from '../workbook/researchers.js';
import { workbookUpload } from '../workbook/upload.js';
import { runResourcingJob, type ResourcingJob, type ResourcingOptions } from '../slack/resourcing.js';
import { loadParameters } from './parameters.js';

// Invoked asynchronously by the receiver with one job; never exposed publicly. Retries are disabled in the template.
const { SLACK_BOT_TOKEN } = await loadParameters(['SLACK_BOT_TOKEN'] as const);
// A couple of quick retries for transient Slack errors, well inside the 60-second function timeout.
const client = new webApi.WebClient(SLACK_BOT_TOKEN, { retryConfig: { retries: 2, maxTimeout: 2000 } });
const settings = workbookSettingsSchema.parse(workbook);
const upload = { read: workbookUpload(settings), maxAccounts: settings.maxAccounts, config: configSchema.parse(scoring) };
let ready: Promise<ReturnType<typeof configuredStore>> | undefined;
export async function handler(job: ResourcingJob, context: { invokedFunctionArn: string }) {
  ready ??= verifyAwsTarget(context.invokedFunctionArn.split(':')[4]).then(() => configuredStore()).catch(error => { ready = undefined; throw error; });
  const store = await ready;
  // Read per job: a Slack upload can initialize the namespace, which changes its units and label.
  const { units, fictional } = await seedSettings(store);
  const options: ResourcingOptions = { notify: idList(process.env.RESOURCING_NOTIFY), hqChannel: idList(process.env.RESOURCING_HQ_CHANNEL)[0], fictional, workbook: upload };
  await runResourcingJob(job, client, new ResourcingService(store, process.env.SLACK_TEAM_ID ?? '', undefined, units, idList(process.env.RESOURCING_ADMINS)), options);
}
