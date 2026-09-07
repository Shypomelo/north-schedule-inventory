const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildMonthScheduleWeeks,
  collapseExpandedMonthWeeks,
  toggleExpandedMonthWeek,
} = require('./schedule-month-expand.ts');

const schedulePage = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');
const september2026Days = Array.from({ length: 35 }, (_, index) => new Date(2026, 7, 31 + index));
const september2026Weeks = buildMonthScheduleWeeks(september2026Days);
const localDateKey = date => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

test('month view starts with every week compact', () => {
  const expandedWeeks = collapseExpandedMonthWeeks();
  assert.equal(expandedWeeks.size, 0);
  assert.match(schedulePage, /useState<Set<string>>\(collapseExpandedMonthWeeks\)/);
  assert.match(schedulePage, /\{isExpanded \? \(\s*<section/);
});

test('week A and week B can remain expanded together', () => {
  let expandedWeeks = collapseExpandedMonthWeeks();
  expandedWeeks = toggleExpandedMonthWeek(expandedWeeks, '2026-08-31');
  expandedWeeks = toggleExpandedMonthWeek(expandedWeeks, '2026-09-07');
  assert.deepEqual([...expandedWeeks], ['2026-08-31', '2026-09-07']);
});

test('collapsing A leaves B expanded', () => {
  let expandedWeeks = new Set(['2026-08-31', '2026-09-07']);
  expandedWeeks = toggleExpandedMonthWeek(expandedWeeks, '2026-08-31');
  assert.deepEqual([...expandedWeeks], ['2026-09-07']);
});

test('toggling C preserves B and expands C', () => {
  const currentWeeks = new Set(['2026-09-07']);
  const expandedWeeks = toggleExpandedMonthWeek(currentWeeks, '2026-09-14');
  assert.deepEqual([...expandedWeeks], ['2026-09-07', '2026-09-14']);
  assert.deepEqual([...currentWeeks], ['2026-09-07']);
});

test('month and view changes clear every expanded week', () => {
  assert.match(schedulePage, /setExpandedMonthWeeks\(collapseExpandedMonthWeeks\(\)\)/);
  assert.match(schedulePage, /\[viewMode, visibleMonthKey\]/);
  assert.equal(collapseExpandedMonthWeeks().size, 0);
});

test('week controls render only arrows without date-range text', () => {
  assert.match(schedulePage, /data-week-expand-control=\{week\.key\}/);
  assert.match(schedulePage, /\{isExpanded \? '↑' : '↓'\}/);
  assert.match(schedulePage, /\{isExpanded \? '收合本週排程' : '展開本週排程'\}/);
  assert.doesNotMatch(schedulePage, /week\.label|MM\/dd.*週排程/);
});

test('each week reads its independent state from the expanded set', () => {
  assert.match(schedulePage, /const isExpanded = expandedMonthWeeks\.has\(week\.key\)/);
  assert.match(schedulePage, /setExpandedMonthWeeks\(current => \(\s*toggleExpandedMonthWeek\(current, week\.key\)/);
  assert.equal((schedulePage.match(/data-week-expand-control=/g) || []).length, 1);
});

test('September cross-month first and last weeks remain authoritative', () => {
  const firstWeek = september2026Weeks[0];
  const lastWeek = september2026Weeks.at(-1);
  assert.equal(firstWeek.key, '2026-08-31');
  assert.equal(localDateKey(firstWeek.scheduleDays[1]), '2026-09-01');
  assert.equal(lastWeek.key, '2026-09-28');
  assert.equal(localDateKey(lastWeek.endDate), '2026-10-03');
  assert.equal(localDateKey(lastWeek.calendarDays[6]), '2026-10-04');
});

test('expanded weeks keep the authoritative day and schedule filter', () => {
  assert.match(schedulePage, /renderWeeklySchedule\(week\.scheduleDays, false\)/);
  assert.match(schedulePage, /const dateStr = format\(day, 'yyyy-MM-dd'\);\s*const dayTasks = sortTasks\(tasks\.filter\(task => task\.task_date === dateStr\)\)/);
  assert.doesNotMatch(schedulePage, /new Date\(`\$\{expandedMonthWeek/);
});

test('compact and expanded representations stay mutually exclusive', () => {
  assert.match(
    schedulePage,
    /\{isExpanded \? \(\s*<section\s*data-expanded-week=\{week\.key\}[\s\S]*?\) : \(\s*week\.calendarDays\.map/,
  );
  assert.match(schedulePage, /data-compact-week=\{dayIndex === 0 \? week\.key : undefined\}/);
});

test('schedule card click remains separate from week expansion', () => {
  const cardRenderStart = schedulePage.indexOf('dayTasks.slice(0, DAILY_TASK_DISPLAY_LIMIT).map');
  const remainderStart = schedulePage.indexOf('dayTasks.length > DAILY_TASK_DISPLAY_LIMIT', cardRenderStart);
  const cardRender = schedulePage.slice(cardRenderStart, remainderStart);
  assert.match(cardRender, /setEditingTask\(task\)/);
  assert.match(cardRender, /setIsFormOpen\(true\)/);
  assert.doesNotMatch(cardRender, /toggleExpandedMonthWeek/);
});

test('compact cards keep the nested scrollbar contract', () => {
  assert.match(schedulePage, /className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1"/);
  assert.doesNotMatch(schedulePage, /className="flex-1 min-h-0 overflow-hidden flex flex-col gap-1"/);
});

test('compact days keep eight cards and the original +N summary', () => {
  assert.match(schedulePage, /const DAILY_TASK_DISPLAY_LIMIT = 8/);
  assert.match(schedulePage, /dayTasks\.slice\(0, DAILY_TASK_DISPLAY_LIMIT\)\.map/);
  assert.match(schedulePage, /dayTasks\.length > DAILY_TASK_DISPLAY_LIMIT/);
  assert.match(schedulePage, /\+\{dayTasks\.length - DAILY_TASK_DISPLAY_LIMIT\} 筆/);
});

test('month grid and compact day cell classes remain unchanged', () => {
  assert.match(schedulePage, /className="flex-1 min-h-0 grid grid-cols-7 overflow-y-auto"/);
  assert.match(
    schedulePage,
    /className=\{`min-h-0 min-w-0 border-r border-b border-\[var\(--border\)\] last:border-r-0 flex flex-col p-1/,
  );
  assert.doesNotMatch(schedulePage, /\bh-80\b|\bbasis-0\b/);
});
