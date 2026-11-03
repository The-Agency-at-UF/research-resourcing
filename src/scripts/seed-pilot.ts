import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { configSchema } from '../recommendations/models.js';
import { configuredPilotStore } from '../pilot/dynamodb-store.js';
import { pilotSeed, seedRows, workbookSeed } from '../pilot/seed.js';
import { verifyPilotTarget } from '../pilot/runtime.js';
import { parseWorkbook } from '../workbook/parse.js';
import { workbookSettingsSchema } from '../workbook/researchers.js';
import { sampleWorkbook } from '../workbook/sample.js';

// Usage: npm run pilot:seed [-- --sample-workbook | --workbook <path.xlsx>]. Seeds PILOT_NAMESPACE; never overwrites it.
const load = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));
const [flag, path] = process.argv.slice(2);
await verifyPilotTarget();
let rows, description;
if (!flag) { rows = pilotSeed(configSchema.parse(await load('config/scoring.json'))); description = 'original fictional pilot'; }
else if (flag === '--sample-workbook' || (flag === '--workbook' && path)) {
  const workbook = flag === '--workbook' ? new ExcelJS.Workbook() : sampleWorkbook();
  if (flag === '--workbook') await workbook.xlsx.readFile(path!);
  const aliasFile = 'data/private/workbook-aliases.json';
  rows = workbookSeed(parseWorkbook(workbook), workbookSettingsSchema.parse(await load('config/workbook.json')), configSchema.parse(await load('config/scoring-workbook.json')), {
    source: flag === '--workbook' ? 'Research Resourcing workbook' : 'fictional sample workbook', fictional: flag !== '--workbook',
    asOf: new Date().toISOString().slice(0, 10), aliases: existsSync(aliasFile) ? await load(aliasFile) as Record<string, string> : {},
  });
  description = flag === '--workbook' ? 'Research workbook' : 'fictional sample workbook';
} else throw new Error('Use no flag, --sample-workbook, or --workbook <path.xlsx>.');
await seedRows(configuredPilotStore(), rows);
console.log(`Seeded namespace ${process.env.PILOT_NAMESPACE} from the ${description} (${rows.length} records). Existing state was not overwritten.`);
