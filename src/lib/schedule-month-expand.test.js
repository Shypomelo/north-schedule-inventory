const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  collapseExpandedMonthWeek,
  toggleExpandedMonthWeek,
} = require('./schedule-month-expand.ts');

const schedulePage = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');
const scheduleForm = fs.readFileSync(path.join(__dirname, '..', 'components', 'ScheduleTaskForm.tsx'), 'utf8');

test('collapsed month view renders the original calendar without an expanded panel', () => {
  assert.equal(collapseExpandedMonthWeek(), null);
  assert.match(schedulePage, /useState<string \| null>\(collapseExpandedMonthWeek\)/);
  assert.match(schedulePage, /<div data-month-calendar className="flex-1 min-h-0 flex flex-col border/);
  assert.match(schedulePage, /\{expandedMonthWeekStart && \(\s*<section data-expanded-week-panel/);
});

test('month calendar restores the pre-Phase-C single-grid layout contract', () => {
  assert.match(schedulePage, /className="flex-1 min-h-0 grid grid-cols-7 overflow-y-auto"/);
  assert.match(schedulePage, /gridTemplateRows: `repeat\(\$\{monthWeekCount\}, minmax\(160px, 1fr\)\)`/);
  assert.match(schedulePage, /\{monthDays\.map\(\(day, index\) => \{/);
  assert.doesNotMatch(schedulePage, /monthWeeks\.map/);
  assert.doesNotMatch(schedulePage, /\bh-80\b|\bh-7\b|basis-0/);
});

test('month days render at most eight cards and show the original +N summary', () => {
  assert.match(schedulePage, /const DAILY_TASK_DISPLAY_LIMIT = 8/);
  assert.match(schedulePage, /dayTasks\.slice\(0, DAILY_TASK_DISPLAY_LIMIT\)\.map/);
  assert.match(schedulePage, /dayTasks\.length > DAILY_TASK_DISPLAY_LIMIT/);
  assert.match(schedulePage, /\+\{dayTasks\.length - DAILY_TASK_DISPLAY_LIMIT\} 筆/);
});

test('month day cards restore the pre-Phase-C nested scrollbar contract', () => {
  assert.match(schedulePage, /className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1"/);
  assert.doesNotMatch(schedulePage, /className="flex-1 min-h-0 overflow-hidden flex flex-col gap-1"/);
});

test('clicking a week preserves the month calendar and adds one external panel', () => {
  assert.equal(toggleExpandedMonthWeek(null, '2026-09-07'), '2026-09-07');
  assert.match(schedulePage, /<div data-month-calendar[\s\S]*?\{expandedMonthWeekStart && \(\s*<section data-expanded-week-panel/);
  assert.match(schedulePage, /renderWeeklySchedule\(expandedMonthWeekDays, false\)/);
});

test('external panel cannot shrink the original month calendar', () => {
  assert.match(schedulePage, /className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3"/);
  assert.match(schedulePage, /className="min-h-full flex flex-col"/);
  assert.match(schedulePage, /data-month-calendar[\s\S]*?overflow-y-auto flex flex-col gap-1[\s\S]*?data-expanded-week-panel/);
});

test('clicking the same week removes the panel without changing the calendar contract', () => {
  assert.equal(toggleExpandedMonthWeek('2026-09-07', '2026-09-07'), null);
  assert.match(schedulePage, /data-month-calendar/);
  assert.match(schedulePage, /gridTemplateRows: `repeat/);
});

test('switching weeks keeps only the newly selected panel', () => {
  let expandedWeek = toggleExpandedMonthWeek(null, '2026-09-07');
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-14');
  assert.equal(expandedWeek, '2026-09-14');
  assert.equal((schedulePage.match(/data-expanded-week-panel/g) || []).length, 1);
});

test('month navigation and view changes collapse the panel', () => {
  assert.match(schedulePage, /const visibleMonthKey = format\(currentDate, 'yyyy-MM'\)/);
  assert.match(schedulePage, /\[viewMode, visibleMonthKey\]/);
  assert.match(schedulePage, /setViewMode\('month'\);[\s\S]*?setExpandedMonthWeekStart\(null\)/);
  assert.equal(collapseExpandedMonthWeek(), null);
});

test('expanded panel reuses Monday-through-Saturday weekly rendering', () => {
  assert.match(schedulePage, /Array\.from\(\{ length: 6 \}/);
  assert.match(schedulePage, /renderWeeklySchedule\(expandedMonthWeekDays, false\)/);
  assert.match(schedulePage, /renderWeeklySchedule\(weekDays, true\)/);
});

test('schedule creator UI remains connected and read-only', () => {
  assert.match(schedulePage, /<ScheduleTaskForm/);
  assert.match(scheduleForm, /<dl aria-label="建立資訊"/);
  assert.match(scheduleForm, /<dt[^>]*>建立者：<\/dt>/);
  assert.match(scheduleForm, /<dt[^>]*>來源：<\/dt>/);
});
