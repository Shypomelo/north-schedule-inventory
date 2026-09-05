const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const schedulePage = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'),
  'utf8',
);

test('month view keeps exactly one expanded week and toggles the same week closed', () => {
  assert.match(schedulePage, /expandedMonthWeekStart/);
  assert.match(
    schedulePage,
    /setExpandedMonthWeekStart\(current => current === monthWeekStart \? null : monthWeekStart\)/,
  );
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
