const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => {
    if (id in mocks) return mocks[id];
    if (id === './supabaseClient') return { supabase: {} };
    if (id.startsWith('@/')) return load(path.relative(__dirname, path.resolve(__dirname, '..', id.slice(2))) + '.ts', mocks);
    if (id.startsWith('.')) return load(path.relative(__dirname, path.resolve(path.dirname(filename), id)) + '.ts', mocks);
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  return mod.exports;
}

const helpers = load('construction-progress.ts');
const { runMutationWithParentRefresh } = load('mutation-refresh.ts');
const { ConstructionProgressSection, ConstructionWorkTypeControls } = load('../components/ConstructionProgressSection.tsx');
const { DateDualInput } = load('../components/DateDualInput.tsx');
const { createConstructionProgressAdapter } = load('db/construction-progress.ts');
const row = (values = {}) => ({
  id: 'row-1', project_id: 'project-1', work_type: 'other', work_name: null,
  contractor_id: null, contractor_name: null, planned_start_date: null, planned_end_date: null,
  completed_date: '2020-01-01', actual_completed_date: null, is_completed: false,
  notes: null, sort_order: 10, created_at: '2026-01-01', updated_at: '2026-01-01',
  deleted_at: null, status_override: null, ...values,
});
const model = (rows) => ({ rows, contractors: [], conflicts: [], loading: false, busy: false, error: null, canEdit: true,
  save: () => { throw new Error('render must not mutate'); }, remove: () => { throw new Error('render must not delete'); }, reload: () => {} });

test('construction refresh callback runs on success and not on failure', async () => {
  let refreshes = 0;
  await runMutationWithParentRefresh(async () => undefined, async () => { refreshes++; });
  assert.equal(refreshes, 1);
  await assert.rejects(runMutationWithParentRefresh(async () => { throw new Error('save failed'); }, async () => { refreshes++; }), /save failed/);
  assert.equal(refreshes, 1);
  const hookSource = fs.readFileSync(path.resolve(__dirname, '../components/useConstructionProgress.ts'), 'utf8');
  assert.match(hookSource, /runMutationWithParentRefresh\(operation, onMutationSuccess\)/);
});

test('entry ignores early other and steel and deleted main rows', () => {
  assert.equal(helpers.getProjectEntryDate([
    row({ work_type: 'other', planned_start_date: '2026-09-01' }),
    row({ work_type: 'steel', planned_start_date: '2026-09-03' }),
    row({ work_type: 'racking', planned_start_date: '2026-09-08' }),
    row({ work_type: 'electrical', planned_start_date: '2026-09-12' }),
    row({ work_type: 'racking', planned_start_date: '2026-01-01', deleted_at: '2026-02-01' }),
  ]), '2026-09-08');
});
test('completed early work remains in PREWORK grouping, steel after entry does not', () => {
  assert.equal(helpers.isConstructionPrework(row({ planned_start_date: '2026-09-01', is_completed: true }), '2026-09-08'), true);
  assert.equal(helpers.isConstructionPrework(row({ work_type: 'steel', planned_start_date: '2026-09-10' }), '2026-09-08'), false);
});
test('no date is unscheduled, same-day is scheduled, past is in progress, completed wins', () => {
  assert.equal(helpers.classifyConstructionItem(row(), null, '2026-09-08'), 'UNSCHEDULED');
  assert.equal(helpers.classifyConstructionItem(row({ planned_start_date: '2026-09-08' }), null, '2026-09-08'), 'SCHEDULED');
  assert.equal(helpers.classifyConstructionItem(row({ planned_start_date: '2026-09-07' }), null, '2026-09-08'), 'IN_PROGRESS');
  assert.equal(helpers.classifyConstructionItem(row({ is_completed: true }), null, '2026-09-08'), 'COMPLETED');
});
test('completion is an atomic pair: today default, manual date preserved, undo clears date', () => {
  assert.deepEqual(helpers.constructionCompletionPatch(true, null, '2026-09-08'), { is_completed: true, actual_completed_date: '2026-09-08' });
  assert.deepEqual(helpers.constructionCompletionPatch(true, '2026-09-01', '2026-09-08'), { is_completed: true, actual_completed_date: '2026-09-01' });
  assert.deepEqual(helpers.constructionCompletionPatch(false, '2026-09-01', '2026-09-08'), { is_completed: false, actual_completed_date: null });
});
test('one completion date displays planned before completion and actual after completion', () => {
  const item = row({ planned_end_date: '2026-09-30', actual_completed_date: '2026-09-20', completed_date: '1999-01-01' });
  assert.equal(helpers.getConstructionEndDate(item), '2026-09-30');
  assert.equal(helpers.getConstructionEndDate({ ...item, is_completed: true }), '2026-09-20');
  assert.equal(helpers.getConstructionEndDate({ ...item, completed_date: '2099-01-01' }), '2026-09-30');
});
test('outer construction stage follows V2 start, end, and completion fields', () => {
  const display = values => helpers.getConstructionOuterDisplay(row(values), '2026-09-05');
  assert.deepEqual(display({ planned_start_date: null }), { status: 'UNSCHEDULED', label: '未排程', date: null });
  assert.deepEqual(display({ planned_start_date: '2026-09-06', planned_end_date: '2026-09-30' }), { status: 'EXPECTED_START', label: '預計進場 09/06', date: '2026-09-06' });
  assert.deepEqual(display({ planned_start_date: '2026-09-05', planned_end_date: '2026-09-30' }), { status: 'EXPECTED_END', label: '預計完工 09/30', date: '2026-09-30' });
  assert.deepEqual(display({ planned_start_date: '2026-09-04', planned_end_date: '2026-09-30' }), { status: 'EXPECTED_END', label: '預計完工 09/30', date: '2026-09-30' });
  assert.deepEqual(display({ planned_start_date: '2026-09-04' }), { status: 'IN_PROGRESS', label: '施工中', date: null });
  assert.deepEqual(display({ is_completed: true, actual_completed_date: '2026-09-03', completed_date: '2099-01-01' }), { status: 'COMPLETED', label: '已完工 09/03', date: '2026-09-03' });

  const summary = renderToStaticMarkup(React.createElement(DateDualInput, {
    expectedDate: '2026-09-06', completionDate: '2026-09-30', baseDate: '2026-09-05',
    summaryText: '預計進場 09/06', onChange() {},
  }));
  assert.match(summary, /預計進場 09\/06/);
  const projectsPageSource = fs.readFileSync(path.resolve(__dirname, '../app/projects/[[...filter]]/page.tsx'), 'utf8');
  assert.match(projectsPageSource, /getConstructionOuterDisplay/);
  assert.doesNotMatch(projectsPageSource, /showCompletionInSummary/);
  const adapterSource = fs.readFileSync(path.resolve(__dirname, 'db/poc-supabase.ts'), 'utf8');
  assert.match(adapterSource, /completion_date`] = getConstructionEndDate\(prog\)/);
  assert.doesNotMatch(adapterSource, /completion_date`] = prog\.completed_date/);
  const updateProjectSource = adapterSource.slice(adapterSource.indexOf('updateProject: async'));
  assert.ok(
    updateProjectSource.indexOf('validateProjectConstructionCompletionUpdates(p)')
      < updateProjectSource.indexOf(".from('projects')"),
    'future completion must be rejected before the project update query',
  );
});
test('sort uses order, creation timestamp and ID without changing original array', () => {
  const rows = [row({ id: 'b', sort_order: 20 }), row({ id: 'c' }), row({ id: 'a' }), row({ id: 'd', created_at: '2025-01-01' })];
  assert.deepEqual(helpers.sortConstructionRows(rows).map(r => r.id), ['d', 'a', 'c', 'b']);
  assert.equal(rows[0].id, 'b');
});
test('legacy unnamed other displays other without any write or legacy end date', () => {
  const legacy = row();
  const html = renderToStaticMarkup(React.createElement(ConstructionProgressSection, { model: model([legacy]) }));
  assert.match(html, /placeholder="其他"/);
  assert.doesNotMatch(html, /2020-01-01/);
  assert.equal(legacy.work_name, null);
  assert.equal(helpers.getConstructionWorkLabel(legacy), '其他');
  assert.match(html, />完工日期</);
  assert.doesNotMatch(html, />預計完工<|>實際完工</);
});
test('PREWORK heading is conditional and completed PREWORK remains visible there', () => {
  const plain = renderToStaticMarkup(React.createElement(ConstructionProgressSection, { model: model([row()]) }));
  assert.doesNotMatch(plain, />前置作業</);
  const html = renderToStaticMarkup(React.createElement(ConstructionProgressSection, { model: model([
    row({ work_name: '防水', planned_start_date: '2026-09-01', is_completed: true, actual_completed_date: '2026-09-02' }),
    row({ id: 'main', work_type: 'racking', planned_start_date: '2026-09-08' }),
  ]) }));
  assert.match(html, />前置作業</);
  assert.match(html, /已完工/);
  assert.match(html, /正式進場：2026-09-08/);
});
test('multiple other rows render independently and disabled main rows do not define entry', () => {
  const html = renderToStaticMarkup(React.createElement(ConstructionProgressSection, { model: model([
    row({ work_name: '防水' }), row({ id: 'row-2', work_name: '清運' }),
    row({ id: 'main', work_type: 'racking', planned_start_date: '2026-01-01', status_override: 'disabled' }),
  ]) }));
  assert.match(html, /防水/); assert.match(html, /清運/); assert.match(html, /正式進場：未排程/);
});
test('viewer cannot edit construction rows or create/delete/enable work', () => {
  const html = renderToStaticMarkup(React.createElement(ConstructionProgressSection, { model: { ...model([row()]), canEdit: false } }));
  assert.doesNotMatch(html, /新增其他工項|確認刪除|>刪除</);
  assert.match(html, /disabled=""/);
});
test('Workflow and original progress tab render the same shared model and persisted rows', () => {
  const shared = model([row({ work_name: '共用工項', notes: '同一份資料' })]);
  for (const tab of ['workflow', 'progress']) {
    let modelReads = 0;
    const { ProjectDetailModal } = load('../components/ProjectDetailModal.tsx', {
      react: { ...React, useState: initial => React.useState(initial === 'basic' ? tab : initial) },
      '@/lib/db': { dbAdapter: {} },
      './UserContext': { useUser: () => ({ currentUser: { role: 'EDITOR', id: 'user', name: 'user' } }) },
      './DateDualInput': { DateDualInput: () => null },
      './ProjectWorkflow': { ProjectWorkflow: props => props.construction },
      './ConstructionProgressSection': { ConstructionProgressSection, ConstructionWorkTypeControls },
      './useConstructionProgress': { useConstructionProgress: () => { modelReads++; return shared; } },
    });
    const html = renderToStaticMarkup(React.createElement(ProjectDetailModal, { project: { id: 'project-1', name: 'Test' }, onClose() {}, onUpdate() {} }));
    assert.equal(modelReads, 1);
    assert.match(html, /共用工項/); assert.match(html, /同一份資料/); assert.match(html, /施工進度/);
  }
});

function fakeClient(result = { data: row(), error: null }) {
  const calls = [];
  const query = { then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } };
  for (const name of ['select', 'eq', 'neq', 'or', 'is', 'order', 'insert', 'update', 'single']) {
    query[name] = (...args) => { calls.push([name, ...args]); return query; };
  }
  return { calls, from: table => { calls.push(['from', table]); return query; } };
}
test('blank other name is blocked before insert; no mutation query', async () => {
  assert.ok(helpers.validateConstructionWorkName('  '));
  const client = fakeClient();
  await assert.rejects(createConstructionProgressAdapter(client).create('p', { work_type: 'other', work_name: ' ', sort_order: 0 }), /工項名稱/);
  assert.equal(client.calls.length, 0);
});
test('read contract is construction table scoped to project and active rows, stable ordering', async () => {
  const client = fakeClient({ data: [row()], error: null });
  await createConstructionProgressAdapter(client).list('p');
  assert.deepEqual(client.calls, [['from', 'project_construction_progress'], ['select', '*'], ['eq', 'project_id', 'p'], ['is', 'deleted_at', null], ['order', 'sort_order'], ['order', 'created_at'], ['order', 'id']]);
});

test('conflict warning uses V2 planned end dates and excludes same-project work', async () => {
  const current = row({ contractor_id: 'c', planned_start_date: '2026-09-08', planned_end_date: '2026-09-15' });
  const other = { ...current, project_id: 'other-project', projects: { project_name: 'Other' } };
  assert.equal(helpers.getConstructionConflict(current, [other]), other);
  assert.equal(helpers.getConstructionConflict(current, [{ ...other, project_id: current.project_id }]), undefined);
  assert.equal(helpers.getConstructionConflict({ ...current, planned_end_date: null }, [other]), undefined);
  const client = fakeClient({ data: [other], error: null });
  await createConstructionProgressAdapter(client).conflicts('p');
  const selection = client.calls.find(c => c[0] === 'select')[1];
  assert.match(selection, /planned_end_date/);
  assert.doesNotMatch(selection, /completed_date/);
});
test('update targets exact project/row, leaves legacy name and completed_date untouched', async () => {
  const client = fakeClient();
  await createConstructionProgressAdapter(client).update('p', 'id', { notes: 'edited', planned_end_date: '2026-09-30' });
  assert.deepEqual(client.calls.find(c => c[0] === 'update')[1], { notes: 'edited', planned_end_date: '2026-09-30' });
  assert.ok(client.calls.some(c => c[0] === 'eq' && c[1] === 'id' && c[2] === 'id'));
  assert.ok(client.calls.some(c => c[0] === 'eq' && c[1] === 'project_id' && c[2] === 'p'));
  assert.ok(client.calls.some(c => c[0] === 'single'));
});
test('planned end can be changed repeatedly and completion preserves it', async () => {
  const client = fakeClient();
  const adapter = createConstructionProgressAdapter(client);
  for (const planned_end_date of ['2026-10-08', '2026-10-15', '2026-10-20']) {
    await adapter.update('p', 'id', { planned_end_date });
  }
  assert.deepEqual(client.calls.filter(call => call[0] === 'update').map(call => call[1].planned_end_date), [
    '2026-10-08', '2026-10-15', '2026-10-20',
  ]);

  const item = row({ planned_end_date: '2026-10-20' });
  const completed = { ...item, ...helpers.constructionCompletionPatch(true, null, '2026-10-12') };
  assert.equal(completed.planned_end_date, '2026-10-20');
  assert.equal(completed.actual_completed_date, '2026-10-12');
  const reopened = { ...completed, ...helpers.constructionCompletionPatch(false, completed.actual_completed_date, '2026-10-12') };
  assert.equal(reopened.actual_completed_date, null);
  assert.equal(helpers.getConstructionEndDate(reopened), '2026-10-20');
  await adapter.update('p', 'id', { planned_end_date: '2026-10-25' });
  assert.equal(client.calls.filter(call => call[0] === 'update').at(-1)[1].planned_end_date, '2026-10-25');

  const sectionSource = fs.readFileSync(path.resolve(__dirname, '../components/ConstructionProgressSection.tsx'), 'utf8');
  assert.match(sectionSource, /event\.target\.checked \? null : row\.actual_completed_date/);
  assert.doesNotMatch(sectionSource, /event\.target\.checked \? row\.planned_end_date/);
});
test('actual completion accepts today and past, but blocks future before a query', async () => {
  assert.equal(helpers.validateActualCompletionDate('2026-09-05', '2026-09-05'), null);
  assert.equal(helpers.validateActualCompletionDate('2026-09-04', '2026-09-05'), null);
  assert.equal(helpers.validateActualCompletionDate('2026-09-06', '2026-09-05'), '實際完工日期不可晚於今天');
  const futureClient = fakeClient();
  await assert.rejects(
    createConstructionProgressAdapter(futureClient).update('p', 'id', { is_completed: true, actual_completed_date: '9999-01-01' }),
    /實際完工日期不可晚於今天/,
  );
  assert.equal(futureClient.calls.length, 0);
});
test('a future planned end remains valid while incomplete', async () => {
  const client = fakeClient();
  await createConstructionProgressAdapter(client).update('p', 'id', { planned_end_date: '9999-01-01' });
  assert.ok(client.calls.some(call => call[0] === 'update'));
});
test('fixed disable keeps dates/completion/notes; other deletion is type-scoped soft delete', async () => {
  const client = fakeClient();
  const adapter = createConstructionProgressAdapter(client);
  await adapter.update('p', 'id', { status_override: 'disabled' });
  assert.deepEqual(client.calls.find(c => c[0] === 'update')[1], { status_override: 'disabled' });
  client.calls.length = 0;
  await adapter.removeOther('p', 'id');
  assert.deepEqual(Object.keys(client.calls.find(c => c[0] === 'update')[1]), ['deleted_at']);
  assert.ok(client.calls.some(c => c[0] === 'eq' && c[1] === 'work_type' && c[2] === 'other'));
});
test('insert stays in construction domain; DB/RLS errors are not treated as saves', async () => {
  const client = fakeClient();
  await createConstructionProgressAdapter(client).create('p', { work_type: 'other', work_name: '防水', sort_order: 60 });
  assert.deepEqual(client.calls[0], ['from', 'project_construction_progress']);
  assert.deepEqual(client.calls.find(c => c[0] === 'insert')[1], { project_id: 'p', work_type: 'other', work_name: '防水', sort_order: 60 });
  await assert.rejects(createConstructionProgressAdapter(fakeClient({ data: null, error: new Error('RLS denied') })).update('p', 'id', { notes: 'x' }), /RLS denied/);
});
