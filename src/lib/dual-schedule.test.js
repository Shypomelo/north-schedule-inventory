const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const loadTsModule = relativePath => {
  const filename = path.join(__dirname, relativePath);
  const transpiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(transpiled, filename);
  return loaded.exports;
};

const {
  selectSchedulePrimaryCandidates,
  selectScheduleTasksByWorkGroup,
  selectTodayMemberSchedule,
} = loadTsModule('schedule-selectors.ts');

const task = (id, work_group_id, overrides = {}) => ({
  id,
  work_group_id,
  task_date: '2026-09-11',
  start_time: '09:00',
  is_all_day: false,
  is_tentative: false,
  status: '未開始',
  main_assignee_id: null,
  ...overrides,
});

test('engineering and project schedule tabs filter the single canonical task list', () => {
  const tasks = [task('engineering', 'wg-engineering'), task('project', 'wg-project')];
  assert.deepEqual(selectScheduleTasksByWorkGroup(tasks, 'wg-engineering').map(row => row.id), ['engineering']);
  assert.deepEqual(selectScheduleTasksByWorkGroup(tasks, 'wg-project').map(row => row.id), ['project']);
});

test('project primary candidates include active non-engineering editors but exclude viewers', () => {
  const users = [
    { id: 'engineer', category: 'ENGINEERING', role: 'ENGINEER' },
    { id: 'designer', category: 'OTHER', role: 'ENGINEER' },
    { id: 'admin', category: 'OTHER', role: 'ADMIN' },
    { id: 'viewer', category: 'OTHER', role: 'VIEWER' },
  ];
  assert.deepEqual(
    selectSchedulePrimaryCandidates(users, 'ENGINEERING').map(user => user.id),
    ['engineer'],
  );
  assert.deepEqual(
    selectSchedulePrimaryCandidates(users, 'PROJECT').map(user => user.id),
    ['engineer', 'designer', 'admin'],
  );
});

test('today schedule includes both groups when member is primary or collaborator', () => {
  const tasks = [
    task('engineering', 'wg-engineering', { main_assignee_id: 'me' }),
    task('project', 'wg-project'),
  ];
  const members = [{ task_id: 'project', user_id: 'me' }];
  assert.deepEqual(
    selectTodayMemberSchedule({ tasks, members, memberId: 'me', today: '2026-09-11' }).map(row => row.id),
    ['engineering', 'project'],
  );
});

test('app adapters persist explicit groups and ordinary edits cannot change a group', () => {
  const supabaseAdapter = fs.readFileSync(path.join(__dirname, 'db', 'poc-supabase.ts'), 'utf8');
  const mockAdapter = fs.readFileSync(path.join(__dirname, 'db', 'mock.ts'), 'utf8');
  const actions = fs.readFileSync(path.join(__dirname, 'schedule-task-actions.ts'), 'utf8');
  const schedulePage = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');
  const todoPage = fs.readFileSync(path.join(__dirname, '..', 'app', 'todos', 'page.tsx'), 'utf8');

  assert.match(supabaseAdapter, /work_group_id: t\.work_group_id/);
  assert.doesNotMatch(supabaseAdapter, /dbUpdates\.work_group_id/);
  assert.match(mockAdapter, /work_group_id: _ignoredWorkGroupId/);
  assert.match(actions, /work_group_id: task\.work_group_id/);
  assert.match(schedulePage, /work_group_id: targetWorkGroup\.id/);
  assert.match(todoPage, /work_group_id: engineeringWorkGroup\.id/);
});

test('schedule UI uses compact group tabs and keeps collaborators cross-group', () => {
  const schedulePage = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');
  const form = fs.readFileSync(path.join(__dirname, '..', 'components', 'ScheduleTaskForm.tsx'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');

  assert.match(schedulePage, /工程排程/);
  assert.match(schedulePage, /專案排程/);
  assert.match(schedulePage, /selectScheduleTasksByWorkGroup/);
  assert.doesNotMatch(schedulePage, /xl:min-w-\[1500px\]/);
  assert.match(form, /const coworkerUsers = users/);
  assert.match(form, /排程群組/);
  assert.match(dashboard, /display\.workGroupName/);
});
