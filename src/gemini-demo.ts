import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { recommend } from './recommendations/scoring.js';
import { explainWithGemini, GEMINI_BASE_MODEL } from './integrations/gemini.js';

const load = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const run = recommend(await load('fixtures/researchers.json'),
  await load(process.argv[2] ?? 'fixtures/request.json'), await load('config/scoring.json'));
const explanation = await explainWithGemini(run, {
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL,
  systemInstruction: await readFile('config/gemini-system-instructions.md', 'utf8'),
});
await mkdir('artifacts', {recursive: true});
await writeFile('artifacts/gemini-demo.json', JSON.stringify({createdAt: new Date().toISOString(),
  model: process.env.GEMINI_MODEL || GEMINI_BASE_MODEL, run, explanation}, null, 2) + '\n', {mode: 0o600});
console.log('FICTIONAL DATA DEMO');
console.log(`Model: ${process.env.GEMINI_MODEL || GEMINI_BASE_MODEL}; provider requests: ${explanation.attempts}`);
if (explanation.modelVersion) console.log(`Served model version: ${explanation.modelVersion}`);
console.log(`Explanation source: ${explanation.source} (${explanation.reason})`);
console.log(explanation.message);
console.log(`Retained ${run.retained.length} candidates. Saved artifacts/gemini-demo.json.`);
