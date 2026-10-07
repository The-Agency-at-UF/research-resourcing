import { App } from '@slack/bolt';
import { readFile } from 'node:fs/promises';
import { recommend } from './recommendations/scoring.js';
import { managerMessage } from './recommendations/presentation.js';

const token = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const teamId = process.env.SLACK_TEAM_ID;
if (!token || !appToken || !teamId) throw new Error('Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_TEAM_ID in .env. See docs/access-setup.md.');
const app = new App({ token, appToken, socketMode: true });
const identity = await app.client.auth.test();
if (identity.team_id !== teamId) throw new Error('Slack token belongs to a different workspace than SLACK_TEAM_ID');
const load = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
app.command('/resource-demo', async ({ command, ack, respond }) => {
  await ack();
  if (command.team_id !== teamId) return;
  try {
    const run = recommend(await load('fixtures/researchers.json'), await load('fixtures/request.json'), await load('config/scoring.json'));
    await respond({ response_type: 'ephemeral', text: `FICTIONAL DATA DEMO\n\n${managerMessage(run)}` });
  } catch {
    await respond({ response_type: 'ephemeral', text: 'Demo could not run. Review the local fixture data and scoring configuration.' });
  }
});
await app.start();
console.log('Fictional staffing demo connected. Run /resource-demo in the configured workspace.');
