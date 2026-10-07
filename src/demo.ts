import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recommend } from './recommendations/scoring.js';
import { managerMessage } from './recommendations/presentation.js';

const requestFile = process.argv[2] ?? 'fixtures/request.json';
const configFile = process.argv[3] ?? 'config/scoring.json';
const load = async (file: string): Promise<unknown> => JSON.parse(await readFile(resolve(file), 'utf8'));
const researchers = await load('fixtures/researchers.json');
if (!Array.isArray(researchers)) throw new Error('Researcher data must be an array');
const run = recommend(researchers, await load(requestFile), await load(configFile));
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/recommendation-run.json', JSON.stringify({ createdAt: new Date().toISOString(), ...run }, null, 2) + '\n');
await writeFile('artifacts/manager-view.txt', managerMessage(run) + '\n');
console.log(managerMessage(run));
console.log(`\nRetained ${run.retained.length} of ${run.eligibleCount} eligible candidates in artifacts/recommendation-run.json`);
