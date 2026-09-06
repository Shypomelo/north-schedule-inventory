const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildMonthScheduleWeeks,
  collapseExpandedMonthWeek,
  toggleExpandedMonthWeek,
} = require('./schedule-month-expand.ts');

const schedulePage = fs.readFileSync(path.join(__dirname, '..', 'app', 'schedule', 'page.tsx'), 'utf8');
const september2026Days = Array.from({ length: 35 }, (_, index) => new Date(2026, 7, 31 + index));
const september2026Weeks = buildMonthScheduleWeeks(september2026Days);
const localDateKey = date => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

test('month view starts with no expanded week panel', () => {
  assert.equal(collapseExpandedMonthWeek(), null);
  assert.match(schedulePage, /useState<string \| null>\(collapseExpandedMonthWeek\)/);
  assert.match(schedulePage, /\{isExpanded && \(\s*<section/);
});

test('single month grid keeps its seven-column day layout', () => {
  assert.equal(september2026Weeks[0].calendarDays.length, 7);
  assert.match(schedulePage, /className="flex-1 min-h-0 grid grid-cols-7 overflow-y-auto"/);
  assert.match(schedulePage, /\{monthDays\.map\(\(day, index\) => \{/);
  assert.doesNotMatch(schedulePage, /monthWeeks\.map|WeekWrapper/);
});

test('each completed seven-day row inserts its own compact week control', () => {
  assert.match(schedulePage, /const isWeekEnd = \(index \+ 1\) % 7 === 0/);
  assert.match(schedulePage, /const week = monthWeeks\[Math\.floor\(index \/ 7\)\]/);
  assert.match(schedulePage, /\{isWeekEnd && \(\s*<>\s*<button\s*data-week-expand-control=\{week\.key\}/);
  assert.match(schedulePage, /\{week\.label\}/);
  assert.doesNotMatch(schedulePage, /data-week-expand-controls/);
});

test('September 2026 first week uses its cross-month Monday as the authoritative key', () => {
  const firstWeek = september2026Weeks[0];
  assert.equal(firstWeek.key, '2026-08-31');
  assert.equal(localDateKey(firstWeek.startDate), '2026-08-31');
  assert.equal(localDateKey(firstWeek.scheduleDays[0]), '2026-08-31');
  assert.equal(localDateKey(firstWeek.scheduleDays[1]), '2026-09-01');
});

test('clicking the first week expands and collapses the same cross-month key', () => {
  assert.equal(toggleExpandedMonthWeek(null, september2026Weeks[0].key), '2026-08-31');
  assert.equal(toggleExpandedMonthWeek('2026-08-31', september2026Weeks[0].key), null);
  assert.match(schedulePage, /toggleExpandedMonthWeek\(current, week\.key\)/);
});

test('expanded panel receives the selected authoritative week days', () => {
  assert.match(schedulePage, /const expandedMonthWeek = monthWeeks\.find\(week => week\.key === expandedMonthWeekStart\) \?\? null/);
  assert.match(schedulePage, /renderWeeklySchedule\(week\.scheduleDays, false\)/);
  assert.doesNotMatch(schedulePage, /new Date\(`\$\{expandedMonthWeekStart\}T00:00:00`\)/);
});

test('switching from A to B keeps only B expanded', () => {
  let expandedWeek = toggleExpandedMonthWeek(null, '2026-08-31');
  expandedWeek = toggleExpandedMonthWeek(expandedWeek, '2026-09-14');
  assert.equal(expandedWeek, '2026-09-14');
  assert.match(schedulePage, /const isExpanded = expandedMonthWeekStart === week\.key/);
  assert.equal((schedulePage.match(/data-expanded-week-panel/g) || []).length, 1);
});

test('panel columns and schedule filtering use the exact same day key', () => {
  const firstWeek = september2026Weeks[0];
  const tasks = [
    { id: 'sep-01', task_date: '2026-09-01' },
    { id: 'sep-02', task_date: '2026-09-02' },
    { id: 'sep-03', task_date: '2026-09-03' },
  ];
  const septemberSecond = firstWeek.scheduleDays[2];
  const dateStr = localDateKey(septemberSecond);

  assert.equal(dateStr, '2026-09-02');
  assert.deepEqual(tasks.filter(task => task.task_date === dateStr).map(task => task.id), ['sep-02']);
  assert.match(schedulePage, /const dateStr = format\(day, 'yyyy-MM-dd'\);\s*const dayTasks = sortTasks\(tasks\.filter\(task => task\.task_date === dateStr\)\)/);
});

test('September 2026 last week keeps its October crossover dates', () => {
  const lastWeek = september2026Weeks.at(-1);
  assert.equal(lastWeek.key, '2026-09-28');
  assert.equal(localDateKey(lastWeek.startDate), '2026-09-28');
  assert.equal(localDateKey(lastWeek.endDate), '2026-10-03');
  assert.equal(localDateKey(lastWeek.calendarDays[6]), '2026-10-04');
});

test('expanded panel is placed immediately after its week control inside the month grid', () => {
  assert.match(
    schedulePage,
    /data-week-expand-control=\{week\.key\}[\s\S]*?<\/button>\s*\{isExpanded && \(\s*<section\s*data-expanded-week-panel=\{week\.key\}/,
  );
  assert.match(schedulePage, /data-expanded-week-panel=\{week\.key\}[\s\S]*?renderWeeklySchedule\(week\.scheduleDays, false\)/);
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
