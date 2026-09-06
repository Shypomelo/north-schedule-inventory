const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { toggleExpandedMonthWeek } = require('./schedule-month-expand.ts');

const schedulePage = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'),
  'utf8',
);

test('month view uses a stable week-start string with the shared toggle', () => {
  assert.match(schedulePage, /expandedMonthWeekStart/);
  assert.match(schedulePage, /const monthWeekStart = format\(monthWeek\[0\], 'yyyy-MM-dd'\)/);
  assert.match(schedulePage, /toggleExpandedMonthWeek\(current, monthWeekStart\)/);
});

test('expanded week is initially null', () => {
  assert.match(schedulePage, /useState<string \| null>\(null\)/);
});

test('clicking week A expands A', () => {
  assert.equal(toggleExpandedMonthWeek(null, '2026-09-07'), '2026-09-07');
});

test('clicking expanded week A collapses it', () => {
  assert.equal(toggleExpandedMonthWeek('2026-09-07', '2026-09-07'), null);
});

test('clicking week B while A is expanded replaces A with B', () => {
  assert.equal(toggleExpandedMonthWeek('2026-09-07', '2026-09-14'), '2026-09-14');
});

test('the state can identify at most one expanded week', () => {
  let expandedWeek = null;
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-07');
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-14');
  assert.equal(expandedWeek, '2026-09-14');
  assert.equal(typeof expandedWeek, 'string');
});

test('week A can be expanded again after it is collapsed', () => {
  let expandedWeek = toggleExpandedMonthWeek(null, '2026-09-07');
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-07');
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-07');
  assert.equal(expandedWeek, '2026-09-07');
});

test('expanded month week renders Monday through Saturday with the shared weekly renderer', () => {
  assert.match(schedulePage, /renderWeeklySchedule\(monthWeek\.slice\(0, 6\), false\)/);
  assert.match(schedulePage, /renderWeeklySchedule\(weekDays, true\)/);
  assert.match(schedulePage, /const weekDays = Array\.from\(\{ length: 6 \}\)/);
});

test('expanded week retains the shared daily display limit and full day drawer', () => {
  assert.match(schedulePage, /const DAILY_TASK_DISPLAY_LIMIT = 8/);
  assert.match(schedulePage, /const displayTasks = dayTasks\.slice\(0, DAILY_TASK_DISPLAY_LIMIT\)/);
  assert.match(schedulePage, /setSelectedDayTasks\(\{ date: day, tasks: dayTasks \}\)/);
});

test('month navigation and view changes collapse expanded week state', () => {
  const resetCount = schedulePage.match(/setExpandedMonthWeekStart\(null\)/g)?.length ?? 0;
  assert.ok(resetCount >= 4, `expected at least four reset paths, received ${resetCount}`);
});
