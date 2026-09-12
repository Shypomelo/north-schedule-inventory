const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const { parseFlexibleLocalDate } = loadTypeScript(path.join(__dirname, 'flexible-local-date.ts'));
const { formatTodoReceivedDate, presentTodoReceivedDate, taiwanDayStart } = loadTypeScript(path.join(__dirname, 'todo-presentation.ts'));

for (const [input, expected] of [
  ['09/08', '2026-09-08'],
  ['09.08', '2026-09-08'],
  ['0908', '2026-09-08'],
  ['9/8', '2026-09-08'],
  ['2026/09/08', '2026-09-08'],
  ['2026-09-08', '2026-09-08'],
]) {
  test(`normalizes ${input}`, () => assert.equal(parseFlexibleLocalDate(input, 2026), expected));
}

test('rejects invalid calendar dates without Date rollover', () => {
  assert.equal(parseFlexibleLocalDate('02/31', 2026), null);
  assert.equal(parseFlexibleLocalDate('13/32', 2026), null);
});

test('validates leap years', () => {
  assert.equal(parseFlexibleLocalDate('2024/02/29', 2026), '2024-02-29');
  assert.equal(parseFlexibleLocalDate('2026/02/29', 2026), null);
});

test('rejects ambiguous undelimited YYYYMMDD', () => {
  assert.equal(parseFlexibleLocalDate('20260908', 2026), null);
});

test('rejects year-zero-like historical corruption instead of presenting it as canonical', () => {
  assert.equal(parseFlexibleLocalDate('0008-09-10', 2026), null);
  assert.equal(parseFlexibleLocalDate('0999/09/10', 2026), null);
  assert.equal(parseFlexibleLocalDate('0908', 2026), '2026-09-08');
  assert.equal(formatTodoReceivedDate('0008-09-10T00:00:00+08:00'), '收到日期異常（原始值：0008-09-10）');
  assert.deepEqual(presentTodoReceivedDate('0008-09-10T00:00:00+08:00'), { label: '日期異常（原始值：0008-09-10）', invalid: true });
  assert.throws(() => taiwanDayStart('0008-09-10'), /Invalid received date/);
});

test('presents stored instants using the Taipei business date after reload', () => {
  const stored = '2026-09-07T16:00:00.000Z';
  assert.equal(formatTodoReceivedDate(stored), '09/08 收到');
  assert.deepEqual(presentTodoReceivedDate(stored), { label: '2026-09-08', invalid: false });
});
