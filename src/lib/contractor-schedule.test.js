const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { findContractorOverlaps, getScheduledInterval } = require('./test-load-ts.cjs')(path.join(__dirname, 'contractor-schedule.ts'));

const row = (id, projectId, vendor, start, end, extra = {}) => ({
  id, project_id: projectId, work_type: 'steel', work_name: null,
  contractor_id: vendor, contractor_name: vendor, planned_start_date: start,
  planned_end_date: end, deleted_at: null, status_override: null, ...extra,
});

test('same contractor across projects overlaps with inclusive dates', () => {
  const overlaps = findContractorOverlaps([
    row('a', 'project-a', 'vendor-1', '2026-10-12', '2026-10-18'),
    row('b', 'project-b', 'vendor-1', '2026-10-18', '2026-10-22'),
  ]);
  assert.equal(overlaps.length, 1);
  assert.deepEqual([overlaps[0].start, overlaps[0].end], ['2026-10-18', '2026-10-18']);
});

test('different contractor IDs never overlap even with same name', () => {
  assert.equal(findContractorOverlaps([
    row('a', 'project-a', 'vendor-1', '2026-10-12', '2026-10-18', { contractor_name: '甲' }),
    row('b', 'project-b', 'vendor-2', '2026-10-12', '2026-10-18', { contractor_name: '甲' }),
  ]).length, 0);
});

test('nonoverlap, missing vendor, same record, and disabled work are excluded', () => {
  const base = row('a', 'project-a', 'vendor-1', '2026-10-12', '2026-10-18');
  assert.equal(findContractorOverlaps([base, row('b', 'project-b', 'vendor-1', '2026-10-19', '2026-10-22')]).length, 0);
  assert.equal(findContractorOverlaps([base, row('b', 'project-b', null, '2026-10-12', '2026-10-18')]).length, 0);
  assert.equal(findContractorOverlaps([base, { ...base }]).length, 0);
  assert.equal(findContractorOverlaps([base, row('b', 'project-b', 'vendor-1', '2026-10-12', '2026-10-18', { status_override: 'disabled' })]).length, 0);
  assert.equal(findContractorOverlaps([base, row('b', 'project-b', 'vendor-1', '2026-10-12', '2026-10-18', { deleted_at: '2026-10-01' })]).length, 0);
});

test('provisional end of month is used only in display and overlap calculation', () => {
  const original = row('a', 'project-a', 'vendor-1', '2026-10-12', null);
  const interval = getScheduledInterval(original);
  assert.equal(interval.end, '2026-10-31');
  assert.equal(interval.provisional, true);
  assert.equal(original.planned_end_date, null);
  assert.equal(findContractorOverlaps([original, row('b', 'project-b', 'vendor-1', '2026-10-31', '2026-11-02')]).length, 1);
});

test('date or contractor edits recalculate from current rows', () => {
  const first = row('a', 'project-a', 'vendor-1', '2026-10-12', '2026-10-18');
  const second = row('b', 'project-b', 'vendor-1', '2026-10-19', '2026-10-22');
  assert.equal(findContractorOverlaps([first, second]).length, 0);
  assert.equal(findContractorOverlaps([first, { ...second, planned_start_date: '2026-10-18' }]).length, 1);
  assert.equal(findContractorOverlaps([first, { ...second, planned_start_date: '2026-10-18', contractor_id: 'vendor-2' }]).length, 0);
});

test('invalid range is kept in source data and excluded from overlap until corrected', () => {
  const invalid = row('a', 'project-a', 'vendor-1', '2026-10-20', '2026-10-12');
  const other = row('b', 'project-b', 'vendor-1', '2026-10-18', '2026-10-22');
  assert.equal(getScheduledInterval(invalid), null);
  assert.equal(findContractorOverlaps([invalid, other]).length, 0);
  assert.equal(findContractorOverlaps([{ ...invalid, planned_end_date: '2026-10-24' }, other]).length, 1);
});
