import type ExcelJS from 'exceljs';

export interface RosterMember { name: string; role: string; graduation: string; hire: string; row: number }
export interface GridMember {
  name: string; section: 'analysts' | 'strategists' | 'new-hires'; graduationDates: string[]; note: string;
  accountCount: number | undefined; accountIds: string[]; row: number;
}
export interface ParsedWorkbook { roster: RosterMember[]; grid: GridMember[]; accounts: Map<string, string>; issues: string[] }

export const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
export const slug = (value: string) => clean(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  if ('result' in value) return text(value.result as ExcelJS.CellValue);
  if ('text' in value) return String(value.text);
  return '';
}
// Excel cell checkboxes are booleans; exported or hand-typed sheets may use glyphs or an x.
const checked = (value: ExcelJS.CellValue) => value === true || /^(true|x|yes|✓|✔|☑|☒)$/i.test(clean(text(value)));
export const cells = (row: ExcelJS.Row) => Array.from({ length: row.cellCount }, (_, i) => clean(text(row.getCell(i + 1).value)));
const sections = [['analysts', /^analysts\b/i], ['strategists', /^strategists\b/i], ['new-hires', /^new hires\b/i], ['exceptions', /^exceptions\b/i]] as const;

/** Read the Research Resourcing workbook by layout, not sheet names: a member roster and a person × account checkbox grid. */
export function parseWorkbook(workbook: ExcelJS.Workbook): ParsedWorkbook {
  const issues: string[] = [], roster: RosterMember[] = [], grid: GridMember[] = [], accounts = new Map<string, string>();
  let rosterFound = false, gridFound = false;
  for (const sheet of workbook.worksheets) {
    let header: Record<string, number> | undefined;
    let section: { name: GridMember['section'] | 'exceptions'; countCol: number; columns: Map<number, string> } | undefined;
    sheet.eachRow((row, rowNumber) => {
      const values = cells(row), first = values[0] ?? '';
      if (!header && values.includes('NAME') && values.includes('ROLE')) {
        header = Object.fromEntries(values.map((v, i) => [v, i]));
        rosterFound = true;
        return;
      }
      if (header) {
        const at = (name: string) => header![name] === undefined ? '' : values[header![name]!] ?? '';
        const name = clean(at('NAME').replace(/\(DM\)/i, '')), role = at('ROLE');
        if (/^hiring numbers/i.test(first)) header = undefined;
        else if (name && /manager|researcher|strategist|analyst/i.test(role)) roster.push({ name, role, graduation: at('GRADUATION'), hire: at('HIRE DATE'), row: rowNumber });
        else if (name && /[a-z]/i.test(role)) issues.push(`${sheet.name} row ${rowNumber}: unrecognized role "${role}"`);
        return;
      }
      const match = sections.find(([, pattern]) => pattern.test(first));
      const countCol = values.findIndex(v => /^# of/i.test(v));
      if (match && countCol > 0) {
        gridFound = true;
        const columns = new Map<number, string>();
        values.forEach((v, i) => { if (i > countCol && v) { const id = slug(v); columns.set(i, id); if (match[0] !== 'exceptions') accounts.set(id, v); } });
        section = { name: match[0], countCol, columns };
        if (match[0] === 'exceptions') issues.push(`${sheet.name} row ${rowNumber}: Exceptions section skipped; its columns are not current accounts`);
        return;
      }
      if (!section || section.name === 'exceptions' || !first) return;
      // "Name (05/2027) [Dept] - note": the name ends at the first parenthesis, bracket, or " - ".
      const cut = first.search(/[([]|\s-\s/), rest = cut < 0 ? '' : first.slice(cut);
      const count = Number(values[section.countCol]);
      grid.push({
        name: clean(cut < 0 ? first : first.slice(0, cut)), section: section.name, row: rowNumber,
        graduationDates: [...rest.matchAll(/\b(\d{1,2})\/(\d{4})\b/g)].map(m => `${m[2]}-${m[1]!.padStart(2, '0')}`),
        note: clean(rest.replace(/\([^)]*\)/g, '')),
        accountCount: values[section.countCol] !== '' && Number.isFinite(count) ? count : undefined,
        accountIds: [...section.columns].filter(([col]) => checked(row.getCell(col + 1).value)).map(([, id]) => id),
      });
    });
  }
  if (!rosterFound) issues.push('No roster sheet found (expected a header row with NAME and ROLE)');
  if (!gridFound) issues.push('No resourcing grid found (expected an "Analysts" or "Strategists" row with a "# of Accounts" column)');
  return { roster, grid, accounts, issues };
}
