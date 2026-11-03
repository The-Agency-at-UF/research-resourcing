import { readFile } from 'node:fs/promises';
import { configSchema } from '../recommendations/models.js';
import { configuredPilotStore } from '../pilot/dynamodb-store.js';
import { seedPilot } from '../pilot/seed.js';
import { verifyPilotTarget } from '../pilot/runtime.js';

await verifyPilotTarget();
const config = configSchema.parse(JSON.parse(await readFile('config/scoring.json', 'utf8')));
await seedPilot(configuredPilotStore(), config);
console.log('Fictional pilot initialized. Existing state was not overwritten.');
