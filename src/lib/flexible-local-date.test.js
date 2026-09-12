const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const { parseFlexibleLocalDate } = loadTypeScript(path.join(__dirname, 'flexible-local-date.ts'));

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
