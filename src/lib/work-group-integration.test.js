const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
function load(file, imports = {}) {
  const filename = path.join(__dirname, file);
  const m = new Module(filename);
  m.filename = filename;
  m.paths = module.paths;
  m.require = id => imports[id] || {};
  m._compile(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  return m.exports;
}
const { resolveMemberDefaultWorkGroup: resolve, requireTodoWorkGroup, selectActiveWorkGroups } = load('work-groups.ts');
const { saveTodoText, canEditTodoText } = load('todo-text-actions.ts');
const { createWorkGroupAdapter } = load('db/work-group-adapter.ts');
const groups = [
  { id: 'e', key: 'ENGINEERING', is_active: true, sort_order: 10, google_calendar_sync_enabled: true },
  { id: 'p', key: 'PROJECT', is_active: true, sort_order: 20, google_calendar_sync_enabled: false },
];
const link = (work_group_id, is_default = false, member_id = 'member') => ({ member_id, work_group_id, is_default });
const actor = { id: 'member', is_active: true, role: 'ENGINEER' };
const todo = (scope = 'TEAM', group = 'e') => ({
  id: 'todo', title: 'old', content: 'old content', scope, work_group_id: scope === 'PRIVATE' ? null : group,
  created_by: 'member', status: '待安排', project_id: 'project', task_type: 'type',
  assigned_to: 'assignee', assigned_by: 'assigner', converted_task_id: 'schedule',
  rejected_by: 'rejector', rejected_at: 'yesterday', rejection_reason: 'reason',
});

// In-memory query double: no credentials, sockets or real services.
function fixture(role = 'ADMIN', seed = {}) {
  const tables = { work_groups: structuredClone(groups), member_work_groups: [],
    team_members: [{ email: 'fixture@example.test', role, is_active: true, deleted_at: null }],
    todos: [], ...structuredClone(seed) };
  const writes = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { email: 'fixture@example.test' } }, error: null }) },
    from(table) {
      let op = 'select', payload, filters = [], single = false, limit = Infinity;
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { filters.push(row => row[k] === v); return q; },
        is(k, v) { filters.push(row => row[k] === v); return q; },
        in(k, values) { filters.push(row => values.includes(row[k])); return q; },
        limit(n) { limit = n; return q; },
        single() { single = true; return q; },
        insert(value) { op = 'insert'; payload = value; return q; },
        update(value) { op = 'update'; payload = value; return q; },
        delete() { op = 'delete'; return q; },
        then(ok, fail) {
          return Promise.resolve().then(() => {
            let rows = tables[table].filter(row => filters.every(f => f(row)));
            if (op !== 'select') {
              writes.push({ table, op, payload: structuredClone(payload) });
              if (client.failNextWrite) { client.failNextWrite = false; return { data: null, error: new Error('fixture failure') }; }
              if (op === 'insert') { rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: 'new', ...row })); tables[table].push(...rows); }
              if (op === 'update') rows.forEach(row => Object.assign(row, payload));
              if (op === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row));
              if (table === 'member_work_groups') assert.ok(tables[table].filter(row => row.is_default).length <= 1, 'partial unique invariant');
            }
            rows = rows.slice(0, limit);
            return { data: structuredClone(single ? rows[0] : rows), error: null };
          }).then(ok, fail);
        },
      };
      return q;
    },
  };
  return { client, tables, writes };
}
test('no membership requires configuration without mutating inputs', () => {
  const memberships = [];
  const result = resolve('member', memberships, groups);
  assert.equal(result.status, 'configuration-required');
  assert.equal(result.activeGroup, null);
  assert.equal(result.source, null);
  assert.deepEqual(memberships, []);
});
test('active ENGINEERING only resolves ENGINEERING', () => {
  assert.equal(resolve('member', [link('e', true)], groups).activeGroup.key, 'ENGINEERING');
});
test('active PROJECT only resolves PROJECT', () => {
  assert.equal(resolve('member', [link('p', true)], groups).activeGroup.key, 'PROJECT');
});
for (const groupId of ['p', 'e']) test('inactive-only ' + groupId + ' requires configuration without legacy fallback', () => {
  const inactiveGroups = groups.map(group => ({ ...group, is_active: group.id !== groupId }));
  const result = resolve('member', [link(groupId, true)], inactiveGroups);
  assert.equal(result.status, 'configuration-required');
  assert.equal(result.activeGroup, null);
  assert.equal(result.source, null);
});
test('active PROJECT plus inactive ENGINEERING resolves PROJECT', () => {
  const result = resolve('member', [link('p'), link('e', true)], groups.map(group => ({ ...group, is_active: group.id === 'p' })));
  assert.equal(result.activeGroup.key, 'PROJECT');
  assert.deepEqual(result.activeGroups.map(group => group.id), ['p']);
});
test('inactive default uses deterministic active membership fallback', () => {
  const result = resolve('member', [link('p'), link('e', true)], groups.map(group => ({ ...group, is_active: group.id === 'p' })));
  assert.equal(result.activeGroup.id, 'p');
  assert.equal(result.source, 'membership');
});
test('inactive default without another active membership requires configuration', () => {
  assert.equal(resolve('member', [link('p', true)], groups.map(group => ({ ...group, is_active: group.id !== 'p' }))).status, 'configuration-required');
});
test('general selector includes active groups only', () => {
  assert.deepEqual(selectActiveWorkGroups(groups.map(group => ({ ...group, is_active: group.id === 'p' }))).map(group => group.id), ['p']);
});
test('same position permits different Schedule defaults', () => {
  const members = [{ id: 'a', position: '電力設計' }, { id: 'b', position: '電力設計' }];
  const links = [link('e', true, 'a'), link('p', true, 'b')];
  assert.deepEqual(members.map(m => resolve(m.id, links, groups).activeGroup.key), ['ENGINEERING', 'PROJECT']);
  assert.doesNotMatch(read('work-groups.ts').split('export function resolveMemberDefaultWorkGroup')[1].split('export function resolveParticipantWorkGroups')[0], /\.position|\.category|\.role/);
});
test('membership adapter loads member-scoped rows without writes', async () => {
  const f = fixture('ADMIN', { member_work_groups: [link('p', true), link('e', true, 'other')] });
  assert.deepEqual(await createWorkGroupAdapter(f.client).getMemberWorkGroups('member'), [link('p', true)]);
  assert.equal(f.writes.length, 0);
});
for (const role of ['ENGINEER', 'VIEWER']) test(role + ' membership mutation blocked', async () => {
  const f = fixture(role);
  await assert.rejects(createWorkGroupAdapter(f.client).setMemberWorkGroups('member', ['p'], 'p'), /ADMIN/);
  assert.equal(f.writes.length, 0);
});
test('ADMIN joins two groups and switches unique default', async () => {
  const f = fixture('ADMIN', { member_work_groups: [link('e', true)] });
  const saved = await createWorkGroupAdapter(f.client).setMemberWorkGroups('member', ['e', 'p'], 'p');
  assert.equal(saved.filter(row => row.is_default).length, 1);
  assert.equal(saved.find(row => row.is_default).work_group_id, 'p');
});
test('ADMIN can remove all memberships', async () => {
  const f = fixture('ADMIN', { member_work_groups: [link('p', true)] });
  const saved = await createWorkGroupAdapter(f.client).setMemberWorkGroups('member', [], null);
  assert.deepEqual(saved, []);
  assert.equal(resolve('member', saved, groups).status, 'configuration-required');
});
test('invalid default blocked before writes', async () => {
  const f = fixture();
  await assert.rejects(createWorkGroupAdapter(f.client).setMemberWorkGroups('member', ['e'], 'p'));
  assert.equal(f.writes.length, 0);
});
test('membership failure explicitly reports partial-save risk', async () => {
  const f = fixture(); f.client.failNextWrite = true;
  await assert.rejects(createWorkGroupAdapter(f.client).setMemberWorkGroups('member', ['p'], 'p'), /部分成功/);
});
for (const group of groups) {
  test(group.key + ' TEAM query filters group; PRIVATE stays global', async () => {
    const f = fixture('ADMIN', { todos: [todo('TEAM', 'e'), todo('TEAM', 'p'), todo('PRIVATE')] });
    const adapter = load('db/poc-supabase.ts', { './supabaseClient': { supabase: f.client } }).pocSupabaseAdapter;
    assert.deepEqual((await adapter.getTodos(group.id)).map(t => t.work_group_id), [group.id]);
    assert.equal((await adapter.getPrivateTodos())[0].work_group_id, null);
  });
  test(group.key + ' TEAM create persists explicit group', async () => {
    const f = fixture();
    const adapter = load('db/poc-supabase.ts', { './supabaseClient': { supabase: f.client } }).pocSupabaseAdapter;
    assert.equal((await adapter.createTodo(todo('TEAM', group.id))).work_group_id, group.id);
    assert.equal(f.writes[0].payload.work_group_id, group.id);
  });
  test(group.key + ' Todo conversion inherits source group', () => {
    assert.equal(requireTodoWorkGroup(todo('TEAM', group.id)), group.id);
  });
}
test('TEAM conversion updates the canonical row without deleting it', async () => {
  const source = { ...todo('TEAM', 'e'), converted_task_id: null };
  const f = fixture('ADMIN', { todos: [source] });
  const adapter = load('db/poc-supabase.ts', { './supabaseClient': { supabase: f.client } }).pocSupabaseAdapter;

  await adapter.updateTodo(source.id, { status: '已排程', converted_task_id: 'schedule-1' });

  const persistedRows = await adapter.getTodos('e');
  assert.equal(persistedRows.length, 1);
  assert.equal(persistedRows[0].id, source.id);
  assert.equal(persistedRows[0].status, '已排程');
  assert.equal(persistedRows[0].converted_task_id, 'schedule-1');
  assert.deepEqual(f.writes.map(write => write.op), ['update']);
});
test('TEAM creation requires group, PRIVATE creation sends NULL', async () => {
  const f = fixture();
  const adapter = load('db/poc-supabase.ts', { './supabaseClient': { supabase: f.client } }).pocSupabaseAdapter;
  await assert.rejects(adapter.createTodo(todo('TEAM', null)));
  assert.equal(f.writes.length, 0);
  await adapter.createPrivateTodo({ title: 'private', created_by: 'member' });
  assert.equal(f.writes[0].payload.work_group_id, null);
});
test('PRIVATE or malformed Todo cannot convert to Schedule', () => {
  assert.throws(() => requireTodoWorkGroup(todo('PRIVATE')));
  assert.throws(() => requireTodoWorkGroup(todo('TEAM', null)));
});
for (const scope of ['TEAM', 'PRIVATE']) test(scope + ' text edit preserves metadata and converted Schedule', async () => {
  const source = todo(scope);
  const f = fixture('ADMIN', { todos: [source] });
  const adapter = load('db/poc-supabase.ts', { './supabaseClient': { supabase: f.client } }).pocSupabaseAdapter;
  const saved = await saveTodoText(adapter, source, actor, { title: ' new ', content: ' edited ', work_group_id: 'p', status: '取消' });
  assert.equal(saved.title, 'new'); assert.equal(saved.content, 'edited');
  for (const key of ['scope', 'work_group_id', 'status', 'created_by', 'project_id', 'task_type', 'assigned_to', 'assigned_by', 'converted_task_id', 'rejected_by', 'rejected_at', 'rejection_reason']) assert.equal(saved[key], source[key]);
  assert.deepEqual(f.writes.map(w => w.table), ['todos']);
  assert.ok(Object.keys(f.writes[0].payload).every(k => ['title', 'content', 'scope'].includes(k)));
});
test('private editor blocks other creator, inactive user and VIEWER', async () => {
  for (const user of [{ ...actor, id: 'other' }, { ...actor, is_active: false }, { ...actor, role: 'VIEWER' }]) {
    assert.equal(canEditTodoText(todo('PRIVATE'), user), false);
    await assert.rejects(saveTodoText({}, todo('PRIVATE'), user, { title: 'x', content: null }));
  }
});
for (const action of ['CREATE', 'UPDATE', 'DELETE']) test('PROJECT server ' + action + ' skips Google and failed-sync writes', async () => {
  let googleCalls = 0, dbWrites = 0;
  const eligibility = load('server/schedule-google-eligibility.ts').getScheduleGoogleEligibility;
  const route = load('../app/api/google-calendar/sync/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200 }) } },
    '@/lib/google-calendar': { GOOGLE_CALENDAR_ID: 'fixture', getGoogleCalendarClient: () => { googleCalls++; throw Error('must not call'); } },
    '@/lib/google-calendar-sync': { loadScheduleTaskSyncRow: async () => ({ id: 'task', work_group_id: requireTodoWorkGroup(todo('TEAM', 'p')) }) },
    '@/lib/server/supabase-auth': { requireActiveTeamMember: async () => ({ context: { member: { role: 'ENGINEER' }, supabase: { from: () => { dbWrites++; throw Error('must not write'); } } } }) },
    '@/lib/server/schedule-google-eligibility': { resolveScheduleGoogleEligibility: async () => eligibility({ work_group_id: 'p', work_groups: groups[1] }) },
    '@/lib/server/external-side-effect-guard': { getExternalSideEffectGuard: () => ({ disabled: false, projectRef: 'production', reason: null }) },
  });
  const response = await route.POST({ json: async () => ({ action, task: { id: 'task', work_group_id: 'e' } }) });
  assert.equal(response.status, 200); assert.equal(response.body.reason, 'google_calendar_ineligible');
  assert.equal(response.body.skipped, true); assert.equal(googleCalls, 0); assert.equal(dbWrites, 0);
});
test('Admin single modal owns work group and dashboard assignments', () => {
  const ui = read('../app/admin/users/page.tsx');
  assert.match(ui, /工作群組與預設工作空間/); assert.match(ui, /Dashboard 工作視角與預設視角/);
  assert.match(ui, /type="checkbox"/); assert.match(ui, /type="radio"/);
  assert.match(ui, /updateMemberWorkspaceProfile/);
  assert.doesNotMatch(ui, /MemberWorkGroupEditor|DashboardViewAssignments/);
});
test('Dashboard TEAM uses ENGINEERING; Today Schedule and My TODO stay cross-group/global', () => {
  const source = read('../app/page.tsx');
  assert.match(source, /getTodos\(engineeringGroup.id\)/); assert.match(source, /getPrivateTodos\(\)/);
  assert.match(source, /selectTodayMemberSchedule/); assert.match(source, /display.workGroupName/);
});
test('configuration-required UI is non-mutating and role-safe', () => {
  const hook = read('../hooks/useWorkGroups.ts');
  const schedule = read('../app/schedule/page.tsx');
  const todos = read('../app/todos/page.tsx');
  assert.match(hook, /configurationRequired: resolution\.status === 'configuration-required'/);
  for (const source of [schedule, todos]) {
    assert.match(source, /workspace\.configurationRequired/);
    assert.match(source, /目前沒有有效工作群組，請至人員管理設定。/);
    assert.match(source, /目前沒有可用的工作群組，請聯絡管理員完成設定。/);
  }
  assert.doesNotMatch(hook, /\.insert\(|\.update\(|\.rpc\(/);
});
test('shared touch text editor fits viewport and does not mutate Schedule', () => {
  for (const file of ['../app/page.tsx', '../app/todos/page.tsx']) assert.match(read(file), /TodoTextEditDialog/);
  const ui = read('../components/TodoTextEditDialog.tsx');
  assert.match(ui, /100dvh/); assert.match(ui, /min-w-0 w-full/); assert.match(ui, /text-base/);
  assert.match(ui, /min-h-11/); assert.match(ui, /不會同步修改排程/);
  assert.doesNotMatch(read('todo-text-actions.ts'), /logActivity\(|updateSchedule/);
});
test('TEAM history is reused; PRIVATE remains excluded from shared history', () => {
  const migration = read('../../supabase/migrations/20260908155148_scope_private_and_team_todos.sql');
  assert.match(migration, /event_action := 'UPDATE_TODO'/);
  assert.match(migration, /OLD.scope = 'PRIVATE' OR NEW.scope = 'PRIVATE'[\s\S]*RETURN NEW/);
});
test('Login uses device viewport and shrinkable layout without Auth changes', () => {
  assert.match(read('../app/layout.tsx'), /width: 'device-width', initialScale: 1/);
  const login = read('../app/login/page.tsx');
  assert.match(login, /data-testid="login-viewport"/); assert.match(login, /min-w-0 w-full max-w-full/);
  assert.match(login, /min-w-0 w-full max-w-md/); assert.match(login, /loginWithGoogle\(snapshot.redirectTo\)/);
});
