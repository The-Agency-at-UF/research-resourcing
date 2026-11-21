import { App } from '@slack/bolt';
import { readFile } from 'node:fs/promises';
import { registerResourcingHandlers } from './slack/resourcing.js';
import { ResourcingService } from './resourcing/service.js';
import { configuredStore } from './resourcing/dynamodb-store.js';
import { idList, seedSettings, verifyAwsTarget } from './resourcing/runtime.js';
import { configSchema } from './recommendations/models.js';
import { workbookSettingsSchema } from './workbook/researchers.js';
import { workbookUpload } from './workbook/upload.js';

// Local development over Socket Mode; the hosted app runs the same handlers on Lambda (docs/hosting.md).
const token = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const teamId = process.env.SLACK_TEAM_ID;
if (!token || !appToken || !teamId || !process.env.WORKFLOW_TABLE) throw new Error('Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_TEAM_ID, and WORKFLOW_TABLE in .env.resourcing. See docs/slack-setup.md.');
const app = new App({ token, appToken, socketMode: true });
const identity = await app.client.auth.test();
if (identity.team_id !== teamId) throw new Error('Slack token belongs to a different workspace than SLACK_TEAM_ID');
const load = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const workbookSettings = workbookSettingsSchema.parse(await load('config/workbook.json'));
await verifyAwsTarget();
const store = configuredStore(), { units, fictional } = await seedSettings(store);
registerResourcingHandlers(app, new ResourcingService(store, teamId, undefined, units, idList(process.env.RESOURCING_ADMINS)), {
  notify: idList(process.env.RESOURCING_NOTIFY), hqChannel: idList(process.env.RESOURCING_HQ_CHANNEL)[0], fictional,
  // Restart after an upload initializes an empty namespace so its units and label are read again.
  workbook: { read: workbookUpload(workbookSettings), maxAccounts: workbookSettings.maxAccounts, config: configSchema.parse(await load('config/scoring-workbook.json')) },
});
await app.start();
console.log(`Research Resourcing connected to namespace ${process.env.RESOURCING_NAMESPACE}${fictional ? ' (sample data)' : ''}. Run /resourcing in Slack.`);
