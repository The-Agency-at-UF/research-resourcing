import ExcelJS from 'exceljs';
import { ResourcingError } from '../resourcing/models.js';
import { workbookData } from '../resourcing/seed.js';
import { parseWorkbook } from './parse.js';
import { profilesFromWorkbook } from './profiles.js';
import type { WorkbookSettings } from './researchers.js';

/**
 * Turn uploaded .xlsx files into staffing data: one must hold the Research roster and grid; Profiles and Account Industries sheets
 * may sit in the same file or a second one. Aliases are a local-only file, so near-miss names surface as warnings instead.
 */
export async function workbookFromUploads(files: { name: string; data: ArrayBuffer }[], settings: WorkbookSettings, asOf: string) {
  const books = await Promise.all(files.map(async f => {
    const book = new ExcelJS.Workbook();
    try { await book.xlsx.load(f.data); } catch { throw new ResourcingError('invalid', `${f.name} could not be read as an Excel workbook.`); }
    return { name: f.name, book, parsed: parseWorkbook(book) };
  }));
  const main = books.filter(b => b.parsed.roster.length && b.parsed.grid.length);
  if (main.length !== 1) throw new ResourcingError('invalid', main.length ? 'Upload only one Research Resourcing workbook at a time.'
    : 'No file has both the member roster (NAME and ROLE columns) and the resourcing grid ("# of Accounts").');
  const sheets = books.map(b => ({ name: b.name, ...profilesFromWorkbook(b.book, `1:1 profiles (${b.name})`) })).filter(s => s.profiles || s.issues.length);
  if (sheets.filter(s => s.profiles).length > 1) throw new ResourcingError('invalid', 'Profiles sheets were found in more than one file; keep them in one.');
  const profileSheet = sheets.find(s => s.profiles);
  const data = workbookData(main[0]!.parsed, settings, { source: `Slack upload: ${main[0]!.name}`, asOf, ...(profileSheet?.profiles && { profiles: profileSheet.profiles }) });
  data.report.warnings.unshift(...sheets.flatMap(s => s.issues));
  return { ...data, fileNames: books.map(b => b.name) };
}
export type WorkbookUpload = (files: { name: string; data: ArrayBuffer }[], asOf: string) => ReturnType<typeof workbookFromUploads>;
/** Bind the workbook settings for the Slack import. */
export const workbookUpload = (settings: WorkbookSettings): WorkbookUpload => (files, asOf) => workbookFromUploads(files, settings, asOf);
