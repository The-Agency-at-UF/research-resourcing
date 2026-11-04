import { App } from '@slack/bolt';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { recommend } from './recommendations/scoring.js';
import { registerDemoHandlers } from './slack/handlers.js';
import { explainWithGemini, GEMINI_BASE_MODEL } from './integrations/gemini.js';
import { registerPilotHandlers } from './slack/pilot.js';
import { PilotService } from './pilot/service.js';
import { configuredPilotStore } from './pilot/dynamodb-store.js';
import { idList, seedSettings, verifyPilotTarget } from './pilot/runtime.js';
import { configSchema } from './recommendations/models.js';
import { workbookSettingsSchema } from './workbook/researchers.js';
import { workbookUpload } from './workbook/upload.js';

const token = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const teamId = process.env.SLACK_TEAM_ID;
if (!token || !appToken || !teamId) throw new Error('Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_TEAM_ID in .env. See docs/slack-demo.md.');
const app = new App({ token, appToken, socketMode: true });
const identity = await app.client.auth.test();
if (identity.team_id !== teamId) throw new Error('Slack token belongs to a different workspace than SLACK_TEAM_ID');
const load = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const data = { researchers: await load('fixtures/researchers.json'), request: await load('fixtures/request.json'), config: await load('config/scoring.json') };
recommend(data.researchers, data.request, data.config); // Fail at startup if fixtures or configuration are invalid.
const systemInstruction = await readFile('config/gemini-system-instructions.md', 'utf8');
registerDemoHandlers(app, teamId, data, async (run, explanation) => {
  try {
    const runId = randomUUID();
    await mkdir('artifacts/slack-runs', { recursive: true });
    await writeFile(`artifacts/slack-runs/${runId}.json`, JSON.stringify({ runId, createdAt: new Date().toISOString(), ...run,
      ...(explanation ? { explanation, model: process.env.GEMINI_MODEL || GEMINI_BASE_MODEL } : {}),
    }, null, 2), { mode: 0o600 });
  } catch {
    console.error('The result was shown, but the local demo record could not be saved. Check artifacts/slack-runs permissions.');
  }
}, run => explainWithGemini(run, { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, systemInstruction }));
const workbookSettings = workbookSettingsSchema.parse(await load('config/workbook.json'));
if (process.env.WORKFLOW_TABLE) {
  await verifyPilotTarget();
  const store = configuredPilotStore(), { units, fictional } = await seedSettings(store);
  registerPilotHandlers(app, new PilotService(store, teamId, undefined, units), {
    notify: idList(process.env.PILOT_NOTIFY), hqChannel: idList(process.env.PILOT_HQ_CHANNEL)[0], fictional,
    // Restart after an upload initializes an empty namespace so its units and label are read again.
    workbook: { read: workbookUpload(workbookSettings), maxAccounts: workbookSettings.maxAccounts, config: configSchema.parse(await load('config/scoring-workbook.json')) },
  });
} else registerPilotHandlers(app);
await app.start();
console.log('Staffing Recommendation Beta connected (fictional sample data). Run /resource-demo or /resource-demo form in the configured workspace.');
