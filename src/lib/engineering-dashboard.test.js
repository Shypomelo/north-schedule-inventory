const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadTypeScript(relativePath) {
  const filename = path.join(__dirname, relativePath);
  const sourceModule = new Module(filename, module);
  sourceModule.filename = filename;
  sourceModule.paths = module.paths;
  sourceModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  return sourceModule.exports;
}

const { selectTodayMemberSchedule } = loadTypeScript('schedule-selectors.ts');
const { buildDashboardProjectCards } = loadTypeScript('engineering-dashboard.ts');

const scheduleTask = (id, overrides = {}) => ({
  id,
  task_date: '2026-09-09',
  main_assignee_id: null,
  status: '未開始',
  is_tentative: false,
  is_all_day: false,
  start_time: '09:00',
  ...overrides,
});

test('today schedule selects primary and collaborator only for today', () => {
  const tasks = [
    scheduleTask('primary', { main_assignee_id: 'me' }),
    scheduleTask('collaborator'),
    scheduleTask('unrelated', { main_assignee_id: 'other' }),
    scheduleTask('tomorrow', { task_date: '2026-09-10', main_assignee_id: 'me' }),
  ];
  const result = selectTodayMemberSchedule({
    tasks,
    members: [{ task_id: 'collaborator', user_id: 'me' }],
    memberId: 'me',
    today: '2026-09-09',
  });
  assert.deepEqual(result.map(task => task.id), ['primary', 'collaborator']);
});

const milestone = (id, plannedDate = null) => ({ id, label: id, planned_date: plannedDate });
const responsibility = (projectId, projectName, positionId, current, previous = null) => ({
  project: { id: projectId, name: projectName, is_active: true },
  position: { id: positionId, name: positionId, sort_order: 1 },
  current_milestone: current,
  previous_milestone: previous,
});

test('project progress groups multiple positions into one card and retains cross-position previous milestone', () => {
  const previous = milestone('previous-other-position');
  const cards = buildDashboardProjectCards([
    responsibility('p1', 'Project One', '工程', milestone('engineering-current', '2026-09-10'), previous),
    responsibility('p1', 'Project One', '結構設計', milestone('design-current', '2026-09-12')),
  ], '2026-09-09');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].progress.length, 2);
  assert.equal(cards[0].progress.find(group => group.positionName === '工程').previous.id, 'previous-other-position');
});

test('project cards sort overdue, nearest dated, then no date', () => {
  const cards = buildDashboardProjectCards([
    responsibility('none', 'No date', '工程', milestone('none')),
    responsibility('later', 'Later', '工程', milestone('later', '2026-09-15')),
    responsibility('overdue', 'Overdue', '工程', milestone('overdue', '2026-09-08')),
    responsibility('near', 'Near', '工程', milestone('near', '2026-09-10')),
  ], '2026-09-09');
  assert.deepEqual(cards.map(card => card.project.id), ['overdue', 'near', 'later', 'none']);
});

test('Todo adapter uses Supabase scoped sources and never falls back to localStorage Todo methods', () => {
  const adapter = fs.readFileSync(path.join(__dirname, 'db', 'poc-supabase.ts'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, 'db', 'index.ts'), 'utf8');
  assert.match(adapter, /getTodos:[\s\S]*?from\('todos'\)[\s\S]*?eq\('scope', 'TEAM'\)/);
  assert.match(adapter, /getPrivateTodos:[\s\S]*?from\('todos'\)[\s\S]*?eq\('scope', 'PRIVATE'\)/);
  const teamQuery = adapter.slice(adapter.indexOf('getTodos:'), adapter.indexOf('createTodo:'));
  const privateQuery = adapter.slice(adapter.indexOf('getPrivateTodos:'), adapter.indexOf('createPrivateTodo:'));
  for (const query of [teamQuery, privateQuery]) {
    assert.match(query, /order\('created_at', \{ ascending: false \}\)/);
    assert.match(query, /limit\(50\)/);
  }
  assert.match(adapter, /updateTodo:[\s\S]*?update\(buildTeamTodoPayload\(updates\)\)[\s\S]*?eq\('scope', 'TEAM'\)/);
  assert.match(adapter, /updatePrivateTodo:[\s\S]*?payload\.status = updates\.status[\s\S]*?eq\('scope', 'PRIVATE'\)/);
  assert.match(index, /\.\.\.todoAdapter/);
  assert.doesNotMatch(index, /getTodos:\s*hasSupabase\s*\?[^\n]+:\s*mockDbAdapter\.getTodos/);
  assert.doesNotMatch(index, /getPrivateTodos:\s*[^\n]*mockDbAdapter/);
});

test('Dashboard uses the shared Todo adapters and keeps the route responsive', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
  const layout = fs.readFileSync(path.join(__dirname, '..', 'components', 'LayoutContentV3.tsx'), 'utf8');
  assert.match(dashboard, /dbAdapter\.getPrivateTodos\(\)/);
  assert.match(dashboard, /dbAdapter\.getTodos\(\)/);
  assert.match(dashboard, /dbAdapter\.updatePrivateTodo\(todo\.id, \{ status: '已完成' \}\)/);
  assert.match(dashboard, /dbAdapter\.updateTodo\(todo\.id, \{ status: '已完成' \}\)/);
  assert.match(dashboard, /initialMilestoneId=\{selectedProject\.milestoneId\}/);
  assert.match(dashboard, /useState\(true\)/);
  assert.match(dashboard, /隱藏已完成/);
  assert.match(dashboard, /!hideCompletedPrivate \|\| todo\.status !== '已完成'/);
  assert.match(dashboard, /!hideCompletedTeam \|\| todo\.status !== '已完成'/);
  assert.doesNotMatch(layout, /min-w-\[1400px\]/);
  assert.match(layout, /pt-14 md:pt-0/);
});

test('Dashboard today schedule reuses Schedule presentation, weather, member, map, and detail sources', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
  const schedule = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');
  assert.match(dashboard, /getScheduleTaskPresentation\(task, projects, allUsers, taskMembers, workGroups\)/);
  assert.match(schedule, /getScheduleTaskPresentation\(task, projects, users, members\)/);
  assert.match(dashboard, /useScheduleWeather\(todayTasks, projects\)/);
  assert.match(schedule, /useScheduleWeather\(visibleWeatherTasks, projects\)/);
  assert.match(dashboard, /display\.collaboratorDisplay/);
  assert.match(dashboard, /display\.workGroupName/);
  assert.match(dashboard, /href=\{display\.mapUrl\}/);
  assert.match(dashboard, /event => event\.stopPropagation\(\)/);
  assert.match(dashboard, /<ScheduleTaskDetail/);
  assert.match(dashboard, /onClick=\{\(\) => setSelectedTask\(task\)\}/);
});

test('project responsibilities use the projects deleted_at contract instead of a nonexistent is_active column', () => {
  const adapter = fs.readFileSync(path.join(__dirname, 'db', 'poc-supabase.ts'), 'utf8');
  const method = adapter.slice(
    adapter.indexOf('getMemberProjectResponsibilities:'),
    adapter.indexOf('// --- Todos ---'),
  );
  assert.match(method, /from\('projects'\)[\s\S]*?is\('deleted_at', null\)/);
  assert.doesNotMatch(method, /eq\('is_active', true\)/);
});
