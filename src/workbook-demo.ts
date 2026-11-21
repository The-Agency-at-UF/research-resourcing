import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configSchema } from './recommendations/models.js';
import { parseWorkbook } from './workbook/parse.js';
import { recommendFromWorkbook, workbookMessage, workbookSettingsSchema } from './workbook/researchers.js';
import { profilesSchema } from './workbook/profiles.js';
import { sampleProfiles, sampleWorkbook } from './workbook/sample.js';

// Usage: npm run workbook -- <path.xlsx | --sample> [request.json] [--profiles <path.json> | --sample-profiles]
const load = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));
const args = process.argv.slice(2), at = args.findIndex(a => a === '--profiles' || a === '--sample-profiles');
const profileArgs = at < 0 ? [] : args.splice(at, args[at] === '--profiles' ? 2 : 1);
if (profileArgs[0] === '--profiles' && !profileArgs[1]) throw new Error('Pass the 1:1 profile file after --profiles.');
// 1:1 profiles hold personal notes' staffing facts; real ones stay in ignored data/private.
const profiles = !profileArgs.length ? undefined : profilesSchema.parse(profileArgs[1] ? await load(profileArgs[1]) : sampleProfiles());
const [source, requestFile = 'fixtures/workbook-request.json'] = args;
if (!source) throw new Error('Pass a downloaded .xlsx path, or --sample for the fictional workbook.');
let workbook = sampleWorkbook();
if (source !== '--sample') { workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(source); }
// Optional grid-name → roster-name corrections; kept in ignored data/private because they contain real names.
const aliasFile = 'data/private/workbook-aliases.json';
const aliases = existsSync(aliasFile) ? await load(aliasFile) as Record<string, string> : {};
const result = recommendFromWorkbook(parseWorkbook(workbook), await load(requestFile) as never,
  configSchema.parse(await load('config/scoring-workbook.json')), workbookSettingsSchema.parse(await load('config/workbook.json')), aliases, profiles);
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/workbook-run.json', JSON.stringify({ createdAt: new Date().toISOString(), source: source === '--sample' ? 'fictional sample' : 'workbook', ...result }, null, 2) + '\n', { mode: 0o600 });
console.log(source === '--sample' ? 'FICTIONAL SAMPLE WORKBOOK' : 'WORKBOOK DATA (local only)');
console.log(workbookMessage(result));
if (result.warnings.length) console.log(`\nImport warnings (${result.warnings.length}):\n- ${result.warnings.join('\n- ')}`);
console.log(`\nExcluded ${result.run.excluded.length}; retained ${result.run.retained.length} of ${result.run.eligibleCount} eligible. Saved artifacts/workbook-run.json.`);
