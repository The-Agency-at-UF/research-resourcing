import { randomUUID } from 'node:crypto';
import type { App, types, ViewOutput } from '@slack/bolt';
import { datedRequestSchema, PilotError, type Account, type Actor, type DatedRequest, type Review, type RunState } from '../pilot/models.js';
import type { PilotService } from '../pilot/service.js';
import { parseRequestForm, requestModal } from './request-form.js';

const text = (value: string) => ({ type: 'plain_text' as const, text: value.slice(0, 2900) });
const section = (value: string) => ({ type: 'section' as const, text: text(value) });
const notice = section('FICTIONAL DATA PILOT — test assignments are stored in DynamoDB.');
const modal = (title: string, blocks: types.ModalView['blocks'], callback?: string, metadata = '{}'): types.ModalView => ({
  type: 'modal', title: text(title), close: text('Close'), blocks: [notice, ...blocks],
  ...(callback ? { callback_id: callback, private_metadata: metadata, submit: text('Continue') } : {}),
});
export const PILOT_REQUEST = 'resource_pilot_request', PILOT_SELECT = 'resource_pilot_select', PILOT_CONFIRM = 'resource_pilot_confirm', PILOT_RESUME = 'resource_pilot_resume';
const metadata = (view: { private_metadata: string }): Record<string, string | number> => {
  try { const value = JSON.parse(view.private_metadata); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new PilotError('invalid', 'Invalid form. Reopen /resource-pilot.'); }
};
const field = (values: ViewOutput['state']['values'], name: string) => values[name]?.value;
const ref = (meta: Record<string, string | number>, name: string) => {
  const value = meta[name]; if (typeof value !== 'string') throw new PilotError('invalid', 'Invalid form reference. Reopen /resource-pilot.'); return value;
};
export function pilotRequestModal(accounts: Account[], requestId: string = randomUUID()): types.ModalView {
  const base = requestModal().blocks.filter(b => !('block_id' in b) || !['accountId', 'accountName'].includes(b.block_id ?? ''));
  return modal('Pilot staffing request', [
    { type: 'input', block_id: 'accountId', label: text('Fictional account'), element: { type: 'static_select', action_id: 'value', options: accounts.slice(0, 100).map(a => ({ text: text(a.name), value: a.id })) } },
    ...['startDate', 'endDate'].map(name => ({ type: 'input' as const, block_id: name, label: text(name === 'startDate' ? 'Start date (inclusive)' : 'End date (inclusive)'), element: { type: 'datepicker' as const, action_id: 'value' } })),
    ...base.filter(b => b.type === 'input'),
  ], PILOT_REQUEST, JSON.stringify({ requestId }));
}
export function parsePilotForm(values: ViewOutput['state']['values']) {
  const accountId = field(values, 'accountId')?.selected_option?.value ?? '';
  const parsed = parseRequestForm({ ...values, accountId: { value: { type: 'plain_text_input', value: accountId } }, accountName: { value: { type: 'plain_text_input', value: 'Selected fictional account' } } });
  if (!parsed.ok) return parsed;
  const dated = datedRequestSchema.safeParse({ ...parsed.request, startDate: field(values, 'startDate')?.selected_date ?? '', endDate: field(values, 'endDate')?.selected_date ?? '' });
  if (!dated.success) return { ok: false as const, errors: Object.fromEntries(dated.error.issues.map(i => [String(i.path[0]), i.message])) };
  return { ok: true as const, request: dated.data };
}
export function selectionModal(requestId: string, runId: string, record: RunState, requestVersion: number) {
  const run = record.run;
  const blocks: types.ModalView['blocks'] = [section(`${run.request.accountName}\n${run.request.startDate} to ${run.request.endDate}\n${run.request.hoursPerResearcher} hours/week each; ${run.request.openings} openings remain.\nRequest: ${requestId}`),
    ...run.displayed.map(r => section(`${r.rank}. ${r.name} — ${r.score.toFixed(1)}\n${r.explanation}`)), ...run.warnings.map(section)];
  if (run.excluded.length) blocks.push(section(`Exclusions:\n${run.excluded.map(e => `${e.researcherId}: ${e.reasons.join('; ')}`).join('\n')}`));
  blocks.push({ type: 'input', block_id: 'decision', label: text('Decision'), element: { type: 'static_select', action_id: 'value', initial_option: { text: text('Review candidate selection'), value: 'approve' }, options: [
    { text: text('Review candidate selection'), value: 'approve' }, { text: text('Decline remaining openings'), value: 'decline' },
  ] } });
  if (run.retained.length) blocks.push({ type: 'input', block_id: 'candidates', optional: true, label: text('Select from the retained shortlist'), element: {
    type: 'multi_static_select', action_id: 'value', max_selected_items: Math.min(5, run.request.openings, run.retained.length),
    options: run.retained.map(r => ({ text: text(`${r.rank}. ${r.name} — ${r.score.toFixed(1)}`), value: r.researcherId })),
  } });
  return modal('Pilot recommendations', blocks, PILOT_SELECT, JSON.stringify({ requestId, runId, requestVersion }));
}
export function confirmationModal(approvalId: string, review: Review, request: DatedRequest) {
  return { ...modal('Confirm test assignments', [section(`${request.accountName}\n${request.startDate} to ${request.endDate}, inclusive\n${request.hoursPerResearcher} hours/week per researcher`),
    ...review.summaries.map(s => section(`${s.name}\nAt least ${s.hoursAfterAssignment} hours/week remain after assignment.`)),
    section('Availability will be checked again when you confirm. Nothing has been reserved yet.'),
  ], PILOT_CONFIRM, JSON.stringify({ approvalId, requestId: review.requestId })), submit: text('Approve test batch') };
}

export function registerPilotHandlers(app: Pick<App, 'command' | 'view'>, service?: PilotService) {
  const needed = () => { if (!service) throw new PilotError('invalid', 'The DynamoDB pilot is not configured.'); return service; };
  const failure = (error: unknown, requestId?: string) => modal('Pilot action stopped', [section(error instanceof PilotError ? error.message : 'The action could not complete. Retry or check the local process. No success is being reported.'),
    ...(requestId ? [section(`Run /resource-pilot ${requestId} to reload this request. A repeated confirmation is safe if its first response was lost.`)] : [])]);
  const actor = (teamId: string | undefined, userId: string): Actor => ({ teamId: teamId ?? '', userId });
  const showRecommendations = async (who: Actor, requestId: string) => {
    const s = needed(), state = await s.request(who, requestId);
    if (state.data.status === 'filled' || state.data.status === 'declined') return modal('Saved pilot request', [section(`${state.data.request.accountName}\n${state.data.request.startDate} to ${state.data.request.endDate}\nStatus: ${state.data.status}\nApproved researchers: ${state.data.filledResearcherIds.join(', ') || 'None'}\nRequest: ${requestId}`)]);
    const result = await s.recommendations(who, requestId), current = await s.request(who, requestId);
    return selectionModal(requestId, result.runId, result, current.version);
  };
  app.command('/resource-pilot', async ({ command, ack, client }) => {
    await ack();
    const opened = await client.views.open({ trigger_id: command.trigger_id, view: modal('Staffing pilot', [section('Loading pilot access…')]) });
    if (!opened.view?.id) return;
    let view: types.ModalView;
    try {
      const s = needed(), who = actor(command.team_id, command.user_id); await s.authorize(who);
      const action = command.text.trim();
      if (!action) view = pilotRequestModal(await s.accounts(who));
      else if (action === 'list') {
        const requests = await s.requests(who);
        view = requests.length ? modal('Resume pilot request', [{ type: 'input', block_id: 'request', label: text('Request'), element: { type: 'static_select', action_id: 'value', options: requests.slice(-100).map(r => ({
          text: text(`${r.data.request.accountName} (${r.data.status}) ${r.key.slice(8, 16)}`), value: r.key.slice(8),
        })) } }], PILOT_RESUME) : modal('Pilot requests', [section('No requests yet. Run /resource-pilot to create one.')]);
      } else view = await showRecommendations(who, action);
    } catch (error) { view = failure(error); }
    await client.views.update({ view_id: opened.view.id, view });
  });
  app.view(PILOT_REQUEST, async ({ body, view, ack, client }) => {
    const parsed = parsePilotForm(view.state.values);
    if (!parsed.ok) { await ack({ response_action: 'errors', errors: parsed.errors }); return; }
    await ack({ response_action: 'update', view: modal('Staffing pilot', [section('Loading dated recommendations…')]) });
    let result: types.ModalView;
    try {
      const s = needed(), who = actor(body.team?.id, body.user.id), requestId = ref(metadata(view), 'requestId');
      const account = (await s.accounts(who)).find(a => a.id === parsed.request.accountId);
      if (!account) throw new PilotError('invalid', 'Choose a configured fictional account.');
      await s.createRequest(who, { ...parsed.request, accountName: account.name }, requestId);
      result = await showRecommendations(who, requestId);
    } catch (error) { result = failure(error); }
    await client.views.update({ view_id: view.id, view: result });
  });
  app.view(PILOT_RESUME, async ({ body, view, ack, client }) => {
    await ack({ response_action: 'update', view: modal('Staffing pilot', [section('Loading saved request…')]) });
    let result: types.ModalView;
    try { result = await showRecommendations(actor(body.team?.id, body.user.id), field(view.state.values, 'request')?.selected_option?.value ?? ''); }
    catch (error) { result = failure(error); }
    await client.views.update({ view_id: view.id, view: result });
  });
  app.view(PILOT_SELECT, async ({ body, view, ack, client }) => {
    await ack({ response_action: 'update', view: modal('Staffing pilot', [section('Checking current availability…')]) });
    let result: types.ModalView, requestId: string | undefined;
    try {
      const s = needed(), who = actor(body.team?.id, body.user.id), meta = metadata(view); requestId = ref(meta, 'requestId');
      await s.authorize(who);
      if (field(view.state.values, 'decision')?.selected_option?.value === 'decline') {
        const state = await s.request(who, requestId);
        if (state.version !== meta.requestVersion) throw new PilotError('stale', 'The request changed. Reload it before declining.');
        result = { ...modal('Confirm decline', [section(`Decline the remaining openings for ${state.data.request.accountName}? Existing approved assignments will stay in place.`)], PILOT_CONFIRM,
          JSON.stringify({ requestId, declineVersion: state.version })), submit: text('Decline openings') };
      } else {
        const selected = field(view.state.values, 'candidates')?.selected_options?.map(o => o.value) ?? [];
        const prepared = await s.prepareApproval(who, requestId, ref(meta, 'runId'), selected);
        result = confirmationModal(prepared.approvalId, prepared.review, prepared.request);
      }
    } catch (error) { result = failure(error, error instanceof PilotError && error.code === 'unauthorized' ? undefined : requestId); }
    await client.views.update({ view_id: view.id, view: result });
  });
  app.view(PILOT_CONFIRM, async ({ body, view, ack, client }) => {
    await ack({ response_action: 'update', view: modal('Staffing pilot', [section('Rechecking and saving your decision…')]) });
    let result: types.ModalView, requestId: string | undefined;
    try {
      const s = needed(), who = actor(body.team?.id, body.user.id), meta = metadata(view); requestId = ref(meta, 'requestId');
      if (typeof meta.declineVersion === 'number') {
        await s.decline(who, requestId, meta.declineVersion);
        result = modal('Pilot request declined', [section('Remaining openings declined. Existing approved assignments are unchanged.')]);
      } else {
        const approval = await s.approve(who, ref(meta, 'approvalId'));
        result = modal('Test assignments saved', [section(`Test assignments saved in DynamoDB.\nResearchers: ${approval.researcherIds.join(', ')}\nApproval: ${approval.id}\nRequest: ${approval.requestId}`), section(`Run /resource-pilot ${approval.requestId} to continue, or /resource-pilot list to inspect saved requests.`)]);
      }
    } catch (error) { result = failure(error, error instanceof PilotError && error.code === 'unauthorized' ? undefined : requestId); }
    await client.views.update({ view_id: view.id, view: result });
  });
}
