import { randomUUID } from 'node:crypto';
import { configSchema, type ScoringConfig } from '../recommendations/models.js';
import { capacityForPeriod, recommendForPeriod } from './capacity.js';
import { dateSchema, datedRequestSchema, datedResearcherSchema, PilotError, type Account, type Actor, type Approval, type Assignment, type Change,
  type DatedResearcher, type HqLocation, type ImportReport, type Manager, type RequestState, type Review, type RunState, type SeedInfo, type ManagerChange } from './models.js';
import { planImport, type CurrentState, type ImportDraft } from './import.js';
import { computeMetrics } from './reports.js';
import { PILOT_MANAGERS, seedFrom, seedRows } from './seed.js';
import { ConflictError, type Check, type PilotStore, type Row } from './store.js';
import { HOURS, inSlots, type CapacityUnits } from './units.js';

const required = <T>(row: Row | undefined): Row<T> => {
  if (!row) throw new PilotError('not_found', 'The pilot record was not found.');
  return row as Row<T>;
};
const check = (row: Row): Check => ({ key: row.key, version: row.version });
const next = <T>(row: Row<T>, data: T): Row<T> => ({ ...row, version: row.version + 1, data });
const id = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new PilotError('invalid', 'Invalid pilot identifier.');
  return value;
};
export class PilotService {
  /** `admins` may change the manager list (operations leads); they need not be staffing managers themselves. */
  constructor(public store: PilotStore, public teamId: string, private clock: () => Date = () => new Date(), public units: CapacityUnits = HOURS,
    private admins: string[] = []) {}
  today() { return this.clock().toISOString().slice(0, 10); }
  private managerKey(actor: Actor) {
    if (actor.teamId !== this.teamId || !/^U[A-Z0-9]+$/.test(actor.userId)) throw new PilotError('unauthorized', 'Only configured pilot managers may use this workflow.');
    return `MANAGER#${actor.userId}`;
  }
  private validateManager(row: Row | undefined): Row<Manager> {
    if (!row || (row.data as Manager)?.enabled !== true) throw new PilotError('unauthorized', 'Only configured pilot managers may use this workflow.');
    return row as Row<Manager>;
  }
  async authorize(actor: Actor) { return this.validateManager(await this.store.get(this.managerKey(actor))); }
  async accounts(actor: Actor) { await this.authorize(actor); return (await this.store.list<Account>('ACCOUNT#')).map(r => r.data); }
  async requests(actor: Actor) { await this.authorize(actor); return this.store.list<RequestState>('REQUEST#'); }
  async request(actor: Actor, requestId: string) { await this.authorize(actor); return required<RequestState>(await this.store.get(`REQUEST#${id(requestId)}`)); }
  private async write(puts: Row[], checks: Check[]) {
    try { await this.store.commit(puts, checks); }
    catch (error) { if (error instanceof ConflictError) throw new PilotError('stale', error.message); throw error; }
  }
  async createRequest(actor: Actor, input: unknown, requestId: string = randomUUID()) {
    const manager = await this.authorize(actor), request = datedRequestSchema.parse(input);
    const account = required<Account>(await this.store.get(`ACCOUNT#${id(request.accountId)}`));
    if (request.accountName !== account.data.name) throw new PilotError('invalid', 'Choose a configured fictional account.');
    const key = `REQUEST#${id(requestId)}`, existing = await this.store.get<RequestState>(key);
    if (existing) {
      if (JSON.stringify(existing.data.request) !== JSON.stringify(request)) throw new PilotError('invalid', 'This request identifier is already in use.');
      return requestId;
    }
    await this.write([{ key, version: 1, data: { request, filledResearcherIds: [], status: 'awaiting_manager', createdAt: this.clock().toISOString() } satisfies RequestState }],
      [check(manager), check(account), { key, version: null }]);
    return requestId;
  }
  async recommendations(actor: Actor, requestId: string) {
    const [managerRow, requestRow, configRow] = await this.store.getMany([this.managerKey(actor), `REQUEST#${id(requestId)}`, 'CONFIG']);
    const manager = this.validateManager(managerRow), state = required<RequestState>(requestRow), policy = required<ScoringConfig>(configRow);
    this.open(state.data);
    const config = configSchema.parse(policy.data), researchers = await this.store.list<DatedResearcher>('RESEARCHER#');
    const computed = recommendForPeriod(researchers.map(r => r.data), { ...state.data.request, openings: state.data.request.openings - state.data.filledResearcherIds.length }, config);
    const run = this.units.kind === 'account-slots' ? inSlots(computed, this.units.maxAccounts) : computed;
    const runId = randomUUID();
    const record: RunState = { run, configVersion: policy.version, researcherVersions: Object.fromEntries(researchers.map(r => [(r.data as DatedResearcher).id, r.version])) };
    await this.write([{ key: `RUN#${runId}`, version: 1, data: record }, next(state, { ...state.data, runId })],
      [check(manager), check(policy), check(state), { key: `RUN#${runId}`, version: null }]);
    return { runId, ...record };
  }
  private open(state: RequestState) {
    if (state.status === 'filled' || state.status === 'declined') throw new PilotError('closed', `This request is ${state.status}.`);
  }
  async prepareApproval(actor: Actor, requestId: string, runId: string, selectedIds: string[]) {
    const managerKey = this.managerKey(actor);
    if (!selectedIds.length || selectedIds.length > 5 || new Set(selectedIds).size !== selectedIds.length) throw new PilotError('invalid', 'Choose one to five unique candidates.');
    selectedIds.forEach(id);
    const keys = [managerKey, `REQUEST#${id(requestId)}`, `RUN#${id(runId)}`, 'CONFIG', ...selectedIds.map(s => `RESEARCHER#${s}`)];
    const rows = await this.store.getMany(keys);
    const manager = this.validateManager(rows[0]), state = required<RequestState>(rows[1]), savedRun = required<RunState>(rows[2]), policy = required<ScoringConfig>(rows[3]);
    this.open(state.data);
    if (state.data.runId !== runId || savedRun.data.configVersion !== policy.version) throw new PilotError('stale', 'Recommendations changed. Refresh and review again.');
    if (selectedIds.length > state.data.request.openings - state.data.filledResearcherIds.length) throw new PilotError('invalid', 'Too many selections for the remaining openings.');
    if (selectedIds.some(s => !savedRun.data.run.retained.some(r => r.researcherId === s) || state.data.filledResearcherIds.includes(s))) throw new PilotError('invalid', 'Choose unassigned candidates from this retained shortlist.');
    const researchers = rows.slice(4).map(row => required<DatedResearcher>(row));
    if (researchers.some((row, i) => row.data.id !== selectedIds[i])) throw new PilotError('invalid', 'A researcher record has a conflicting identifier.');
    if (researchers.some(r => r.version !== savedRun.data.researcherVersions[r.data.id])) throw new PilotError('stale', 'Researcher availability changed. Refresh recommendations and review again.');
    const validated = recommendForPeriod(researchers.map(r => r.data), { ...state.data.request, openings: selectedIds.length }, configSchema.parse(policy.data));
    if (validated.eligibleCount !== selectedIds.length) throw new PilotError('stale', 'A selected researcher is no longer eligible. Refresh recommendations.');
    const approvalId = randomUUID();
    const review: Review = { requestId, runId, actor, selectedIds: [...selectedIds], requestVersion: state.version,
      managerVersion: manager.version, configVersion: policy.version,
      researcherVersions: Object.fromEntries(researchers.map(r => [r.data.id, r.version])),
      summaries: validated.retained.map(r => ({ researcherId: r.researcherId, name: r.name, hoursAfterAssignment: r.hoursAfterAssignment })), createdAt: this.clock().toISOString() };
    await this.write([{ key: `REVIEW#${approvalId}`, version: 1, data: review }],
      [check(manager), check(state), check(policy), ...researchers.map(check), { key: `REVIEW#${approvalId}`, version: null }]);
    return { approvalId, review, request: state.data.request };
  }
  async approve(actor: Actor, approvalId: string): Promise<Approval> {
    const manager = await this.authorize(actor);
    const reviewRow = required<Review>(await this.store.get(`REVIEW#${id(approvalId)}`)), review = reviewRow.data;
    if (review.actor.teamId !== actor.teamId || review.actor.userId !== actor.userId) throw new PilotError('unauthorized', 'This confirmation belongs to another manager.');
    const keys = [manager.key, `REQUEST#${review.requestId}`, 'CONFIG', `APPROVAL#${approvalId}`, ...review.selectedIds.map(s => `RESEARCHER#${s}`)];
    const rows = await this.store.getMany(keys), currentManager = this.validateManager(rows[0]);
    if (rows[3]) return required<Approval>(rows[3]).data;
    const state = required<RequestState>(rows[1]), policy = required<ScoringConfig>(rows[2]); this.open(state.data);
    const researchers = rows.slice(4).map(r => required<DatedResearcher>(r));
    if (researchers.some((row, i) => row.data.id !== review.selectedIds[i])) throw new PilotError('invalid', 'A researcher record has a conflicting identifier.');
    if (currentManager.version !== review.managerVersion || state.version !== review.requestVersion || policy.version !== review.configVersion ||
        state.data.runId !== review.runId || researchers.some(r => r.version !== review.researcherVersions[r.data.id])) throw new PilotError('stale', 'Records changed after your review. Refresh recommendations and confirm again.');
    const request = state.data.request;
    if (review.selectedIds.length > request.openings - state.data.filledResearcherIds.length || review.selectedIds.some(s => state.data.filledResearcherIds.includes(s))) throw new PilotError('stale', 'The remaining openings changed.');
    const fresh = recommendForPeriod(researchers.map(r => r.data), { ...request, openings: review.selectedIds.length }, configSchema.parse(policy.data));
    if (fresh.eligibleCount !== review.selectedIds.length) throw new PilotError('stale', 'Availability no longer meets the request. Refresh recommendations.');
    const approval: Approval = { id: approvalId, requestId: review.requestId, actor, researcherIds: [...review.selectedIds],
      assignmentIds: review.selectedIds.map(s => `${approvalId}_${s}`), approvedAt: this.clock().toISOString() };
    const filled = [...state.data.filledResearcherIds, ...review.selectedIds];
    const puts: Row[] = researchers.map(row => next(row, datedResearcherSchema.parse({ ...row.data, assignments: [...row.data.assignments, {
      id: `${approvalId}_${row.data.id}`, accountId: request.accountId, startDate: request.startDate, endDate: request.endDate,
      hoursPerWeek: request.hoursPerResearcher, status: 'active',
    }] })));
    puts.push(next(state, { ...state.data, filledResearcherIds: filled, status: filled.length === request.openings ? 'filled' : 'partial' }),
      { key: `APPROVAL#${approvalId}`, version: 1, data: approval });
    try {
      await this.write(puts, [check(currentManager), check(state), check(policy), check(reviewRow), ...researchers.map(check), { key: `APPROVAL#${approvalId}`, version: null }]);
    } catch (error) {
      // A successful commit may have lost its response, or a duplicate callback may race it.
      const recorded = await this.store.get<Approval>(`APPROVAL#${approvalId}`);
      if (recorded) { await this.authorize(actor); return recorded.data; }
      throw error;
    }
    return approval;
  }
  async decline(actor: Actor, requestId: string, expectedVersion: number) {
    const rows = await this.store.getMany([this.managerKey(actor), `REQUEST#${id(requestId)}`]);
    const manager = this.validateManager(rows[0]), state = required<RequestState>(rows[1]);
    if (state.version !== expectedVersion) throw new PilotError('stale', 'The request changed. Review its current state first.');
    this.open(state.data);
    const auditId = randomUUID();
    await this.write([next(state, { ...state.data, status: 'declined' }), { key: `DECLINE#${auditId}`, version: 1,
      data: { requestId, actor, declinedAt: this.clock().toISOString(), filledResearcherIds: state.data.filledResearcherIds } }],
      [check(manager), check(state), { key: `DECLINE#${auditId}`, version: null }]);
  }

  async importReport(actor: Actor) { await this.authorize(actor); return (await this.store.get<ImportReport>('IMPORT'))?.data; }
  /** Unauthenticated read for views refreshed after an authorized action; callers must authorize first. */
  async snapshot() {
    const [researchers, accounts] = await Promise.all([this.store.list<DatedResearcher>('RESEARCHER#'), this.store.list<Account>('ACCOUNT#')]);
    return { researchers: researchers.map(r => r.data), accounts: accounts.map(a => a.data) };
  }
  async roster(actor: Actor) { await this.authorize(actor); return this.snapshot(); }
  async activeAssignments(actor: Actor) {
    await this.authorize(actor);
    const { researchers, accounts } = await this.snapshot(), names = new Map(accounts.map(a => [a.id, a.name])), today = this.today();
    return researchers.flatMap(r => r.assignments.map((a, index) => ({ researcherId: r.id, name: r.name, index, accountName: names.get(a.accountId) ?? a.accountId, ...a })))
      .filter(a => a.status === 'active' && a.endDate >= today)
      .sort((a, b) => a.name.localeCompare(b.name) || a.startDate.localeCompare(b.startDate));
  }
  /**
   * Cancel or reschedule one assignment, addressed by its position (assignments are only appended, never reordered or removed).
   * Rescheduling rechecks capacity without the assignment itself. Cancelling an approved assignment reopens its request opening.
   */
  async changeAssignment(actor: Actor, researcherId: string, index: number, change: { action: 'cancel' } | { action: 'reschedule'; startDate: string; endDate: string }) {
    const [managerRow, researcherRow] = await this.store.getMany([this.managerKey(actor), `RESEARCHER#${id(researcherId)}`]);
    const manager = this.validateManager(managerRow), row = required<DatedResearcher>(researcherRow), current = row.data.assignments[index];
    if (!Number.isInteger(index) || !current || current.status !== 'active') throw new PilotError('invalid', 'Choose an active assignment.');
    let updated: Assignment = { ...current, status: 'cancelled' };
    if (change.action === 'reschedule') {
      const startDate = dateSchema.safeParse(change.startDate), endDate = dateSchema.safeParse(change.endDate);
      if (!startDate.success || !endDate.success || startDate.data > endDate.data) throw new PilotError('invalid', 'Choose a valid new date range.');
      const others = { ...row.data, assignments: row.data.assignments.filter((_, i) => i !== index) };
      const fit = capacityForPeriod(others, { accountId: current.accountId, hoursPerResearcher: current.hoursPerWeek, startDate: startDate.data, endDate: endDate.data });
      if (fit.reasons.length) throw new PilotError('invalid', `The new dates do not fit: ${fit.reasons.join('; ')}`);
      updated = { ...current, startDate: startDate.data, endDate: endDate.data };
    }
    const approvalId = current.id.includes('_') ? current.id.slice(0, current.id.indexOf('_')) : '';
    const approval = /^[a-zA-Z0-9-]{1,100}$/.test(approvalId) ? await this.store.get<Approval>(`APPROVAL#${approvalId}`) : undefined;
    const requestRow = approval && change.action === 'cancel' ? await this.store.get<RequestState>(`REQUEST#${approval.data.requestId}`) : undefined;
    const record: Change = { id: randomUUID(), action: change.action, actor, researcherId: row.data.id, assignmentId: current.id, accountId: current.accountId,
      ...(approval ? { requestId: approval.data.requestId } : {}), before: { startDate: current.startDate, endDate: current.endDate, status: current.status },
      after: { startDate: updated.startDate, endDate: updated.endDate, status: updated.status }, changedAt: this.clock().toISOString() };
    const puts: Row[] = [next(row, datedResearcherSchema.parse({ ...row.data, assignments: row.data.assignments.map((a, i) => i === index ? updated : a) })),
      { key: `CHANGE#${record.id}`, version: 1, data: record }];
    const checks: Check[] = [check(manager), check(row), { key: `CHANGE#${record.id}`, version: null }];
    if (requestRow && requestRow.data.filledResearcherIds.includes(row.data.id)) {
      const filled = requestRow.data.filledResearcherIds.filter(r => r !== row.data.id);
      puts.push(next(requestRow, { ...requestRow.data, filledResearcherIds: filled, status: requestRow.data.status === 'filled' ? 'partial' : requestRow.data.status }));
      checks.push(check(requestRow));
    }
    await this.write(puts, checks);
    const account = await this.store.get<Account>(`ACCOUNT#${current.accountId}`);
    return { change: record, researcherName: row.data.name, accountName: account?.data.name ?? current.accountId, reopenedRequest: puts.length > 2 };
  }
  async approvalSummary(actor: Actor, approvalId: string) {
    await this.authorize(actor);
    const [reviewRow, approvalRow] = await this.store.getMany([`REVIEW#${id(approvalId)}`, `APPROVAL#${approvalId}`]);
    const review = required<Review>(reviewRow).data, approval = required<Approval>(approvalRow).data;
    const state = required<RequestState>(await this.store.get(`REQUEST#${approval.requestId}`)).data;
    return { approval, request: state.request, status: state.status, names: review.summaries.map(s => s.name) };
  }
  /** Returns true once per key, so repeated Slack confirmations do not resend notices. */
  async claimNotice(key: string) {
    try { await this.store.commit([{ key: `NOTICE#${id(key)}`, version: 1, data: { at: this.clock().toISOString() } }], [{ key: `NOTICE#${key}`, version: null }]); return true; }
    catch (error) { if (error instanceof ConflictError) return false; throw error; }
  }
  async metrics(actor: Actor) { await this.authorize(actor); return computeMetrics(await this.store.list('')); }
  /**
   * Who may import, and whether the upload initializes an empty namespace. An empty namespace has no manager rows yet, so the
   * bundled pilot managers may initialize it. Fictional namespaces refuse real uploads so their labels never mislead.
   */
  private async importAccess(actor: Actor) {
    const [seedRow, managerRow] = await this.store.getMany(['SEED', this.managerKey(actor)]);
    if (!seedRow) {
      if (!PILOT_MANAGERS.some(m => m.id === actor.userId)) throw new PilotError('unauthorized', 'Only configured pilot managers may use this workflow.');
      return { initial: true as const };
    }
    const manager = this.validateManager(managerRow), seed = seedRow.data as SeedInfo;
    if (seed.fictional !== false) throw new PilotError('invalid', 'This pilot namespace holds fictional sample data, so a real workbook cannot be imported into it. Point the app at an empty namespace and import there.');
    if (seed.capacity !== 'account-slots') throw new PilotError('invalid', 'This namespace was not seeded from the Research workbook.');
    return { initial: false as const, manager };
  }
  async importAllowed(actor: Actor) { return (await this.importAccess(actor)).initial; }
  private async currentState(): Promise<CurrentState> {
    const [researchers, accounts, report, changes] = await Promise.all([this.store.list<DatedResearcher>('RESEARCHER#'), this.store.list<Account>('ACCOUNT#'),
      this.store.get<ImportReport>('IMPORT'), this.store.list<Change>('CHANGE#')]);
    return { researchers, accounts, ...(report && { report }), changedAssignmentIds: new Set(changes.map(c => c.data.assignmentId)) };
  }
  private initialPlan(draft: ImportDraft) {
    const lines = [`Initialize this empty namespace from ${draft.fileNames.join(' and ')}: ${draft.researchers.length} researchers, ${draft.accounts.length} accounts.`,
      `Import issues: ${draft.report.excluded.length} excluded, ${draft.report.warnings.length} warning(s). Review them with /resource-pilot issues.`,
      `Pilot managers: ${PILOT_MANAGERS.map(m => m.name).join(', ')}.`];
    return { lines, hash: lines.join('\n') };
  }
  /** Store the parsed upload and describe what applying it would change. Nothing else is written. */
  async previewImport(actor: Actor, input: Omit<ImportDraft, 'uploadedBy' | 'createdAt' | 'appliedAt'>) {
    const access = await this.importAccess(actor), draftId = randomUUID();
    const draft: ImportDraft = { ...input, uploadedBy: actor.userId, createdAt: this.clock().toISOString() };
    const plan = access.initial ? this.initialPlan(draft) : planImport(draft, await this.currentState());
    await this.write([{ key: `IMPORTDRAFT#${draftId}`, version: 1, data: draft }], [{ key: `IMPORTDRAFT#${draftId}`, version: null }]);
    return { draftId, initial: access.initial, lines: plan.lines, hash: plan.hash };
  }
  /**
   * Apply a previewed upload in one conditional transaction, only if it would still make exactly the reviewed changes; otherwise
   * return the new preview. Approvals or changes made since the preview conflict on their researcher versions.
   */
  async applyImport(actor: Actor, draftId: string, hash: string): Promise<{ applied: true; lines: string[]; initial: boolean } | { applied: false; lines: string[]; hash: string }> {
    const access = await this.importAccess(actor);
    const row = required<ImportDraft>(await this.store.get(`IMPORTDRAFT#${id(draftId)}`)), draft = row.data;
    if (draft.uploadedBy !== actor.userId) throw new PilotError('unauthorized', 'This import belongs to another manager.');
    if (draft.appliedAt) throw new PilotError('closed', `This upload was already applied at ${draft.appliedAt}.`);
    const done = next(row, { ...draft, appliedAt: this.clock().toISOString() });
    if (access.initial) {
      const plan = this.initialPlan(draft);
      if (plan.hash !== hash) return { applied: false, ...plan };
      await seedRows(this.store, seedFrom(draft, draft.maxAccounts, draft.config, false, draft.report.source), key => key.startsWith('IMPORTDRAFT#'));
      await this.write([done], [check(row)]);
      return { applied: true, lines: plan.lines, initial: true };
    }
    const plan = planImport(draft, await this.currentState());
    if (plan.hash !== hash) return { applied: false, lines: plan.lines, hash: plan.hash };
    const checks = [...plan.checks, check(row), check(access.manager)];
    if (plan.puts.length + 1 + 1 > 100) throw new PilotError('invalid', `This upload changes ${plan.puts.length} records, more than one atomic update allows. Seed a new namespace from it with npm run pilot:seed instead.`);
    await this.write([...plan.puts, done], checks);
    return { applied: true, lines: plan.lines, initial: false };
  }
  private requireAdmin(actor: Actor) {
    this.managerKey(actor);
    if (!this.admins.includes(actor.userId)) throw new PilotError('unauthorized', 'Only the configured operations leads may change pilot managers.');
  }
  async managers(actor: Actor) {
    this.requireAdmin(actor);
    return (await this.store.list<Manager>('MANAGER#')).map(r => ({ userId: r.key.slice(8), ...r.data })).sort((a, b) => a.name.localeCompare(b.name));
  }
  /**
   * Add, re-enable, or remove (disable) a manager, with an immutable record. Rows are kept so history stays attributable. Every
   * enabled manager row is checked, so two concurrent removals can never leave the pilot without a manager.
   */
  async setManager(actor: Actor, userId: string, action: 'add' | 'remove', name?: string) {
    this.requireAdmin(actor);
    const key = this.managerKey({ teamId: actor.teamId, userId });
    const rows = await this.store.list<Manager>('MANAGER#'), row = rows.find(r => r.key === key);
    const enabled = rows.filter(r => r.data.enabled === true);
    if (action === 'add' && row?.data.enabled) throw new PilotError('invalid', `${row.data.name} is already a pilot manager.`);
    if (action === 'remove' && !row?.data.enabled) throw new PilotError('invalid', 'That person is not a pilot manager.');
    if (action === 'remove' && enabled.length <= 1) throw new PilotError('invalid', 'Keep at least one pilot manager. Add another manager before removing this one.');
    const label = (name ?? '').trim().slice(0, 80) || row?.data.name || userId;
    const record: ManagerChange = { id: randomUUID(), actor, userId, action, name: label, changedAt: this.clock().toISOString() };
    const data: Manager = { name: label, enabled: action === 'add' };
    await this.write([row ? next(row, data) : { key, version: 1, data }, { key: `MANAGERCHANGE#${record.id}`, version: 1, data: record }],
      [...enabled.filter(r => r.key !== key).map(check), row ? check(row) : { key, version: null }, { key: `MANAGERCHANGE#${record.id}`, version: null }]);
    return record;
  }
  hqLocation() { return this.store.get<HqLocation>('HQ'); }
  async saveHqLocation(location: HqLocation, previous?: Row<HqLocation>) {
    await this.write([previous ? next(previous, location) : { key: 'HQ', version: 1, data: location }], [previous ? check(previous) : { key: 'HQ', version: null }]);
  }
}
