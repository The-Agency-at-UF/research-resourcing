import ExcelJS from 'exceljs';
import { chmod, readFile } from 'node:fs/promises';
import { profileSheets, profilesSchema } from '../workbook/profiles.js';

// Usage: npm run profiles:sheet -- [profiles.json] [out.xlsx]
// Writes Profiles and Account Industries sheets (empty without a JSON file) to copy into the workbook or upload alongside it.
const [input, output = 'data/private/profiles.xlsx'] = process.argv.slice(2);
const profiles = input ? profilesSchema.parse(JSON.parse(await readFile(input, 'utf8'))) : undefined;
await profileSheets(new ExcelJS.Workbook(), profiles).xlsx.writeFile(output);
await chmod(output, 0o600); // may hold real 1:1 facts
console.log(`Wrote ${output}${profiles ? ` with ${profiles.researchers.length} profiles and ${Object.keys(profiles.accounts).length} tagged accounts` : ' (empty template)'}.`);
