import { z } from 'zod';
import type { ScoringConfig } from '../recommendations/models.js';
import { awayConflicts, recommendForPeriod } from '../resourcing/capacity.js';
import { dateSchema, datedResearcherSchema, type DatedResearcher, type DatedRun } from '../resourcing/models.js';
import { inSlots } from '../resourcing/units.js';
import { clean, slug, type GridMember, type ParsedWorkbook, type RosterMember } from './parse.js';
import { accountIndustries, type Profile, type Profiles } from './profiles.js';

export const workbookSettingsSchema = z.object({
  maxAccounts: z.number().int().positive(),
  // Official term dates ("Spring 2027": [first day of classes, last day of finals]) used to read away terms.
  terms: z.record(z.string(), z.tuple([dateSchema, dateSchema])).default({}),
  // The grid has no assignment dates; checked accounts are assumed to run for this window.
  assignmentStart: dateSchema, assignmentEnd: dateSchema,
}).strict().refine(s => s.assignmentStart <= s.assignmentEnd, 'Invalid assignment window');
export const workbookRequestSchema = z.object({
  accountName: z.string().trim().min(1), role: z.enum(['analyst', 'strategist']), openings: z.number().int().min(1).max(100),
  minimumExperienceYears: z.number().finite().nonnegative().default(0), startDate: dateSchema, endDate: dateSchema,
  tools: z.array(z.string().trim().min(1)).default([]).transform(values => values.map(slug)),
}).strict().refine(r => r.startDate <= r.endDate, { path: ['endDate'], message: 'End date must not precede start date' });
export type WorkbookSettings = z.infer<typeof workbookSettingsSchema>;
export type WorkbookRequest = z.input<typeof workbookRequestSchema>;
type Excluded = DatedRun['excluded'][number];

const key = (name: string) => clean(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '');
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const term = (value: string) => /^(spring|summer|fall)\s+(\d{4})$/i.exec(clean(value));
const graduationDate = (value: string) => { const t = term(value); return t ? `${t[2]}-${{ spring: '05-15', summer: '08-15', fall: '12-15' }[t[1]!.toLowerCase()]}` : undefined; };
const hireDate = (value: string) => { const t = term(value); return t ? `${t[2]}-${{ spring: '01-01', summer: '05-01', fall: '08-01' }[t[1]!.toLowerCase()]}` : undefined; };
const roleTag = (role: string) => /manager/i.test(role) ? 'manager' : /analyst/i.test(role) ? 'analyst' : /strategist|lead researcher/i.test(role) ? 'strategist' : undefined;
// Approximate term spans, wider than any UF term, for terms missing from the configured calendar.
const roughTerm = { spring: ['01-01', '05-15'], summer: ['05-01', '08-15'], fall: ['08-01', '12-20'] } as const;
/** Read one away entry: a configured term, a term outside the calendar (approximate, warned), or an explicit date range. */
function awayPeriod(entry: string, terms: WorkbookSettings['terms']): { from: string; until: string; approximate?: boolean } | undefined {
  const known = Object.entries(terms).find(([name]) => clean(name).toLowerCase() === clean(entry).toLowerCase());
  if (known) return { from: known[1][0], until: known[1][1] };
  const range = /^(\d{4}-\d{2}-\d{2})\s+(?:to|through|–)\s+(\d{4}-\d{2}-\d{2})$/i.exec(clean(entry));
  if (range) return range[1]! <= range[2]! ? { from: range[1]!, until: range[2]! } : undefined;
  const t = term(entry);
  if (!t) return undefined;
  const [from, until] = roughTerm[t[1]!.toLowerCase() as keyof typeof roughTerm];
  return { from: `${t[2]}-${from}`, until: `${t[2]}-${until}`, approximate: true };
}
function distance(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = d[0]!; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]!; d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = t; }
  }
  return d[b.length]!;
}

/**
 * Merge roster and grid into dated researchers. Account slots stand in for hours: each checked account uses one slot.
 * Optional 1:1 profiles add interests, industry experience, tools, and a personal account cap.
 */
export function workbookResearchers(parsed: ParsedWorkbook, settings: WorkbookSettings, asOf: string, aliases: Record<string, string> = {}, profiles?: Profiles) {
  const warnings = [...parsed.issues], excluded: Excluded[] = [], researchers: DatedResearcher[] = [], managers: string[] = [];
  const aliasKeys = new Map(Object.entries(aliases).map(([gridName, rosterName]) => [key(gridName), key(rosterName)]));
  const rosterByKey = new Map(parsed.roster.map(r => [key(r.name), r]));
  const gridByKey = new Map<string, GridMember>();
  for (const g of parsed.grid) {
    const k = aliasKeys.get(key(g.name)) ?? key(g.name);
    if (gridByKey.has(k)) warnings.push(`${g.name} appears more than once on the grid; using the first row`); else gridByKey.set(k, g);
  }
  const profileByKey = new Map<string, Profile>();
  for (const p of profiles?.researchers ?? []) {
    const k = aliasKeys.get(key(p.name)) ?? key(p.name);
    if (profileByKey.has(k)) warnings.push(`1:1 profile for ${p.name} appears more than once; using the first`); else profileByKey.set(k, p);
  }
  const unprofiled: string[] = [];
  const exclude = (name: string, ...reasons: string[]) => excluded.push({ researcherId: slug(name) || name, reasons, dataIssue: true });
  for (const k of new Set([...rosterByKey.keys(), ...gridByKey.keys()])) {
    const r: RosterMember | undefined = rosterByKey.get(k), g = gridByKey.get(k), name = r?.name ?? g!.name;
    const role = r ? roleTag(r.role) : g!.section === 'new-hires' ? undefined : g!.section === 'analysts' ? 'analyst' : 'strategist';
    if (role === 'manager') { managers.push(name); continue; }
    if (!g) { exclude(name, 'Not on the resourcing grid; current account load is unknown'); continue; }
    if (!r) {
      const near = parsed.roster.find(m => distance(key(m.name), k) <= 2);
      if (near) warnings.push(`Grid name "${g.name}" is close to roster name "${near.name}"; add an alias if they are the same person`);
      exclude(name, near ? `Not matched to the roster (possible spelling difference from "${near.name}")` : 'Not on the Research member roster');
      continue;
    }
    if (!role) { exclude(name, `Unrecognized role "${r.role}"`); continue; }
    const hire = hireDate(r.hire);
    if (!hire) { exclude(name, `Hire term missing or unreadable ("${r.hire}"); experience and start of availability are unknown`); continue; }
    // Conflicting graduation dates use the earliest: it can only under-recommend, never overbook.
    const candidates = [...g.graduationDates.map(lastDay), ...(graduationDate(r.graduation) ? [graduationDate(r.graduation)!] : [])].sort();
    if (!candidates.length) { exclude(name, `Graduation date missing ("${r.graduation || 'blank'}")`); continue; }
    if (new Set(candidates.map(d => d.slice(0, 7))).size > 1) warnings.push(`${name}: graduation dates disagree (roster "${r.graduation}", grid ${g.graduationDates.join(', ')}); using ${candidates[0]}`);
    else if (!graduationDate(r.graduation)) warnings.push(`${name}: roster graduation is "${r.graduation}"; using grid date ${candidates[0]}`);
    if (/confirm/i.test(g.note)) warnings.push(`${name}: grid note says "${g.note}"`);
    const load = Math.max(g.accountIds.length, g.accountCount ?? 0);
    if (g.accountCount !== undefined && g.accountCount !== g.accountIds.length) warnings.push(`${name}: "# of Accounts" is ${g.accountCount} but ${g.accountIds.length} boxes are checked; counting ${load}`);
    const accountIds = [...g.accountIds, ...Array.from({ length: load - g.accountIds.length }, (_, i) => `unlisted-${i + 1}`)];
    const profile = profileByKey.get(k), asked = profile?.accountCap;
    if (profiles && !profile) unprofiled.push(name);
    if (asked !== undefined && asked > settings.maxAccounts) warnings.push(`${name}: 1:1 account cap ${asked} is above the department cap of ${settings.maxAccounts}; using ${settings.maxAccounts}`);
    // A cap below current load would read as overbooking; hold it at the current load so no account is added.
    if (asked !== undefined && asked < load) warnings.push(`${name}: asked for at most ${asked} account${asked === 1 ? '' : 's'} at their 1:1 but holds ${load}; no new accounts until one ends`);
    // Like conflicting graduation dates, the earlier end wins: it can only under-recommend.
    const until = profile?.availableUntil && profile.availableUntil < candidates[0]! ? profile.availableUntil : candidates[0]!;
    if (until !== candidates[0]) warnings.push(`${name}: available until ${until} per their 1:1, before graduation`);
    const away = (profile?.away ?? []).map(entry => ({ entry, period: awayPeriod(entry, settings.terms) }));
    const unreadable = away.filter(a => !a.period).map(a => a.entry);
    // An unreadable away entry could hide an absence, so the researcher is held back rather than guessed about.
    if (unreadable.length) { exclude(name, `1:1 away entry unreadable: ${unreadable.map(e => `"${e}"`).join(', ')}; use a term such as "Spring 2027" or "YYYY-MM-DD to YYYY-MM-DD"`); continue; }
    for (const a of away) if (a.period!.approximate) warnings.push(`${name}: away "${a.entry}" is not in the configured term calendar; using ${a.period!.from} to ${a.period!.until}`);
    const cap = asked === undefined ? settings.maxAccounts : Math.min(settings.maxAccounts, Math.max(asked, load));
    const parsedResearcher = datedResearcherSchema.safeParse({
      id: slug(name), name, active: true, weeklyCapacityHours: cap, maxAccounts: cap,
      skills: [role, ...(profile?.tools ?? [])], experienceYears: Math.max(0, Math.round((Date.parse(asOf) - Date.parse(hire)) / 3.15576e9) / 10),
      interests: profile?.interests ?? [], industryExperienceIds: profile?.industryExperience ?? [], availableFrom: hire, availableUntil: until,
      ...(away.length ? { away: away.map(a => ({ from: a.period!.from, until: a.period!.until })) } : {}),
      ...(profile ? { profile: { ...(profile.hoursPerWeek !== undefined && { hoursPerWeek: profile.hoursPerWeek }), ...(asked !== undefined && { accountCap: Math.min(asked, settings.maxAccounts) }) } } : {}),
      assignments: accountIds.map(accountId => ({ id: `${slug(name)}_${accountId}`, accountId, startDate: settings.assignmentStart,
        endDate: settings.assignmentEnd, hoursPerWeek: 1, status: 'active', source: 'workbook' })),
    });
    if (parsedResearcher.success) {
      researchers.push(parsedResearcher.data);
      for (const c of awayConflicts(parsedResearcher.data)) warnings.push(`${name}: on ${parsed.accounts.get(c.accountId) ?? c.accountId} until ${c.assignmentEnd} but away ${c.from} to ${c.until}`);
    }
    else exclude(name, ...parsedResearcher.error.issues.map(i => i.message));
  }
  if (profiles) {
    const matched = new Set([...rosterByKey.keys()]);
    for (const [k, p] of profileByKey) if (!matched.has(k)) warnings.push(`1:1 profile for ${p.name} matches no roster member; add an alias if the name is spelled differently`);
    if (unprofiled.length) warnings.push(`No 1:1 profile for ${unprofiled.join(', ')}; their interests, industries, and tools count as unknown`);
  }
  const tools = [...new Set(researchers.flatMap(r => r.skills.slice(1)))].sort();
  return { researchers, excluded, warnings, managers, tools };
}

/** Industry tags for an account: the first is the primary industry compared with researchers' industry experience. */
export function requestIndustries(accountId: string, profiles?: Profiles) {
  const industries = accountIndustries(profiles).get(accountId) ?? [];
  return { careerInterests: industries, ...(industries[0] ? { industryId: industries[0] } : {}) };
}

/** Rank workbook researchers for a role-based request, reporting capacity in account slots. */
export function recommendFromWorkbook(parsed: ParsedWorkbook, rawRequest: WorkbookRequest, config: ScoringConfig, settings: WorkbookSettings,
  aliases?: Record<string, string>, profiles?: Profiles) {
  const request = workbookRequestSchema.parse(rawRequest);
  const { researchers, excluded, warnings, managers } = workbookResearchers(parsed, settings, request.startDate, aliases, profiles);
  const accountId = slug(request.accountName), industries = requestIndustries(accountId, profiles);
  if (!parsed.accounts.has(accountId)) warnings.push(`"${request.accountName}" is not a column on the grid; existing assignments to it cannot be detected`);
  if (profiles && !industries.industryId) warnings.push(`"${request.accountName}" has no industry tags in the 1:1 profile file; interests and industry are not scored`);
  const run = inSlots(recommendForPeriod(researchers, { accountId, accountName: request.accountName, hoursPerResearcher: 1, openings: request.openings,
    requiredSkills: [request.role], preferredSkills: request.tools, minimumExperienceYears: request.minimumExperienceYears, ...industries,
    startDate: request.startDate, endDate: request.endDate }, config), settings.maxAccounts);
  const runWarnings = excluded.length ? [`${excluded.length} workbook record(s) excluded for missing or conflicting data; review the import warnings.`, ...run.warnings] : run.warnings;
  return { run: { ...run, warnings: runWarnings, excluded: [...excluded, ...run.excluded] }, warnings, managers };
}

export function workbookMessage(result: ReturnType<typeof recommendFromWorkbook>) {
  const { run } = result, lines = [`Staffing recommendations: ${run.request.accountName}`,
    `${run.request.openings} ${run.request.requiredSkills[0]} opening(s), ${run.request.startDate} to ${run.request.endDate}.`];
  if (run.status === 'no_eligible') lines.push('No eligible researcher. Review account load, roles, availability, and data issues.');
  for (const r of run.displayed) lines.push(`${r.rank}. ${r.name} - fit score ${r.score.toFixed(1)}/100\n   ${r.explanation}`);
  for (const warning of run.warnings) lines.push(`Attention: ${warning}`);
  lines.push('Recommendations only. A department manager must approve selections before anyone is assigned.');
  return lines.join('\n\n');
}
