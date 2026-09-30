const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const { act, create } = require('react-test-renderer');
const load = (file, mocks) => require('./test-load-ts.cjs')(path.join(__dirname, file), mocks);
const user = { id: 'user-1', name: 'Tester', role: 'ADMIN', is_active: true };
const groups = [{ id: 'engineering', key: 'ENGINEERING', name: '工程', is_active: true, sort_order: 1 }];
const projects = ['A', 'B'].map(letter => ({
  id: `project-${letter}`, name: `地點 ${letter}`, address: `地址 ${letter}`, is_active: true,
}));
const task = {
  id: 'task-1', task_type: '開會', project_name: '地點 A', project_id: null, address: null,
  task_date: '2026-09-30', work_group_id: 'engineering', status: '已排程', title: 'Test',
  google_event_id: 'event-1', main_assignee_id: null,
};
const session = { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) } };

function environment(t, beforeRestore = () => {}) {
  t.after(beforeRestore);
  const globals = {
    window: { localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {} },
    document: { body: { style: {} }, addEventListener() {}, removeEventListener() {} },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => ({ success: true }) };
  });
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = setTimer(...args);
    timer.unref();
    return timer;
  });
  return calls;
}

const stubComponents = Object.fromEntries([
  'ScheduleTaskFormDialog', 'ScheduleDeletedAuditDialog', 'TodoForm', 'TodoInlineText', 'TodoContextMenu', 'TodoRow',
].map(name => [`@/components/${name}`, { [name]: () => null }]));

async function pageFixture(t, failFirst = false) {
  let renderer;
  const calls = environment(t, () => renderer && act(() => renderer.unmount()));
  let reads = 0;
  let fail = failFirst;
  const dbAdapter = {
    getScheduleTasks: async () => { reads++; return []; },
    getScheduleTaskMembers: async () => [], getProjects: async () => [], getUsers: async () => [],
    getTodos: async () => [], getMemberWorkGroups: async () => [],
    getWorkGroups: async () => { if (fail) throw new Error('fixture read failure'); return groups; },
  };
  t.mock.method(console, 'error', () => {});
  const Page = load('../app/schedule/page.tsx', {
    ...stubComponents,
    '@/lib/db': { dbAdapter },
    '@/lib/db/supabaseClient': { supabase: session },
    '@/components/UserContext': { useUser: () => ({ currentUser: user }) },
    '@/hooks/useWorkGroups': { useWorkGroups: () => ({ ready: true, defaultGroup: groups[0] }) },
    '@/hooks/useScheduleWeather': { useScheduleWeather: () => () => null },
  }).default;
  const mount = async () => { await act(async () => { renderer = create(React.createElement(Page)); }); };
  await mount();
  return {
    calls, get renderer() { return renderer; }, get reads() { return reads; },
    recover: () => { fail = false; },
    rerender: async () => { await act(async () => renderer.update(React.createElement(Page))); },
    remount: async () => { act(() => renderer.unmount()); await mount(); },
  };
}
const noReconcile = calls => assert.equal(calls.filter(call => call.url.includes('/reconcile')).length, 0);

test('CPU: initial Schedule mount loads data with zero reconcile calls', async t => {
  const fixture = await pageFixture(t);
  assert.equal(fixture.reads, 1);
  noReconcile(fixture.calls);
});
test('CPU: Schedule rerender makes zero reconcile calls', async t => {
  const fixture = await pageFixture(t);
  await fixture.rerender();
  assert.equal(fixture.reads, 1);
  noReconcile(fixture.calls);
});
test('CPU: refresh / route re-entry loads data with zero reconcile calls', async t => {
  const fixture = await pageFixture(t);
  await fixture.remount();
  assert.equal(fixture.reads, 2);
  noReconcile(fixture.calls);
});
test('CPU: error retry only retries Schedule data loading', async t => {
  const fixture = await pageFixture(t, true);
  const retry = fixture.renderer.root.findAllByType('button').find(node => node.props.children === '重試');
  assert.ok(retry);
  fixture.recover();
  await act(async () => retry.props.onClick());
  assert.equal(fixture.reads, 2);
  assert.equal(fixture.renderer.root.findAllByType('button').some(node => node.props.children === '重試'), false);
  noReconcile(fixture.calls);
});

function persistenceFixture() {
  let saved = { ...task };
  const adapter = {
    createScheduleTask: async data => (saved = { ...data, id: task.id }),
    updateScheduleTask: async (_id, data) => (saved = { ...saved, ...data }),
    deleteScheduleTask: async () => { saved = { ...saved, status: '取消' }; },
    getScheduleTasks: async () => [saved],
  };
  const { dbAdapter } = load('db/index.ts', {
    './mock': { mockDbAdapter: adapter }, './poc-supabase': { pocSupabaseAdapter: adapter },
    './supabaseClient': { supabase: session },
    './work-group-adapter': { createWorkGroupAdapter: () => ({}) },
    './personnel-workspace-adapter': { createPersonnelWorkspaceAdapter: () => ({}) },
    './materials': { createMaterialsAdapter: () => ({}) },
  });
  return { dbAdapter, get saved() { return saved; } };
}
for (const action of ['CREATE', 'UPDATE', 'DELETE']) {
  test(`CPU: Schedule ${action} retains POST /api/google-calendar/sync`, async t => {
    const calls = environment(t);
    const { dbAdapter } = persistenceFixture();
    if (action === 'CREATE') await dbAdapter.createScheduleTask(task, []);
    if (action === 'UPDATE') await dbAdapter.updateScheduleTask(task.id, { title: 'Updated' }, []);
    if (action === 'DELETE') await dbAdapter.deleteScheduleTask(task.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/google-calendar/sync');
    assert.equal(calls[0].method, 'POST');
    assert.equal(JSON.parse(calls[0].body).action, action);
    assert.equal(JSON.parse(calls[0].body).task.id, task.id);
  });
}
for (const route of ['reconcile', 'reconcile/cron']) {
  test(`CPU: ${route} POST route remains callable`, async () => {
    const { POST } = load(`../app/api/google-calendar/${route}/route.ts`, {
      '@/lib/google-calendar': { GOOGLE_CALENDAR_ID: 'fixture' },
      '@/lib/server/google-calendar-reconcile': { reconcileGoogleCalendarCore: () => assert.fail('external call') },
      '@/lib/server/supabase-auth': { requireActiveTeamMember: () => assert.fail('external auth') },
      '@/lib/server/external-side-effect-guard': { getExternalSideEffectGuard: () => ({ disabled: true, reason: 'test' }) },
    });
    assert.equal(typeof POST, 'function');
    const result = await POST(new Request('http://localhost/api/google-calendar/' + route, { method: 'POST' }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).skipped, true);
  });
}

async function formFixture(t, initialData = task, onSave) {
  let renderer;
  environment(t, () => renderer && act(() => renderer.unmount()));
  const submitted = [];
  const { ScheduleTaskForm } = load('../components/ScheduleTaskForm.tsx', {
    './MaintenanceUsage': { MaintenanceEquipmentRecords: () => null },
    './UserContext': { useUser: () => ({ currentUser: user }) },
    '@/lib/db': { dbAdapter: {
      getProjects: async () => projects, getUsers: async () => [user],
      getWorkGroups: async () => groups, getActivityLogs: async () => [],
    } },
    '@/hooks/useScheduleTaskTypes': { useScheduleTaskTypes: () => ({
      activeTaskTypes: ['施工', '開會', '其他', '內勤', '休假'].map(name => ({ id: name, name })),
      defaultTaskType: '施工', error: null, isLoading: false, shouldShowLegacyValue: false,
    }) },
  });
  const props = {
    initialData, initialMemberIds: [], onCancel() {}, isSubmitting: false,
    onSubmit: async data => { submitted.push(data); if (onSave) await onSave(data); },
  };
  await act(async () => { renderer = create(React.createElement(ScheduleTaskForm, props)); });
  const location = () => renderer.root.findAllByType('input').find(node => ['地點', '案場'].includes(node.props['aria-label']));
  const submit = async () => { await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })); return submitted.at(-1); };
  return {
    location, submit, submitted, get renderer() { return renderer; },
    changeType: async value => { await act(async () => renderer.root.findAllByType('select').find(node => node.props.required).props.onChange({ target: { value } })); },
    choose: async name => {
      await act(async () => location().props.onChange({ target: { value: '地點' } }));
      const option = renderer.root.findAll(node => node.type === 'div' && typeof node.props.onClick === 'function')
        .find(node => node.findAllByType('span').some(span => span.props.children === name));
      assert.ok(option, `existing location ${name} is selectable`);
      await act(async () => option.props.onClick());
    },
    reopen: async saved => {
      act(() => renderer.unmount());
      await act(async () => { renderer = create(React.createElement(ScheduleTaskForm, { ...props, initialData: saved })); });
    },
  };
}

test('meeting: changing from a bound project preserves the location', async t => {
  const form = await formFixture(t, { ...task, task_type: '施工', project_id: projects[0].id, address: projects[0].address });
  await form.changeType('開會');
  assert.equal(form.location().props.value, '地點 A');
  assert.equal((await form.submit()).project_name, '地點 A');
});
test('meeting: existing location selector opens on focus and supports selection', async t => {
  const form = await formFixture(t);
  await act(async () => form.location().props.onFocus());
  assert.ok(form.renderer.root.findAll(node => node.type === 'div' && typeof node.props.onClick === 'function').length > 0);
  await form.choose('地點 A');
  assert.equal(form.location().props.value, '地點 A');
});
test('meeting: selecting existing location A updates form state', async t => {
  const form = await formFixture(t, { ...task, project_name: '' });
  await form.choose('地點 A');
  assert.equal(form.location().props.value, '地點 A');
  assert.equal((await form.submit()).project_name, '地點 A');
});
test('meeting: selecting A then B updates form state to B', async t => {
  const form = await formFixture(t);
  await form.choose('地點 A');
  await form.choose('地點 B');
  assert.equal(form.location().props.value, '地點 B');
  assert.equal((await form.submit()).project_name, '地點 B');
});
test('meeting: edit hydrates the saved location', async t => {
  const form = await formFixture(t, { ...task, project_name: '自訂會議室' });
  assert.equal(form.location().props.value, '自訂會議室');
});
test('meeting: legacy address is not overwritten by project hydration', async t => {
  const form = await formFixture(t, { ...task, project_name: null, project_id: projects[0].id, address: '既有會議地址' });
  assert.equal(form.location().props.value, '既有會議地址');
  assert.equal((await form.submit()).project_name, '既有會議地址');
});
test('meeting: submit carries location without forcing project binding', async t => {
  const form = await formFixture(t);
  await form.choose('地點 B');
  const payload = await form.submit();
  assert.equal(payload.task_type, '開會');
  assert.equal(payload.project_name, '地點 B');
  assert.equal(payload.project_id, null);
  assert.equal(payload.address, null);
});
for (const mode of ['create', 'update']) {
  test(`meeting: ${mode}, save and reopen preserve selected location`, async t => {
    const persistence = persistenceFixture();
    const form = await formFixture(t, mode === 'create' ? { ...task, id: undefined } : task,
      data => mode === 'create' ? persistence.dbAdapter.createScheduleTask(data, []) : persistence.dbAdapter.updateScheduleTask(task.id, data, []));
    await form.choose('地點 B');
    await form.submit();
    const [saved] = await persistence.dbAdapter.getScheduleTasks();
    assert.equal(saved.project_name, '地點 B');
    await form.reopen(saved);
    assert.equal(form.location().props.value, saved.project_name);
  });
}
test('meeting: switching between location types preserves free text; no-location types clear it', async t => {
  const form = await formFixture(t, { ...task, project_name: '自由輸入' });
  for (const type of ['施工', '開會', '其他', '開會']) {
    await form.changeType(type);
    assert.equal(form.location().props.value, '自由輸入');
  }
  for (const type of ['內勤', '休假']) {
    await form.changeType(type);
    assert.equal(form.location(), undefined);
    const payload = await form.submit();
    assert.equal(payload.project_name, null);
    assert.equal(payload.project_id, null);
    assert.equal(payload.address, null);
  }
});
test('site work: existing project selector still stores project ID and address', async t => {
  const form = await formFixture(t, { ...task, task_type: '施工' });
  await form.choose('地點 B');
  const payload = await form.submit();
  assert.equal(payload.project_name, projects[1].name);
  assert.equal(payload.project_id, projects[1].id);
  assert.equal(payload.address, projects[1].address);
});
