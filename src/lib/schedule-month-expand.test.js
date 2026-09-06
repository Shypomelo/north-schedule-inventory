const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  collapseExpandedMonthWeek,
  toggleExpandedMonthWeek,
} = require('./schedule-month-expand.ts');

const schedulePage = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');

test('month view starts with no expanded week panel', () => {
  assert.equal(collapseExpandedMonthWeek(), null);
  assert.match(schedulePage, /useState<string \| null>\(collapseExpandedMonthWeek\)/);
  assert.match(schedulePage, /\{isExpanded && \(\s*<section/);
});

test('single month grid keeps its seven-column day layout', () => {
  assert.match(schedulePage, /const monthWeekCount = monthDays\.length \/ 7/);
  assert.match(schedulePage, /className="flex-1 min-h-0 grid grid-cols-7 overflow-y-auto"/);
  assert.match(schedulePage, /\{monthDays\.map\(\(day, index\) => \{/);
  assert.doesNotMatch(schedulePage, /monthWeeks\.map|WeekWrapper/);
});

test('each completed seven-day row inserts its own compact week control', () => {
  assert.match(schedulePage, /const isWeekEnd = \(index \+ 1\) % 7 === 0/);
  assert.match(schedulePage, /const week = monthWeekOptions\[Math\.floor\(index \/ 7\)\]/);
  assert.match(schedulePage, /\{isWeekEnd && \(\s*<>\s*<button\s*data-week-expand-control=\{week\.key\}/);
  assert.match(schedulePage, /\{week\.label\}/);
  assert.doesNotMatch(schedulePage, /data-week-expand-controls/);
});

test('clicking week A expands A with the stable start-date key', () => {
  assert.equal(toggleExpandedMonthWeek(null, '2026-09-07'), '2026-09-07');
  assert.match(schedulePage, /key: format\(start, 'yyyy-MM-dd'\)/);
  assert.match(schedulePage, /toggleExpandedMonthWeek\(current, week\.key\)/);
});

test('clicking week A again collapses the panel', () => {
  assert.equal(toggleExpandedMonthWeek('2026-09-07', '2026-09-07'), null);
});

test('switching from A to B keeps only B expanded', () => {
  let expandedWeek = toggleExpandedMonthWeek(null, '2026-09-07');
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-14');
  assert.equal(expandedWeek, '2026-09-14');
  assert.match(schedulePage, /const isExpanded = expandedMonthWeekStart === week\.key/);
  assert.equal((schedulePage.match(/data-expanded-week-panel/g) || []).length, 1);
});

test('expanded panel is placed immediately after its week control inside the month grid', () => {
  assert.match(
    schedulePage,
    /data-week-expand-control=\{week\.key\}[\s\S]*?<\/button>\s*\{isExpanded && \(\s*<section\s*data-expanded-week-panel=\{week\.key\}/,
  );
  assert.match(schedulePage, /data-expanded-week-panel=\{week\.key\}[\s\S]*?renderWeeklySchedule\(expandedMonthWeekDays, false\)/);
  assert.match(schedulePage, /className="col-span-full border-b/);
});

test('schedule card click remains separate from week expansion', () => {
  const cardRenderStart = schedulePage.indexOf('dayTasks.slice(0, DAILY_TASK_DISPLAY_LIMIT).map');
  const remainderStart = schedulePage.indexOf('dayTasks.length > DAILY_TASK_DISPLAY_LIMIT', cardRenderStart);
  const cardRender = schedulePage.slice(cardRenderStart, remainderStart);
  assert.match(cardRender, /setEditingTask\(task\)/);
  assert.match(cardRender, /setIsFormOpen\(true\)/);
  assert.doesNotMatch(cardRender, /toggleExpandedMonthWeek/);
});

test('month day cards keep the nested scrollbar contract', () => {
  assert.match(schedulePage, /className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1"/);
  assert.doesNotMatch(schedulePage, /className="flex-1 min-h-0 overflow-hidden flex flex-col gap-1"/);
});

test('month days still render eight cards and the original +N summary', () => {
  assert.match(schedulePage, /const DAILY_TASK_DISPLAY_LIMIT = 8/);
  assert.match(schedulePage, /dayTasks\.slice\(0, DAILY_TASK_DISPLAY_LIMIT\)\.map/);
  assert.match(schedulePage, /dayTasks\.length > DAILY_TASK_DISPLAY_LIMIT/);
  assert.match(schedulePage, /\+\{dayTasks\.length - DAILY_TASK_DISPLAY_LIMIT\} 筆/);
});

test('original month day cell class remains unchanged', () => {
  assert.match(
    schedulePage,
    /className=\{`min-h-0 min-w-0 border-r border-b border-\[var\(--border\)\] last:border-r-0 flex flex-col p-1/,
  );
  assert.doesNotMatch(schedulePage, /\bh-80\b|\bbasis-0\b/);
});

test('month navigation and view changes collapse the panel', () => {
  assert.match(schedulePage, /const visibleMonthKey = format\(currentDate, 'yyyy-MM'\)/);
  assert.match(schedulePage, /\[viewMode, visibleMonthKey\]/);
  assert.match(schedulePage, /setViewMode\('month'\);[\s\S]*?setExpandedMonthWeekStart\(null\)/);
});
