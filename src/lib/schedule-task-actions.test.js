const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('Dashboard and Schedule reuse the same schedule mutation actions and edit dialog', () => {
  const dashboard = read('app/page.tsx');
  const schedule = read('app/schedule/page.tsx');
  const actions = read('lib/schedule-task-actions.ts');

  for (const source of [dashboard, schedule]) {
    assert.match(source, /completeScheduleTaskWithActivity/);
    assert.match(source, /deleteScheduleTaskWithActivity/);
    assert.match(source, /updateScheduleTaskWithActivity/);
    assert.match(source, /ScheduleTaskFormDialog/);
  }
  assert.match(actions, /action_type: actionType \|\| \(timingChanged \? 'RESCHEDULE_TASK' : assigneesChanged \? 'ASSIGNEE_CHANGE_TASK' : 'UPDATE_TASK'\)/);
  assert.match(actions, /action_type: 'COMPLETE_TASK'/);
  assert.match(actions, /action_type: 'DELETE_TASK'/);
  assert.match(actions, /dbAdapter\.updateTodo\(task\.source_todo_id, \{ status: '已完成' \}\)/);
  assert.match(actions, /confirmScheduleTaskDeletion/);
});

test('schedule deletion preserves rows as cancelled after Google delete sync', () => {
  const index = read('lib/db/index.ts');
  const supabaseAdapter = read('lib/db/poc-supabase.ts');
  const mockAdapter = read('lib/db/mock.ts');
  const selector = read('lib/schedule-selectors.ts');
  const deleteAdapter = supabaseAdapter.slice(
    supabaseAdapter.indexOf('deleteScheduleTask: async'),
    supabaseAdapter.indexOf('// --- Contractors ---'),
  );

  assert.match(index, /syncToGoogle\('DELETE', taskToDelete, skipGoogleSync\)[\s\S]*?await fn\(id\)/);
  assert.match(deleteAdapter, /update\(\{ status: '取消'/);
  assert.doesNotMatch(deleteAdapter, /\.delete\(\)/);
  assert.match(supabaseAdapter, /getScheduleTasks:[\s\S]*?neq\('status', '取消'\)/);
  assert.match(mockAdapter, /deleteScheduleTask:[\s\S]*?status: '取消'/);
  assert.match(selector, /filter\(task => task\.status !== '取消'\)/);
  const reconcile = read('lib/server/google-calendar-reconcile.ts');
  assert.match(reconcile, /from\('schedule_tasks'\)\.select\(SCHEDULE_TASK_SYNC_COLUMNS\)\.neq\('status', '取消'\)/);
});

test('weather route uses the current CWA LocationName parameter contract', () => {
  const weatherRoute = read('app/api/weather/route.ts');
  assert.match(weatherRoute, /searchParams\.set\('LocationName', district\)/);
  assert.doesNotMatch(weatherRoute, /searchParams\.set\('locationName', district\)/);
});
