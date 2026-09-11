const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const loadTypeScript = require('./test-load-ts.cjs');
const { isActiveTeamTodo, selectActiveTeamTodos } = loadTypeScript(
  path.join(__dirname, 'todo-selectors.ts'),
);

const teamTodo = (id, overrides = {}) => ({
  id,
  scope: 'TEAM',
  status: '待安排',
  converted_task_id: null,
  work_group_id: 'engineering',
  ...overrides,
});

test('TEAM Todo uses one active-inbox contract across Dashboard, Schedule, and Todos', () => {
  const rows = [teamTodo('todo-1')];

  const dashboardRows = selectActiveTeamTodos(rows, 'engineering');
  const scheduleRows = selectActiveTeamTodos(rows, 'engineering');
  const todosPageRows = selectActiveTeamTodos(rows, 'engineering');

  assert.deepEqual(dashboardRows.map(row => row.id), ['todo-1']);
  assert.deepEqual(scheduleRows.map(row => row.id), ['todo-1']);
  assert.deepEqual(todosPageRows.map(row => row.id), ['todo-1']);
});

test('conversion preserves the TEAM Todo row and all active views stay hidden after reload', () => {
  const storedRows = [teamTodo('todo-1')];
  const scheduleTask = { id: 'schedule-1', source_todo_id: 'todo-1' };

  Object.assign(storedRows[0], {
    status: '已排程',
    converted_task_id: scheduleTask.id,
  });

  assert.equal(storedRows.length, 1, 'conversion must not delete the Todo row');
  assert.equal(storedRows[0].converted_task_id, scheduleTask.id);
  assert.equal(scheduleTask.source_todo_id, storedRows[0].id);
  assert.deepEqual(selectActiveTeamTodos(storedRows, 'engineering'), []);

  const reloadedRows = structuredClone(storedRows);
  assert.equal(reloadedRows.length, 1, 'the canonical row must survive reload');
  assert.equal(reloadedRows[0].status, '已排程');
  assert.equal(reloadedRows[0].converted_task_id, 'schedule-1');
  assert.deepEqual(selectActiveTeamTodos(reloadedRows, 'engineering'), []);
});

test('active TEAM selector excludes every non-inbox state and any converted row', () => {
  for (const status of ['已排程', '已完成', '取消', '已退件', '已收納']) {
    assert.equal(isActiveTeamTodo(teamTodo(status, { status })), false, status);
  }
  assert.equal(isActiveTeamTodo(teamTodo('linked', { converted_task_id: 'schedule-1' })), false);
});

test('ENGINEERING and PROJECT filters stay isolated while PRIVATE Todo is unaffected', () => {
  const privateTodo = teamTodo('private-1', {
    scope: 'PRIVATE',
    work_group_id: null,
  });
  const rows = [
    teamTodo('engineering-1'),
    teamTodo('project-1', { work_group_id: 'project' }),
    privateTodo,
  ];

  assert.deepEqual(selectActiveTeamTodos(rows, 'engineering').map(row => row.id), ['engineering-1']);
  assert.deepEqual(selectActiveTeamTodos(rows, 'project').map(row => row.id), ['project-1']);
  assert.equal(privateTodo.status, '待安排', 'TEAM visibility rules must not mutate PRIVATE Todo');
  assert.equal(isActiveTeamTodo(privateTodo), false);
});

test('every TEAM active surface imports the canonical selector and conversion persists status plus link', () => {
  const sources = [
    '../app/page.tsx',
    '../app/schedule/page.tsx',
    '../app/todos/page.tsx',
    '../components/DesignWorkbench.tsx',
  ].map(relativePath => fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));

  for (const source of sources) {
    assert.match(source, /selectActiveTeamTodos/);
  }

  for (const relativePath of ['../app/schedule/page.tsx', '../app/todos/page.tsx']) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    assert.match(source, /updateTodo\([^\n]+\{ status: '已排程', converted_task_id: newTask\.id \}\)/);
    const conversionStart = source.indexOf(
      relativePath.includes('/schedule/') ? 'const handleCreateOrUpdateTask' : 'const handleConvertToTask',
    );
    const conversionEnd = source.indexOf('\n  };', conversionStart);
    const conversionHandler = source.slice(conversionStart, conversionEnd);
    assert.doesNotMatch(conversionHandler, /deleteTodo|localStorage/);
    assert.doesNotMatch(conversionHandler, /setTodos\([^\n]+\.filter\([^\n]+convertedTodoId/);
  }
});
