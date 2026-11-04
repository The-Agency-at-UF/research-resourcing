import { randomUUID } from 'node:crypto';
import type { App, types, ViewOutput } from '@slack/bolt';
import { datedRequestSchema, PilotError, type Account, type Actor, type DatedRequest, type ImportReport, type Review, type RunState } from '../pilot/models.js';
import { metricsText, resourcingText } from '../pilot/reports.js';
import type { PilotService } from '../pilot/service.js';
import { amount, HOURS, type CapacityUnits } from '../pilot/units.js';
import type { ScoringConfig } from '../recommendations/models.js';
import type { WorkbookUpload } from '../workbook/upload.js';

export interface PilotOptions {
  /** Slack user or channel IDs told about approved and changed assignments (operations managers). */
  notify?: string[];
  /** Channel holding the Resourcing HQ message, edited after each change. */
  hqChannel?: string;
  /** False once real workbook data is seeded; changes the label on every screen. */
  fictional?: boolean;
  log?: (message: string) => void;
  /**
   * Workbook uploads (`/resource-pilot import`), injected so the receiver bundle never loads the Excel parser. The scoring policy
   * is used only to initialize an empty namespace.
   */
  workbook?: { read: WorkbookUpload; maxAccounts: number; config: ScoringConfig };
  /** Test hook; by default files are fetched from files.slack.com with the bot token. */
  download?: (url: string) => Promise<ArrayBuffer>;
}
const text = (value: string) => ({ type: 'plain_text' as const, text: value.slice(0, 2900) });
const section = (value: string) => ({ type: 'section' as const, text: text(value) });
/** Split long text into section blocks under Slack's per-block limit. */
const sections = (value: string) => {
  const out: string[] = []; let current = '';
  for (const line of value.split('\n')) {
    if (current && (current + '\n' + line).length > 2900) { out.push(current); current = line; } else current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out.slice(0, 90).map(section);
};
const label = (fictional: boolean) => fictional ? 'FICTIONAL DATA PILOT' : 'STAFFING PILOT';
const notice = (fictional: boolean) => section(fictional ? 'FICTIONAL DATA PILOT — test assignments are stored in DynamoDB.'
  : 'STAFFING PILOT — workbook data; assignments are stored in DynamoDB only and are not written back to Excel.');
const modal = (title: string, blocks: types.ModalView['blocks'], callback?: string, metadata = '{}', fictional = true): types.ModalView => ({
  type: 'modal', title: text(title), close: text('Close'), blocks: [notice(fictional), ...blocks],
  ...(callback ? { callback_id: callback, private_metadata: metadata, submit: text('Continue') } : {}),
});
export const PILOT_REQUEST = 'resource_pilot_request', PILOT_SELECT = 'resource_pilot_select', PILOT_CONFIRM = 'resource_pilot_confirm',
  PILOT_RESUME = 'resource_pilot_resume', PILOT_CHANGE = 'resource_pilot_change', PILOT_IMPORT = 'resource_pilot_import', PILOT_IMPORT_APPLY = 'resource_pilot_import_apply';
const MAX_UPLOAD = 10 * 1024 * 1024;
const metadata = (view: { private_metadata: string }): Record<string, string | number> => {
  try { const value = JSON.parse(view.private_metadata); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new PilotError('invalid', 'Invalid form. Reopen /resource-pilot.'); }
};
const field = (values: ViewOutput['state']['values'], name: string) => values[name]?.value;
const ref = (meta: Record<string, string | number>, name: string) => {
  const value = meta[name]; if (typeof value !== 'string') throw new PilotError('invalid', 'Invalid form reference. Reopen /resource-pilot.'); return value;
};
const select = (blockId: string, label: string, options: { text: string; value: string }[], optional = false) => ({
  type: 'input' as const, block_id: blockId, label: text(label), optional,
  element: { type: 'static_select' as const, action_id: 'value', options: options.slice(0, 100).map(o => ({ text: text(o.text.slice(0, 75)), value: o.value })) },
});
const datepicker = (blockId: string, label: string, optional = false) => ({ type: 'input' as const, block_id: blockId, label: text(label), optional, element: { type: 'datepicker' as const, action_id: 'value' } });
const plainInput = (blockId: string, label: string, initial: string, max: number, optional = false) => ({
  type: 'input' as const, block_id: blockId, label: text(label), optional, element: { type: 'plain_text_input' as const, action_id: 'value', initial_value: initial, max_length: max },
});
const issueCount = (report?: ImportReport) => (report?.warnings.length ?? 0) + (report?.excluded.length ?? 0);

/** "N strategists or analysts for account X, from date to date." */
export function pilotRequestModal(accounts: Account[], requestId: string = randomUUID(), issues = 0, fictional = true, tools: string[] = []): types.ModalView {
  if (!accounts.length) return modal('Pilot staffing request', [section('No accounts are configured in this pilot namespace.')], undefined, '{}', fictional);
  return modal('Pilot staffing request', [
    ...(issues ? [section(`${issues} workbook import issue(s) may affect these recommendations. Review them with /resource-pilot issues.`)] : []),
    select('accountId', 'Account', [...accounts].sort((a, b) => a.name.localeCompare(b.name)).map(a => ({ text: a.name, value: a.id }))),
    select('role', 'Role needed', [{ text: 'Strategist', value: 'strategist' }, { text: 'Analyst', value: 'analyst' }]),
    plainInput('openings', 'Number of openings', '1', 2),
    datepicker('startDate', 'Start date (inclusive)'), datepicker('endDate', 'End date (inclusive)'),
    plainInput('minimumExperienceYears', 'Minimum years since hire', '0', 4, true),
    // Tools come from imported 1:1 profiles; they rank candidates and never exclude anyone.
    ...(tools.length ? [{ type: 'input' as const, block_id: 'tools', optional: true, label: text('Helpful tools (ranks, never excludes)'), element: {
      type: 'multi_static_select' as const, action_id: 'value', max_selected_items: 5, options: tools.slice(0, 100).map(t => ({ text: text(t.slice(0, 75)), value: t })) } }] : []),
  ], PILOT_REQUEST, JSON.stringify({ requestId }), fictional);
}
export function parsePilotForm(values: ViewOutput['state']['values']): { ok: true; request: DatedRequest } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const accountId = field(values, 'accountId')?.selected_option?.value ?? '', role = field(values, 'role')?.selected_option?.value ?? '';
  const openingsText = (field(values, 'openings')?.value ?? '').trim(), experienceText = (field(values, 'minimumExperienceYears')?.value ?? '').trim() || '0';
  const openings = /^\d+$/.test(openingsText) ? Number(openingsText) : NaN, minimumExperienceYears = /^\d+(?:\.\d+)?$/.test(experienceText) ? Number(experienceText) : NaN;
  if (!accountId) errors.accountId = 'Choose an account.';
  if (role !== 'analyst' && role !== 'strategist') errors.role = 'Choose strategist or analyst.';
  if (!(openings >= 1 && openings <= 20)) errors.openings = 'Enter a whole number from 1 to 20.';
  if (!Number.isFinite(minimumExperienceYears)) errors.minimumExperienceYears = 'Enter zero or a positive number of years.';
  if (Object.keys(errors).length) return { ok: false, errors };
  // One capacity unit per opening: an account slot for workbook data.
  const preferredSkills = (field(values, 'tools')?.selected_options ?? []).map(o => o.value).slice(0, 5);
  const dated = datedRequestSchema.safeParse({ accountId, accountName: 'Selected account', hoursPerResearcher: 1, openings, requiredSkills: [role],
    preferredSkills, minimumExperienceYears, careerInterests: [],
    startDate: field(values, 'startDate')?.selected_date ?? '', endDate: field(values, 'endDate')?.selected_date ?? '' });
  if (!dated.success) return { ok: false, errors: Object.fromEntries(dated.error.issues.map(i => [String(i.path[0]), i.message])) };
  return { ok: true, request: dated.data };
}
export function selectionModal(requestId: string, runId: string, record: RunState, requestVersion: number, fictional = true) {
  const run = record.run;
  const blocks: types.ModalView['blocks'] = [section(`${run.request.accountName}\n${run.request.startDate} to ${run.request.endDate}\nRole: ${run.request.requiredSkills.join(', ')}; ${run.request.openings} opening(s) remain.${run.request.careerInterests.length ? `\nIndustry: ${run.request.careerInterests.join(', ')}` : ''}${run.request.preferredSkills.length ? `\nHelpful tools: ${run.request.preferredSkills.join(', ')}` : ''}\nRequest: ${requestId}`),
    ...run.displayed.map(r => section(`${r.rank}. ${r.name} — ${r.score.toFixed(1)}\n${r.explanation}`)), ...run.warnings.map(section)];
  if (run.excluded.length) blocks.push(...sections(`Exclusions:\n${run.excluded.map(e => `${e.researcherId}: ${e.reasons.join('; ')}`).join('\n')}`));
  blocks.push({ type: 'input', block_id: 'decision', label: text('Decision'), element: { type: 'static_select', action_id: 'value', initial_option: { text: text('Review candidate selection'), value: 'approve' }, options: [
    { text: text('Review candidate selection'), value: 'approve' }, { text: text('Decline remaining openings'), value: 'decline' },
  ] } });
  if (run.retained.length) blocks.push({ type: 'input', block_id: 'candidates', optional: true, label: text('Select from the retained shortlist'), element: {
    type: 'multi_static_select', action_id: 'value', max_selected_items: Math.min(5, run.request.openings, run.retained.length),
    options: run.retained.map(r => ({ text: text(`${r.rank}. ${r.name} — ${r.score.toFixed(1)}`.slice(0, 75)), value: r.researcherId })),
  } });
  return modal('Pilot recommendations', blocks, PILOT_SELECT, JSON.stringify({ requestId, runId, requestVersion }), fictional);
}
export function confirmationModal(approvalId: string, review: Review, request: DatedRequest, units: CapacityUnits = HOURS, fictional = true) {
  return { ...modal('Confirm test assignments', [section(`${request.accountName}\n${request.startDate} to ${request.endDate}, inclusive\nRole: ${request.requiredSkills.join(', ')}`),
    ...review.summaries.map(s => section(`${s.name}\nAt least ${amount(units, s.hoursAfterAssignment)} remain after assignment.`)),
    section('Availability will be checked again when you confirm. Nothing has been reserved yet.'),
  ], PILOT_CONFIRM, JSON.stringify({ approvalId, requestId: review.requestId }), fictional), submit: text('Approve batch') };
}
type AssignmentOption = Awaited<ReturnType<PilotService['activeAssignments']>>[number];
export function changeModal(assignments: AssignmentOption[], fictional = true) {
  if (!assignments.length) return modal('Assignments', [section('No active or upcoming assignments.')], undefined, '{}', fictional);
  return modal('Change an assignment', [
    select('assignment', 'Assignment', assignments.map(a => ({ text: `${a.name} — ${a.accountName} (${a.startDate}–${a.endDate})`, value: `${a.researcherId}#${a.index}` }))),
    select('change', 'Change', [{ text: 'Cancel this assignment', value: 'cancel' }, { text: 'Change its dates', value: 'reschedule' }]),
    datepicker('newStart', 'New start date (when changing dates)', true), datepicker('newEnd', 'New end date (when changing dates)', true),
    section('Cancelling an approved assignment reopens that opening on its request. New dates are checked against capacity first.'),
  ], PILOT_CHANGE, '{}', fictional);
}
export function issuesModal(report: ImportReport | undefined, fictional = true) {
  if (!report || !issueCount(report)) return modal('Workbook import issues', [section(report ? `No issues recorded for ${report.source} (imported ${report.importedAt}).` : 'No workbook import is recorded in this pilot namespace.')], undefined, '{}', fictional);
  return modal('Workbook import issues', sections([
    `Source: ${report.source}, imported ${report.importedAt}. Correct the workbook and upload it again with /resource-pilot import to clear these.`,
    report.excluded.length ? `\nExcluded from recommendations (${report.excluded.length}):\n${report.excluded.map(e => `- ${e.researcherId}: ${e.reasons.join('; ')}`).join('\n')}` : '',
    report.warnings.length ? `\nWarnings (${report.warnings.length}):\n${report.warnings.map(w => `- ${w}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')), undefined, '{}', fictional);
}
export function importModal(fictional = true) {
  return modal('Update from workbook', [
    section('Upload the Research Resourcing workbook (.xlsx). Profiles and Account Industries sheets are optional and may be in the same file or a second one. You will see every change before anything is saved.'),
    { type: 'input', block_id: 'files', label: text('Workbook files'), element: { type: 'file_input', action_id: 'value', filetypes: ['xlsx'], max_files: 2 } },
    section('Pilot approvals and assignment changes made in Slack are kept. Upload only staffing data: never 1:1 notes.'),
  ], PILOT_IMPORT, '{}', fictional);
}
export function importPreviewModal(preview: { draftId: string; hash: string; lines: string[]; initial: boolean }, fictional = true, note?: string) {
  return { ...modal('Review workbook update', [...(note ? [section(note)] : []), ...sections(preview.lines.join('\n')),
    section(preview.initial ? 'Initializing writes every record above. Nothing is saved until you apply.' : 'Nothing is saved until you apply. If the pilot changes first, you will see an updated preview.'),
  ], PILOT_IMPORT_APPLY, JSON.stringify({ draftId: preview.draftId, hash: preview.hash }), fictional), submit: text(preview.initial ? 'Initialize pilot' : 'Apply update') };
}
type Upload = { name: string; url_private_download?: string; size?: number; filetype?: string };
function uploadErrors(values: ViewOutput['state']['values']) {
  const files = (field(values, 'files') as { files?: Upload[] } | undefined)?.files ?? [];
  if (!files.length) return { files: 'Upload the workbook.' };
  if (files.some(f => !/\.xlsx$/i.test(f.name))) return { files: 'Upload .xlsx files only.' };
  if (files.some(f => (f.size ?? 0) > MAX_UPLOAD)) return { files: 'Each file must be under 10 MB.' };
  return undefined;
}
/** Only Slack's file host receives the bot token; a login page instead of a workbook means the files:read scope is missing. */
async function slackDownload(url: string, token: string | undefined): Promise<ArrayBuffer> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'files.slack.com') throw new PilotError('invalid', 'The upload did not come from Slack file storage.');
  if (!token) throw new PilotError('invalid', 'The bot token is not available to download the upload.');
  const response = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) throw new PilotError('invalid', 'Slack did not return the file. The app needs the files:read scope; reinstall it after updating the manifest.');
  const data = await response.arrayBuffer();
  if (data.byteLength > MAX_UPLOAD) throw new PilotError('invalid', 'Each file must be under 10 MB.');
  return data;
}
const help = ['/resource-pilot — new staffing request (role, openings, dates)', '/resource-pilot list — resume a saved request', '/resource-pilot <request-id> — open a request',
  '/resource-pilot assignments — cancel or change an assignment', '/resource-pilot hq — current resourcing view', '/resource-pilot issues — workbook import problems',
  '/resource-pilot metrics — pilot measures', '/resource-pilot import — update from an uploaded workbook (preview first)'].join('\n');

/** The slow half of a pilot interaction: runs inline under Socket Mode, or in the worker Lambda when hosted. Plain JSON. */
export type PilotJob =
  | { kind: 'command'; teamId: string; userId: string; text: string; viewId: string }
  | { kind: 'view'; callback: string; teamId: string; userId: string; viewId: string; privateMetadata: string; values: ViewOutput['state']['values'] };
type SlackCalls = Pick<App['client'], 'views' | 'chat'> & { token?: string | undefined };
const loading: Record<string, string> = { [PILOT_REQUEST]: 'Loading dated recommendations…', [PILOT_RESUME]: 'Loading saved request…',
  [PILOT_SELECT]: 'Checking current availability…', [PILOT_CONFIRM]: 'Rechecking and saving your decision…', [PILOT_CHANGE]: 'Checking and saving the change…',
  [PILOT_IMPORT]: 'Reading the workbook and comparing it with the pilot…', [PILOT_IMPORT_APPLY]: 'Rechecking and applying the update…' };
function changeErrors(values: ViewOutput['state']['values']) {
  const errors: Record<string, string> = {}, kind = field(values, 'change')?.selected_option?.value;
  if (!/^(.+)#(\d+)$/.test(field(values, 'assignment')?.selected_option?.value ?? '')) errors.assignment = 'Choose an assignment.';
  if (kind !== 'cancel' && kind !== 'reschedule') errors.change = 'Choose what to change.';
  if (kind === 'reschedule' && !field(values, 'newStart')?.selected_date) errors.newStart = 'Choose the new start date.';
  if (kind === 'reschedule' && !field(values, 'newEnd')?.selected_date) errors.newEnd = 'Choose the new end date.';
  return Object.keys(errors).length ? errors : undefined;
}

/** Register fast handlers: acknowledge within Slack's deadline, show a loading view, then hand the rest to `dispatch` (inline by default). */
export function registerPilotHandlers(app: Pick<App, 'command' | 'view'>, service?: PilotService, options: PilotOptions = {}, dispatch?: (job: PilotJob) => Promise<void>) {
  const fictional = options.fictional ?? true, log = options.log ?? ((message: string) => console.error(message));
  const send = async (client: SlackCalls, job: PilotJob) => {
    try { await (dispatch ?? (j => runPilotJob(j, client, service, options)))(job); }
    catch (error) {
      log(`Pilot job dispatch failed: ${(error as Error).message}`);
      await client.views.update({ view_id: job.viewId, view: modal('Pilot action stopped', [section('The action could not be started. Nothing was saved. Try again shortly.')], undefined, '{}', fictional) });
    }
  };
  app.command('/resource-pilot', async ({ command, ack, client }) => {
    await ack();
    const opened = await client.views.open({ trigger_id: command.trigger_id, view: modal('Staffing pilot', [section('Loading pilot access…')], undefined, '{}', fictional) });
    if (opened.view?.id) await send(client, { kind: 'command', teamId: command.team_id, userId: command.user_id, text: command.text, viewId: opened.view.id });
  });
  const validators: Record<string, (values: ViewOutput['state']['values']) => Record<string, string> | undefined> = {
    [PILOT_REQUEST]: values => { const parsed = parsePilotForm(values); return parsed.ok ? undefined : parsed.errors; }, [PILOT_CHANGE]: changeErrors,
    [PILOT_IMPORT]: uploadErrors,
  };
  for (const callback of [PILOT_REQUEST, PILOT_RESUME, PILOT_SELECT, PILOT_CONFIRM, PILOT_CHANGE, PILOT_IMPORT, PILOT_IMPORT_APPLY]) {
    app.view(callback, async ({ body, view: submitted, ack, client }) => {
      const errors = validators[callback]?.(submitted.state.values);
      if (errors) { await ack({ response_action: 'errors', errors }); return; }
      await ack({ response_action: 'update', view: modal('Staffing pilot', [section(loading[callback]!)], undefined, '{}', fictional) });
      await send(client, { kind: 'view', callback, teamId: body.team?.id ?? '', userId: body.user.id, viewId: submitted.id, privateMetadata: submitted.private_metadata, values: submitted.state.values });
    });
  }
}

/** Do the database work for one interaction, replace the loading view with the result, then send notices and refresh HQ. */
export async function runPilotJob(job: PilotJob, client: SlackCalls, service: PilotService | undefined, options: PilotOptions = {}) {
  const fictional = options.fictional ?? true, log = options.log ?? ((message: string) => console.error(message));
  const view = (title: string, blocks: types.ModalView['blocks'], callback?: string, meta = '{}') => modal(title, blocks, callback, meta, fictional);
  const needed = () => { if (!service) throw new PilotError('invalid', 'The DynamoDB pilot is not configured.'); return service; };
  const failure = (error: unknown, requestId?: string) => view('Pilot action stopped', [section(error instanceof PilotError ? error.message : 'The action could not complete. Retry shortly. No success is being reported.'),
    ...(requestId ? [section(`Run /resource-pilot ${requestId} to reload this request. A repeated confirmation is safe if its first response was lost.`)] : [])]);
  const who: Actor = { teamId: job.teamId, userId: job.userId };
  // Notices and the HQ message follow a committed change; their failures are logged and never undo or misreport the change.
  const announce = async (message: string) => {
    for (const target of options.notify ?? []) {
      try { await client.chat.postMessage({ channel: target, text: message }); }
      catch (error) { log(`Pilot notice to ${target} failed: ${(error as { data?: { error?: string } }).data?.error ?? (error as Error).message}`); }
    }
  };
  const refreshHq = async () => {
    if (!options.hqChannel || !service) return;
    try {
      const message = resourcingText(await service.snapshot(), service.today(), service.units, label(fictional)), row = await service.hqLocation();
      if (row?.data.channel === options.hqChannel) {
        try { await client.chat.update({ channel: row.data.channel, ts: row.data.ts, text: message }); return; }
        catch (error) { if ((error as { data?: { error?: string } }).data?.error !== 'message_not_found') throw error; }
      }
      const posted = await client.chat.postMessage({ channel: options.hqChannel, text: message });
      if (posted.ts) await service.saveHqLocation({ channel: options.hqChannel, ts: posted.ts }, row);
    } catch (error) { log(`Resourcing HQ update failed: ${(error as { data?: { error?: string } }).data?.error ?? (error as Error).message}`); }
  };
  const showRecommendations = async (requestId: string) => {
    const s = needed(), state = await s.request(who, requestId);
    if (state.data.status === 'filled' || state.data.status === 'declined') return view('Saved pilot request', [section(`${state.data.request.accountName}\n${state.data.request.startDate} to ${state.data.request.endDate}\nStatus: ${state.data.status}\nApproved researchers: ${state.data.filledResearcherIds.join(', ') || 'None'}\nRequest: ${requestId}`)]);
    const result = await s.recommendations(who, requestId), current = await s.request(who, requestId);
    return selectionModal(requestId, result.runId, result, current.version, fictional);
  };
  let result: types.ModalView, requestId: string | undefined, after: (() => Promise<void>) | undefined;
  try {
    const s = needed();
    if (job.kind === 'command') {
      const action = job.text.trim(), keyword = action.toLowerCase();
      // Import may initialize an empty namespace, which has no manager rows yet; it checks access itself.
      if (keyword === 'import') await s.importAllowed(who); else await s.authorize(who);
      if (keyword === 'import') result = importModal(fictional);
      else if (!action) { const report = await s.importReport(who); result = pilotRequestModal(await s.accounts(who), undefined, issueCount(report), fictional, report?.tools); }
      else if (keyword === 'help') result = view('Staffing pilot help', sections(help));
      else if (keyword === 'hq') result = view('Resourcing HQ', sections(resourcingText(await s.roster(who), s.today(), s.units, label(fictional))));
      else if (keyword === 'issues') result = issuesModal(await s.importReport(who), fictional);
      else if (keyword === 'metrics') result = view('Pilot metrics', sections(metricsText(await s.metrics(who), s.today())));
      else if (keyword === 'assignments') result = changeModal(await s.activeAssignments(who), fictional);
      else if (keyword === 'list') {
        const requests = await s.requests(who);
        result = requests.length ? view('Resume pilot request', [{ type: 'input', block_id: 'request', label: text('Request'), element: { type: 'static_select', action_id: 'value', options: requests.slice(-100).map(r => ({
          text: text(`${r.data.request.accountName} (${r.data.status}) ${r.key.slice(8, 16)}`.slice(0, 75)), value: r.key.slice(8),
        })) } }], PILOT_RESUME) : view('Pilot requests', [section('No requests yet. Run /resource-pilot to create one.')]);
      } else result = await showRecommendations(action);
    } else {
      const meta = () => metadata({ private_metadata: job.privateMetadata }), values = job.values;
      if (job.callback === PILOT_REQUEST) {
        const parsed = parsePilotForm(values);
        if (!parsed.ok) throw new PilotError('invalid', 'The request form was incomplete. Reopen /resource-pilot.');
        requestId = ref(meta(), 'requestId');
        const account = (await s.accounts(who)).find(a => a.id === parsed.request.accountId);
        if (!account) throw new PilotError('invalid', 'Choose a configured account.');
        // The account's industry tags (from the 1:1 profile file) score interests; the first is the primary industry.
        const industries = account.industries ?? [];
        await s.createRequest(who, { ...parsed.request, accountName: account.name, careerInterests: industries, ...(industries[0] && { industryId: industries[0] }) }, requestId);
        result = await showRecommendations(requestId);
      } else if (job.callback === PILOT_RESUME) {
        result = await showRecommendations(field(values, 'request')?.selected_option?.value ?? '');
      } else if (job.callback === PILOT_SELECT) {
        const m = meta(); requestId = ref(m, 'requestId');
        await s.authorize(who);
        if (field(values, 'decision')?.selected_option?.value === 'decline') {
          const state = await s.request(who, requestId);
          if (state.version !== m.requestVersion) throw new PilotError('stale', 'The request changed. Reload it before declining.');
          result = { ...view('Confirm decline', [section(`Decline the remaining openings for ${state.data.request.accountName}? Existing approved assignments will stay in place.`)], PILOT_CONFIRM,
            JSON.stringify({ requestId, declineVersion: state.version })), submit: text('Decline openings') };
        } else {
          const prepared = await s.prepareApproval(who, requestId, ref(m, 'runId'), field(values, 'candidates')?.selected_options?.map(o => o.value) ?? []);
          result = confirmationModal(prepared.approvalId, prepared.review, prepared.request, s.units, fictional);
        }
      } else if (job.callback === PILOT_CONFIRM) {
        const m = meta(); requestId = ref(m, 'requestId');
        if (typeof m.declineVersion === 'number') {
          await s.decline(who, requestId, m.declineVersion);
          result = view('Pilot request declined', [section('Remaining openings declined. Existing approved assignments are unchanged.')]);
        } else {
          const approval = await s.approve(who, ref(m, 'approvalId'));
          result = view('Assignments saved', [section(`${fictional ? 'Test assignments' : 'Assignments'} saved in DynamoDB.\nResearchers: ${approval.researcherIds.join(', ')}\nApproval: ${approval.id}\nRequest: ${approval.requestId}`), section(`Run /resource-pilot ${approval.requestId} to continue, or /resource-pilot list to inspect saved requests.`)]);
          after = async () => {
            if (await s.claimNotice(approval.id)) {
              const summary = await s.approvalSummary(who, approval.id);
              await announce(`${label(fictional)}: ${summary.request.accountName} — ${summary.names.join(', ')} approved as ${summary.request.requiredSkills.join(', ')} for ${summary.request.startDate} to ${summary.request.endDate} by <@${who.userId}>. Request ${approval.requestId} is ${summary.status}.`);
            }
            await refreshHq();
          };
        }
      } else if (job.callback === PILOT_CHANGE) {
        if (changeErrors(values)) throw new PilotError('invalid', 'The change form was incomplete. Reopen /resource-pilot assignments.');
        const selected = /^(.+)#(\d+)$/.exec(field(values, 'assignment')!.selected_option!.value)!, kind = field(values, 'change')?.selected_option?.value;
        const done = await s.changeAssignment(who, selected[1]!, Number(selected[2]), kind === 'cancel' ? { action: 'cancel' }
          : { action: 'reschedule', startDate: field(values, 'newStart')!.selected_date!, endDate: field(values, 'newEnd')!.selected_date! });
        const what = done.change.action === 'cancel' ? `cancelled (was ${done.change.before.startDate} to ${done.change.before.endDate})`
          : `moved from ${done.change.before.startDate}–${done.change.before.endDate} to ${done.change.after.startDate}–${done.change.after.endDate}`;
        result = view('Assignment updated', [section(`${done.researcherName} on ${done.accountName}: ${what}.${done.reopenedRequest ? `\nThe opening on request ${done.change.requestId} is open again.` : ''}`)]);
        after = async () => { await announce(`${label(fictional)}: ${done.researcherName} on ${done.accountName} ${what} by <@${who.userId}>.`); await refreshHq(); };
      } else if (job.callback === PILOT_IMPORT) {
        if (uploadErrors(values) || !options.workbook) throw new PilotError('invalid', options.workbook ? 'The upload form was incomplete. Reopen /resource-pilot import.' : 'Workbook import is not configured for this app.');
        const files = (field(values, 'files') as { files: Upload[] }).files, { read, maxAccounts, config } = options.workbook;
        const data = await Promise.all(files.map(async f => ({ name: f.name,
          data: await (options.download ?? (url => slackDownload(url, client.token)))(f.url_private_download ?? '') })));
        result = importPreviewModal(await s.previewImport(who, { ...await read(data, s.today()), maxAccounts, config }), fictional);
      } else if (job.callback === PILOT_IMPORT_APPLY) {
        const m = meta(), outcome = await s.applyImport(who, ref(m, 'draftId'), ref(m, 'hash'));
        if (!outcome.applied) result = importPreviewModal({ draftId: ref(m, 'draftId'), hash: outcome.hash, lines: outcome.lines, initial: false }, fictional, 'The pilot changed since your preview. Review the updated changes.');
        else {
          const changes = outcome.lines.filter(l => !/^(Import issues|No researcher)/.test(l)).length;
          result = view('Workbook update applied', [...sections(outcome.lines.join('\n')), section(outcome.initial
            ? 'The pilot is initialized from this workbook. New requests use it now.' : 'Saved in DynamoDB. The workbook itself is unchanged.')]);
          after = async () => { await announce(`${label(fictional)}: workbook update applied by <@${who.userId}> (${outcome.initial ? 'initialized' : `${changes} change${changes === 1 ? '' : 's'}`}).`); await refreshHq(); };
        }
      } else throw new PilotError('invalid', 'Unknown pilot form. Reopen /resource-pilot.');
    }
  } catch (error) { result = failure(error, error instanceof PilotError && error.code === 'unauthorized' ? undefined : requestId); }
  await client.views.update({ view_id: job.viewId, view: result });
  await after?.().catch(error => log(`Post-action follow-up failed: ${(error as Error).message}`));
}
