import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { DatedResearcher, ImportReport, SeedInfo } from '../src/resourcing/models.js';
import { RESOURCING_CHANGE, RESOURCING_CONFIRM, RESOURCING_IMPORT, RESOURCING_IMPORT_APPLY, RESOURCING_REQUEST, RESOURCING_SELECT } from '../src/slack/resourcing.js';
import { profilesFromWorkbook, profilesSchema, profileSheets } from '../src/workbook/profiles.js';
import { sampleProfiles, sampleWorkbook } from '../src/workbook/sample.js';
import { workbookFromUploads, workbookUpload } from '../src/workbook/upload.js';
import { harness, option, settings, values, who, workbookConfig } from './harness.js';

type Harness = Awaited<ReturnType<typeof harness>>;
const profiles = profilesSchema.parse(sampleProfiles());
const buffer = async (book: ExcelJS.Workbook) => (await book.xlsx.writeBuffer()) as ArrayBuffer;
/** The sample workbook a semester later: Ana leaves Northwind, Ivy joins Contoso, Bo is gone, and Lu is new. */
function updatedWorkbook() {
  const book = sampleWorkbook(), roster = book.getWorksheet('Research Members')!, grid = book.getWorksheet('Resourcing Grid')!;
  grid.getCell('C6').value = false; grid.getCell('B6').value = 1;
  grid.getCell('D16').value = true; grid.getCell('B16').value = 1;
  grid.spliceRows(15, 0, ['Lu Nu (05/2028)', 1, false, false, false, true]);
  grid.spliceRows(7, 1);
  roster.spliceRows(13, 0, ['Lu Nu', 'Strategist', 'Spring 2028', '', true, 'Fall 2025']);
  roster.spliceRows(6, 1);
  return book;
}
const researcher = async (h: Harness, id: string) => (await h.store.get<DatedResearcher>(`RESEARCHER#${id}`))!.data;
const preview = async (h: Harness, book = updatedWorkbook(), extra?: ExcelJS.Workbook) => {
  const files = [{ name: 'research.xlsx', data: await buffer(book) }, ...(extra ? [{ name: 'profiles.xlsx', data: await buffer(extra) }] : [])];
  return h.service.previewImport(who, { ...await workbookFromUploads(files, settings, '2026-11-02'), maxAccounts: 3, config: workbookConfig });
};
const real = () => harness({}, undefined, { fictional: false });

test('profiles round-trip through sheets, and invalid rows are skipped with a reason', async () => {
  const book = profileSheets(new ExcelJS.Workbook(), profiles);
  book.getWorksheet('Profiles')!.addRow(['Bad Cap', '', 'many']);
  const read = profilesFromWorkbook(book, 'sheets');
  assert.deepEqual(read.profiles!.researchers, profiles.researchers);
  assert.deepEqual(read.profiles!.accounts, profiles.accounts);
  assert.match(read.issues[0]!, /Profiles row 8: accountCap/);
  assert.deepEqual(profilesFromWorkbook(sampleWorkbook(), 'none'), { issues: [] });
});

test('uploads need exactly one workbook with roster and grid', async () => {
  const sheetsOnly = { name: 'p.xlsx', data: await buffer(profileSheets(new ExcelJS.Workbook(), profiles)) };
  await assert.rejects(workbookFromUploads([sheetsOnly], settings, '2026-11-02'), /No file has both the member roster/);
  await assert.rejects(workbookFromUploads([{ name: 'x.xlsx', data: new TextEncoder().encode('not excel').buffer as ArrayBuffer }], settings, '2026-11-02'), /could not be read/);
  const both = await workbookFromUploads([{ name: 'research.xlsx', data: await buffer(sampleWorkbook()) }, sheetsOnly], settings, '2026-11-02');
  assert.equal(both.report.source, 'Slack upload: research.xlsx + 1:1 profiles (p.xlsx)');
  assert.deepEqual(both.accounts.find(a => a.id === 'northwind-bakery')!.industries, ['food-and-beverage']);
});

test('a preview lists every change and saves nothing; applying follows the workbook and keeps positions', async () => {
  const h = await real(), before = await h.store.list('');
  const shown = await preview(h);
  assert.deepEqual(shown.lines.slice(0, -1), ['Ana Alpha: removed from Northwind Bakery', 'Bo Beta: no longer in the workbook; marked inactive, existing assignments kept',
    'Ivy Iota: added to Contoso Health', 'Lu Nu: new strategist on Internal Comms']);
  assert.equal((await h.store.list('')).length, before.length + 1); // only the draft
  const applied = await h.service.applyImport(who, shown.draftId, shown.hash);
  assert.equal(applied.applied, true);
  const ana = await researcher(h, 'ana-alpha');
  assert.deepEqual(ana.assignments.map(a => [a.accountId, a.status]), [['northwind-bakery', 'cancelled'], ['contoso-health', 'active']]);
  assert.equal((await researcher(h, 'bo-beta')).active, false);
  assert.deepEqual((await researcher(h, 'ivy-iota')).assignments.map(a => a.source), ['workbook']);
  assert.equal((await researcher(h, 'lu-nu')).skills[0], 'strategist');
  await assert.rejects(h.service.applyImport(who, shown.draftId, shown.hash), /already applied/);
  // The same upload again changes nothing but the report.
  assert.deepEqual((await preview(h)).lines.slice(0, 1), ['No researcher, assignment, or account changes.']);
});

test('approvals survive re-imports, are counted once when copied into Excel, and manager cancellations win', async () => {
  const h = await real();
  await h.command(''); await h.submit(RESOURCING_REQUEST, h.views.at(-1), values);
  await h.submit(RESOURCING_SELECT, h.views.at(-1), { decision: { value: { selected_option: { value: 'approve' } } }, candidates: { value: { selected_options: [{ value: 'ivy-iota' }] } } });
  await h.submit(RESOURCING_CONFIRM, h.views.at(-1), {});
  const book = updatedWorkbook(); book.getWorksheet('Resourcing Grid')!.getCell('E16').value = true; // Ivy's row after Lu's insert and Bo's removal
  // Cancel Cy's workbook assignment in Slack, though the workbook still checks it.
  await h.command('assignments');
  const cy = h.views.at(-1).blocks.find((b: any) => b.block_id === 'assignment').element.options.find((o: any) => o.value.startsWith('cy-gamma'));
  assert.equal(cy, undefined); // Cy is excluded (no hire term) and never seeded; use Ed instead.
  const ed = h.views.at(-1).blocks.find((b: any) => b.block_id === 'assignment').element.options.find((o: any) => o.value.startsWith('ed-epsilon'));
  await h.submit(RESOURCING_CHANGE, h.views.at(-1), { assignment: { value: option(ed.value) }, change: { value: option('cancel') } });
  const shown = await preview(h, book);
  assert.ok(shown.lines.includes('Ivy Iota: Fictional Screening Co is already approved in Slack; counted once'));
  assert.ok(shown.lines.includes('Ed Epsilon: Northwind Bakery is checked in the workbook but was cancelled in Slack; keeping the cancellation'));
  assert.equal((await h.service.applyImport(who, shown.draftId, shown.hash)).applied, true);
  const ivy = await researcher(h, 'ivy-iota');
  assert.deepEqual(ivy.assignments.map(a => [a.accountId, a.status, a.source ?? 'slack']), [['fictional-screening-co', 'active', 'slack'], ['contoso-health', 'active', 'workbook']]);
  assert.equal((await researcher(h, 'ed-epsilon')).assignments[0]!.status, 'cancelled');
});

test('a change after the preview returns an updated preview instead of applying', async () => {
  const h = await real(), shown = await preview(h);
  await h.service.changeAssignment(who, 'ana-alpha', 1, { action: 'cancel' });
  const outcome = await h.service.applyImport(who, shown.draftId, shown.hash);
  assert.equal(outcome.applied, false);
  if (!outcome.applied) assert.notEqual(outcome.hash, shown.hash);
  assert.equal((await researcher(h, 'bo-beta')).active, true);
});

test('fictional namespaces refuse uploads; an empty one is initialized only by a bootstrap manager', async () => {
  await assert.rejects(preview(await harness()), /fictional sample data/);
  const h = await harness({}, undefined, { empty: true });
  await assert.rejects(h.service.previewImport({ ...who, userId: 'U0OTHER1' }, {} as never), /Only configured managers/);
  const shown = await preview(h);
  assert.equal(shown.initial, true);
  assert.match(shown.lines[0]!, /^Initialize this empty namespace from research\.xlsx: 8 researchers, 5 accounts\.$/);
  await h.service.applyImport(who, shown.draftId, shown.hash);
  assert.deepEqual((await h.store.get<SeedInfo>('SEED'))!.data, { fictional: false, schemaVersion: 2, source: 'Slack upload: research.xlsx', capacity: 'account-slots', maxAccounts: 3 });
  assert.ok(await h.store.get('MANAGER#U0AS0D7GQMB'));
  await assert.rejects(h.service.applyImport({ ...who, userId: 'U06QLUN31L0' }, shown.draftId, shown.hash), /another manager/);
});

test('Slack: /resourcing import uploads, previews, applies, and announces', async () => {
  const files = new Map([['https://files.slack.com/files-pri/T-F1/research.xlsx', await buffer(updatedWorkbook())],
    ['https://files.slack.com/files-pri/T-F2/profiles.xlsx', await buffer(profileSheets(new ExcelJS.Workbook(), profiles))]]);
  const h = await harness({ notify: ['U0OPS1'], fictional: false, workbook: { read: workbookUpload(settings), maxAccounts: 3, config: workbookConfig }, download: async url => files.get(url)! }, undefined, { fictional: false });
  await h.command('import');
  const form = h.views.at(-1);
  assert.equal(form.blocks.find((b: any) => b.block_id === 'files').element.type, 'file_input');
  await h.submit(RESOURCING_IMPORT, form, { files: { value: { type: 'file_input', files: [] } } });
  assert.equal(h.views.at(-1), form); // rejected inline: no loading view, no job
  const upload = (name: string, n: number) => ({ id: `F${n}`, name, size: 1000, url_private_download: `https://files.slack.com/files-pri/T-F${n}/${name}` });
  await h.submit(RESOURCING_IMPORT, form, { files: { value: { type: 'file_input', files: [upload('research.xlsx', 1), upload('profiles.xlsx', 2)] } } });
  const review = h.views.at(-1), body = JSON.stringify(review.blocks);
  assert.equal(review.callback_id, RESOURCING_IMPORT_APPLY);
  assert.match(body, /Lu Nu: new strategist on Internal Comms/); assert.match(body, /Ed Epsilon: skills, interests, industry experience, 1:1 profile updated/);
  await h.submit(RESOURCING_IMPORT_APPLY, review, {});
  assert.equal(h.views.at(-1).title.text, 'Workbook update applied');
  assert.match(h.posts.at(-1).text, /^RESEARCH RESOURCING: workbook update applied by <@U0AS0D7GQMB> \(\d+ changes\)\.$/);
  assert.deepEqual((await h.store.get<ImportReport>('IMPORT'))!.data.tools, ['excel', 'quid', 'semrush']);
});

test('Slack downloads only from Slack file storage', async () => {
  const h = await harness({ workbook: { read: workbookUpload(settings), maxAccounts: 3, config: workbookConfig } }, undefined, { fictional: false });
  await h.command('import');
  await h.submit(RESOURCING_IMPORT, h.views.at(-1), { files: { value: { type: 'file_input', files: [{ id: 'F1', name: 'r.xlsx', size: 10, url_private_download: 'https://evil.example/r.xlsx' }] } } });
  assert.match(JSON.stringify(h.views.at(-1).blocks), /did not come from Slack file storage/);
});
