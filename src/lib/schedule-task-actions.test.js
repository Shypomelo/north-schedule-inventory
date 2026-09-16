const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const load = (file, mocks = {}) => require('./test-load-ts.cjs')(path.join(__dirname, file), mocks);

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
  assert.match(actions, /if \(diff\.changedFields\.length === 0\) return updatedTask/);
  assert.match(actions, /completed \? 'COMPLETE_TASK' : timingChanged \? 'RESCHEDULE_TASK' : assigneesChanged \? 'ASSIGNEE_CHANGE_TASK' : 'UPDATE_TASK'/);
  assert.match(actions, /serializeScheduleAuditSnapshot\(diff\.before\)/);
  assert.match(actions, /serializeScheduleAuditSnapshot\(diff\.after\)/);
  assert.match(actions, /action_type: 'COMPLETE_TASK'/);
  assert.match(actions, /action_type: 'DELETE_TASK'/);
  assert.match(actions, /dbAdapter\.updateTodo\(task\.source_todo_id, \{ status: '已完成' \}\)/);
  assert.match(actions, /confirmScheduleTaskDeletion/);
  assert.match(actions, /logScheduleTaskCreation/);
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

test('Schedule update writes one structured event and suppresses no-op history', async () => {
  const logged = [];
  const dbAdapter = {
    updateScheduleTask: async (_id, updates) => ({ ...baseTask, ...updates }),
    logActivity: async entry => { logged.push(entry); return entry; },
  };
  const { updateScheduleTaskWithActivity } = load('schedule-task-actions.ts', { '@/lib/db': { dbAdapter } });
  const context = { projects: [], users: [] };

  await updateScheduleTaskWithActivity({
    task: baseTask,
    data: { ...baseTask },
    memberIds: [],
    previousMemberIds: [],
    actor: { id: 'actor', name: '柚子' },
    auditContext: context,
  });
  assert.equal(logged.length, 0);

  await updateScheduleTaskWithActivity({
    task: baseTask,
    data: { ...baseTask, task_date: '2026-09-17' },
    memberIds: [],
    previousMemberIds: [],
    actor: { id: 'actor', name: '柚子' },
    auditContext: context,
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action_type, 'RESCHEDULE_TASK');
  assert.deepEqual(JSON.parse(logged[0].before_value), { task_date: '2026-09-16' });
  assert.deepEqual(JSON.parse(logged[0].after_value), { task_date: '2026-09-17' });
});

test('linked receipt reschedule updates the canonical batch plan before the schedule', async () => {
  const calls = [];
  const receiptTask = {
    ...baseTask,
    task_type: '收料',
    source_material_batch_id: 'batch-1',
  };
  const dbAdapter = {
    updateMaterialReceiptPlan: async (id, value) => { calls.push(['plan', id, value]); },
    updateScheduleTask: async (_id, updates) => { calls.push(['task', updates.task_date, updates.start_time]); return { ...receiptTask, ...updates }; },
    logActivity: async entry => { calls.push(['audit', entry.action_type]); return entry; },
  };
  const { updateScheduleTaskWithActivity } = load('schedule-task-actions.ts', { '@/lib/db': { dbAdapter } });
  await updateScheduleTaskWithActivity({
    task: receiptTask,
    data: { ...receiptTask, task_date: '2026-09-22', start_time: '10:00' },
    memberIds: [],
    actor: { id: 'actor', name: '柚子' },
  });
  assert.deepEqual(calls[0], ['plan', 'batch-1', '2026-09-22T10:00:00+08:00']);
  assert.deepEqual(calls[1], ['task', '2026-09-22', '10:00']);
  assert.deepEqual(calls[2], ['audit', 'RESCHEDULE_TASK']);
});

test('linked receipt completion atomically completes the inbound batch before normal schedule sync', async () => {
  const calls = [];
  const receiptTask = { ...baseTask, task_type: '收料', source_material_batch_id: 'batch-1' };
  const dbAdapter = {
    completeMaterialReceiptSchedule: async id => { calls.push(`receipt:${id}`); },
    updateScheduleTask: async (id, updates) => { calls.push(`task:${id}:${updates.status}`); return { ...receiptTask, ...updates }; },
    logActivity: async entry => { calls.push(`audit:${entry.action_type}`); return entry; },
  };
  const { completeScheduleTaskWithActivity } = load('schedule-task-actions.ts', { '@/lib/db': { dbAdapter } });
  await completeScheduleTaskWithActivity(receiptTask, { id: 'actor', name: '柚子' });
  assert.deepEqual(calls, ['receipt:task-1', 'task:task-1:完成', 'audit:COMPLETE_TASK']);
});

test('Schedule deletion stores the full snapshot after the normal task is removed', async () => {
  const calls = [];
  const dbAdapter = {
    deleteScheduleTask: async id => { calls.push(`delete:${id}`); },
    logActivity: async entry => { calls.push(entry); return entry; },
  };
  const { deleteScheduleTaskWithActivity } = load('schedule-task-actions.ts', { '@/lib/db': { dbAdapter } });
  await deleteScheduleTaskWithActivity(baseTask, { id: 'actor', name: '柚子' });
  assert.equal(calls[0], `delete:${baseTask.id}`);
  assert.equal(calls[1].action_type, 'DELETE_TASK');
  const snapshot = JSON.parse(calls[1].before_value);
  assert.equal(snapshot.title, baseTask.title);
  assert.equal(snapshot.task_date, baseTask.task_date);
  assert.equal(calls[1].after_value, null);
});

const baseTask = {
  id: 'task-1',
  work_group_id: 'engineering',
  task_type: '維修',
  title: 'P401 維修',
  project_id: null,
  project_name: '聯華觀音廠',
  address: null,
  task_date: '2026-09-16',
  start_time: '09:00',
  end_time: '10:00',
  is_all_day: false,
  is_tentative: false,
  status: '未開始',
  main_assignee_id: null,
  description: '需攜帶 P401',
  google_calendar_id: null,
  google_event_id: null,
  google_sync_status: null,
  google_sync_error: null,
  last_synced_at: null,
  created_by: 'actor',
  created_by_user_id: 'actor',
  created_by_name: '柚子',
  creation_source: 'APP',
  source_todo_id: null,
  created_at: '2026-09-15T01:32:00Z',
  updated_at: '2026-09-15T01:32:00Z',
};
