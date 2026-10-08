import { App } from '@slack/bolt';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { recommend } from './recommendations/scoring.js';
import { registerDemoHandlers } from './slack/handlers.js';
import { explainWithGemini } from './integrations/gemini.js';

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
      ...(explanation ? { explanation, model: process.env.GEMINI_MODEL } : {}),
    }, null, 2), { mode: 0o600 });
  } catch {
    console.error('The result was shown, but the local demo record could not be saved. Check artifacts/slack-runs permissions.');
  }
}, run => explainWithGemini(run, { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, systemInstruction }));
await app.start();
console.log('Fictional staffing demo connected. Run /resource-demo or /resource-demo form in the configured workspace.');
