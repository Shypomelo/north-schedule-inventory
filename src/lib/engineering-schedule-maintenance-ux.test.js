const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const load = file => require('./test-load-ts.cjs')(path.join(__dirname, file));
const { getScheduleTaskPresentation } = load('schedule-presentation.ts');
const {
  formatScheduleTaskTime,
  selectMaintenanceScheduleTasks,
} = load('schedule-selectors.ts');

const task = (overrides = {}) => ({
  id: 'task',
  work_group_id: 'engineering',
  task_type: '施工',
  title: '',
  project_id: null,
  project_name: null,
  address: null,
  task_date: '2026-09-15',
  start_time: '09:00',
  end_time: '11:00',
  is_all_day: false,
  is_tentative: false,
  status: '',
  main_assignee_id: null,
  description: null,
  ...overrides,
});

const projectName = (row, projects = []) => getScheduleTaskPresentation(row, projects, [], []).projectName;

test('no-site presentation follows canonical task type semantics without guessing from title', () => {
  assert.equal(projectName(task({ task_type: '內勤', title: '整理文件' })), '內勤');
  assert.equal(projectName(task({ task_type: '內部', title: '整理文件' })), '內勤');
  assert.equal(projectName(task({ task_type: '休假', title: '特休' })), '休假');
  assert.equal(projectName(task({ task_type: '其他', title: '教育訓練' })), '其他');
  assert.equal(projectName(task({ task_type: '開會' })), '開會');
  assert.equal(projectName(task({ task_type: '開會', project_name: '總公司會議室' })), '總公司會議室');
  assert.equal(projectName(task({ task_type: '開會', address: '台北辦公室' })), '台北辦公室');
  assert.equal(projectName(task({ task_type: '施工', title: '內勤' })), '');
});

test('schedule presentation omits absent values and maps only valid locations', () => {
  const users = [{ id: 'user-1', name: '柚子' }];
  const leave = getScheduleTaskPresentation(task({
    task_type: '休假',
    project_name: '中秋節',
    address: '中秋節',
    start_time: null,
    end_time: null,
    main_assignee_id: 'user-1',
  }), [], users, []);
  assert.equal(leave.projectName, '休假');
  assert.equal(leave.cardDetail, '');
  assert.equal(leave.assigneeDisplay, '主要：柚子');
  assert.equal(leave.mapUrl, '');
  assert.equal(formatScheduleTaskTime(task({ start_time: null, end_time: null })), '');

  const maintenance = getScheduleTaskPresentation(task({ task_type: '維修', start_time: null, end_time: null }), [], [], []);
  assert.equal(maintenance.projectName, '');
  assert.equal(maintenance.cardDetail, '[維修]');
  assert.equal(maintenance.assigneeDisplay, '');
  assert.equal(maintenance.collaboratorDisplay, '');

  const meeting = getScheduleTaskPresentation(task({ task_type: '開會', project_name: '會議室 A' }), [], [], []);
  assert.match(meeting.mapUrl, /google\.com\/maps/);

  const withBothPeople = getScheduleTaskPresentation(
    task({ main_assignee_id: 'user-1' }),
    [],
    [...users, { id: 'user-2', name: '育丞' }],
    [{ task_id: 'task', user_id: 'user-2' }],
  );
  assert.equal(withBothPeople.assigneeDisplay, '主要：柚子');
  assert.equal(withBothPeople.collaboratorDisplay, '協同：育丞');

  const collaboratorOnly = getScheduleTaskPresentation(
    task(),
    [],
    [{ id: 'user-2', name: '育丞' }],
    [{ task_id: 'task', user_id: 'user-2' }],
  );
  assert.equal(collaboratorOnly.assigneeDisplay, '');
  assert.equal(collaboratorOnly.collaboratorDisplay, '協同：育丞');
});

test('formal project binding wins over no-site fallback', () => {
  const projects = [{ id: 'project-1', name: '正式案場', short_name: '案場簡稱', address: null }];
  assert.equal(projectName(task({ task_type: '開會', project_id: 'project-1', project_name: '舊名稱' }), projects), '案場簡稱');
});

test('maintenance perspectives filter the canonical schedule list and completion status', () => {
  const rows = [
    task({ id: 'week-open', task_type: '維修', task_date: '2026-09-15', status: '' }),
    task({ id: 'week-done', task_type: '維修', task_date: '2026-09-19', status: '完成', start_time: '13:00' }),
    task({ id: 'old-done', task_type: '維修', task_date: '2026-09-01', status: '已完成' }),
    task({ id: 'future-open', task_type: '維修', task_date: '2026-09-28', status: '進行中' }),
    task({ id: 'cancelled', task_type: '維修', task_date: '2026-09-16', status: '取消' }),
    task({ id: 'title-only', task_type: '施工', title: '維修逆變器', task_date: '2026-09-16' }),
  ];
  const range = { start: '2026-09-14', end: '2026-09-19' };

  assert.deepEqual(selectMaintenanceScheduleTasks(rows, 'week', range).map(row => row.id), ['week-open', 'week-done']);
  assert.deepEqual(selectMaintenanceScheduleTasks(rows, 'incomplete', range).map(row => row.id), ['week-open', 'future-open']);
  assert.deepEqual(selectMaintenanceScheduleTasks(rows, 'completed', range).map(row => row.id), ['old-done', 'week-done']);
});

test('schedule input and presentation UI keep one canonical data flow', () => {
  const form = fs.readFileSync(path.join(__dirname, '..', 'components', 'ScheduleTaskForm.tsx'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '..', 'components', 'ScheduleTaskDetail.tsx'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
  const schedule = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');

  assert.match(form, /setIsDropdownOpen\(Boolean\(val\.trim\(\)\)\)/);
  assert.match(form, /if \(!projectNameInput\.trim\(\)\) return \[\]/);
  assert.match(form, /onFocus=\{\(\) => setIsDropdownOpen\(Boolean\(projectNameInput\.trim\(\)\)\)\}/);
  assert.match(form, /usesScheduleProjectBinding\(formData\.task_type\)/);
  assert.match(form, /allowsScheduleTaskLocation\(formData\.task_type\)/);
  assert.doesNotMatch(form, /semanticTaskType !== 'leave'/);
  for (const source of [dashboard, schedule, detail]) {
    assert.doesNotMatch(source, /主要：未指定負責人/);
    assert.doesNotMatch(source, /task\.title \|\| '無標題'/);
  }

  assert.match(dashboard, /selectMaintenanceScheduleTasks\(/);
  assert.match(dashboard, /<ScheduleTaskDetail/);
  assert.match(dashboard, /<ScheduleTaskFormDialog/);
  assert.doesNotMatch(dashboard, /title\.includes\(['"]維修/);

  assert.match(schedule, /data-schedule-toolbar/);
  assert.match(schedule, /<Maximize2[^>]*\/>\s*全螢幕\s*<\/button>/);
  assert.match(schedule, /<Trash2[^>]*\/>\s*刪除紀錄[\s\S]*<Plus[^>]*\/>\s*新增\s*<\/button>/);
  assert.match(schedule, /renderWeeklySchedule\(weekDays, false, true\)/);
  assert.match(schedule, /event\.key === 'Escape'\) setIsPresentationMode\(false\)/);
  assert.match(schedule, /text-\[clamp\(1rem,1\.35vw,1\.75rem\)\]/);
  assert.match(schedule, /gap-\[clamp\(0\.65rem,0\.8vw,1\.25rem\)\]/);
  assert.doesNotMatch(schedule, /isPresentationMode[\s\S]{0,200}dbAdapter\.getScheduleTasks/);

  assert.doesNotMatch(schedule, />\s*\u91cd\u65b0\u540c\u6b65 Google \u65e5\u66c6\s*</);
  assert.match(schedule, /fetch\('\/api\/google-calendar\/reconcile'/);
  assert.match(schedule, /reconcileGoogleCalendar\(\)\.then/);
  assert.match(schedule, /currentUser\?\.role === 'ADMIN'/);
  assert.match(schedule, /<ScheduleDeletedAuditDialog/);
});
