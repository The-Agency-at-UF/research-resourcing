import type ExcelJS from 'exceljs';
import { z } from 'zod';
import { dateSchema } from '../resourcing/models.js';
import { cells, slug } from './parse.js';

const tags = z.array(z.string().trim().min(1)).default([]).transform(values => [...new Set(values.map(slug).filter(Boolean))]);

/**
 * Staffing facts taken from researcher 1:1s, kept in ignored data/private because the source notes are personal.
 * Only these fields are imported; the notes themselves are never imported.
 */
export const profilesSchema = z.object({
  source: z.string().trim().min(1),
  // Account name (as on the grid) → industry tags compared with researcher interests and industry experience.
  accounts: z.record(z.string().trim().min(1), tags).default({}),
  researchers: z.array(z.object({
    name: z.string().trim().min(1),
    hoursPerWeek: z.number().finite().nonnegative().optional(),
    // The most accounts the researcher asked to hold; lower than the department cap when they said they are at capacity.
    accountCap: z.number().int().positive().optional(),
    // Last day they can work, when a 1:1 says they leave or study away before graduating.
    availableUntil: dateSchema.optional(),
    // Terms ("Spring 2027") or ranges ("2027-01-11 to 2027-04-30") away and then returning.
    away: z.array(z.string().trim().min(1)).default([]),
    interests: tags, industryExperience: tags, tools: tags,
  }).strict()),
}).strict();
export type Profiles = z.infer<typeof profilesSchema>;
export type Profile = Profiles['researchers'][number];

export const accountIndustries = (profiles: Profiles | undefined) =>
  new Map(Object.entries(profiles?.accounts ?? {}).map(([name, industries]) => [slug(name), industries]));

/** Column headers of the optional Profiles and Account Industries sheets; list cells are comma-separated. */
export const PROFILE_COLUMNS = ['NAME', 'HOURS PER WEEK', 'ACCOUNT CAP', 'AVAILABLE UNTIL', 'AWAY', 'INTERESTS', 'INDUSTRY EXPERIENCE', 'TOOLS'] as const;
export const INDUSTRY_COLUMNS = ['ACCOUNT', 'INDUSTRIES'] as const;
const list = (value: string) => value.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);

/**
 * Read 1:1 profiles kept as sheets (a "NAME … TOOLS" header and an "ACCOUNT, INDUSTRIES" header), found by header like the
 * roster. Invalid rows are reported and skipped rather than guessed. Returns no profiles when neither sheet exists.
 */
export function profilesFromWorkbook(workbook: ExcelJS.Workbook, source: string): { profiles?: Profiles; issues: string[] } {
  const issues: string[] = [], researchers: unknown[] = [], accounts: Record<string, string[]> = {};
  let found = false;
  for (const sheet of workbook.worksheets) {
    let header: Map<string, number> | undefined, kind: 'profiles' | 'industries' | undefined;
    sheet.eachRow((row, rowNumber) => {
      const values = cells(row).map(v => v.toUpperCase());
      if (!header) {
        kind = values.includes('NAME') && values.includes('TOOLS') && !values.includes('ROLE') ? 'profiles'
          : values.includes('ACCOUNT') && values.includes('INDUSTRIES') ? 'industries' : undefined;
        if (kind) { header = new Map(values.map((v, i) => [v, i])); found = true; }
        return;
      }
      const raw = cells(row), at = (name: string) => header!.has(name) ? raw[header!.get(name)!] ?? '' : '';
      if (kind === 'industries') { if (at('ACCOUNT')) accounts[at('ACCOUNT')] = list(at('INDUSTRIES')); return; }
      if (!at('NAME')) return;
      const number = (name: string) => at(name) === '' ? undefined : Number(at(name));
      const parsed = profilesSchema.shape.researchers.element.safeParse({
        name: at('NAME'), away: list(at('AWAY')), interests: list(at('INTERESTS')), industryExperience: list(at('INDUSTRY EXPERIENCE')), tools: list(at('TOOLS')),
        ...(number('HOURS PER WEEK') !== undefined && { hoursPerWeek: number('HOURS PER WEEK') }),
        ...(number('ACCOUNT CAP') !== undefined && { accountCap: number('ACCOUNT CAP') }),
        ...(at('AVAILABLE UNTIL') && { availableUntil: at('AVAILABLE UNTIL').slice(0, 10) }),
      });
      if (parsed.success) researchers.push(parsed.data);
      else issues.push(`${sheet.name} row ${rowNumber}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}; profile skipped`);
    });
  }
  return found ? { profiles: profilesSchema.parse({ source, accounts, researchers }), issues } : { issues };
}

/** The same sheets, for keeping profiles in the workbook (or a separate file) instead of JSON. */
export function profileSheets(workbook: ExcelJS.Workbook, profiles?: Profiles) {
  workbook.addWorksheet('Profiles').addRows([[...PROFILE_COLUMNS], ...(profiles?.researchers ?? []).map(p => [p.name, p.hoursPerWeek ?? '', p.accountCap ?? '',
    p.availableUntil ?? '', p.away.join('; '), p.interests.join(', '), p.industryExperience.join(', '), p.tools.join(', ')])]);
  workbook.addWorksheet('Account Industries').addRows([[...INDUSTRY_COLUMNS], ...Object.entries(profiles?.accounts ?? {}).map(([name, tags]) => [name, tags.join(', ')])]);
  return workbook;
}
