const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  collapseExpandedMonthWeek,
  getMonthDaySummaryCounts,
  toggleExpandedMonthWeek,
} = require('./schedule-month-expand.ts');

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
  assert.equal(collapseExpandedMonthWeek(), null);
  assert.match(schedulePage, /useState<string \| null>\(collapseExpandedMonthWeek\)/);
});

test('today being inside a month week does not auto-expand it', () => {
  const todayWeekStart = '2026-09-07';
  assert.ok(todayWeekStart);
  assert.equal(collapseExpandedMonthWeek(), null);
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

test('a day with 3 tasks renders 3 cards without a remainder', () => {
  assert.deepEqual(getMonthDaySummaryCounts(3), { visibleCount: 3, hiddenCount: 0 });
});

test('a day with 8 tasks renders 8 cards without a remainder', () => {
  assert.deepEqual(getMonthDaySummaryCounts(8), { visibleCount: 8, hiddenCount: 0 });
});

test('a day with 10 tasks renders 8 cards and +2', () => {
  assert.deepEqual(getMonthDaySummaryCounts(10), { visibleCount: 8, hiddenCount: 2 });
});

test('large task counts cannot grow the fixed month row', () => {
  assert.deepEqual(getMonthDaySummaryCounts(20), { visibleCount: 8, hiddenCount: 12 });
  assert.match(schedulePage, /className="grid h-80 grid-cols-7 overflow-hidden"/);
  assert.match(schedulePage, /className="flex-1 min-h-0 overflow-hidden flex flex-col gap-1"/);
  assert.doesNotMatch(schedulePage, /className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1"/);
});

test('weekly detail remains a separate conditional block below the compact month row', () => {
  assert.match(
    schedulePage,
    /className="grid h-80 grid-cols-7 overflow-hidden"[\s\S]*?\{isExpanded && \([\s\S]*?renderWeeklySchedule\(monthWeek\.slice\(0, 6\), false\)/,
  );
});

test('month navigation and view changes collapse expanded week state', () => {
  assert.match(schedulePage, /const visibleMonthKey = format\(currentDate, 'yyyy-MM'\)/);
  assert.match(schedulePage, /\[viewMode, visibleMonthKey\]/);
  assert.match(schedulePage, /setViewMode\('month'\);[\s\S]*?setExpandedMonthWeekStart\(null\)/);
  assert.equal(collapseExpandedMonthWeek(), null);
});
