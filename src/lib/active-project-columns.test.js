const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const { ACTIVE_PROJECT_SECTION_COLUMNS, getActiveProjectColumns } = loadTypeScript(path.join(__dirname, 'active-project-columns.ts'));

test('active project header and rows share one colgroup contract', () => {
  const columns = getActiveProjectColumns({ showBracket: true, showPower: true, showInspection: true, showMeter: true, showRoof: true, showStartDate: true, showComplete: false });
  assert.deepEqual(columns.map(column => column.key), ['actions', 'code', 'name', 'capacity', 'manager', 'bracket', 'power', 'inspection', 'meter', 'roof', 'startDate', 'notes']);
  const source = fs.readFileSync(path.join(__dirname, '../app/projects/[[...filter]]/page.tsx'), 'utf8');
  assert.match(source, /<colgroup>[\s\S]*columns\.map/);
  assert.match(source, /table-fixed/);
  assert.doesNotMatch(source, /<table className="w-full text-left border-collapse min-w-\[1500px\]">/);
});

test('the first three active project sections render one shared cross-section geometry', () => {
  assert.deepEqual(ACTIVE_PROJECT_SECTION_COLUMNS.map(column => column.key), ['actions', 'code', 'name', 'capacity', 'manager', 'bracket', 'power', 'inspection', 'meter', 'roof', 'startDate', 'notes']);
  const source = fs.readFileSync(path.join(__dirname, '../app/projects/[[...filter]]/page.tsx'), 'utf8');
  assert.match(source, /usesSharedActiveGeometry \? ACTIVE_PROJECT_SECTION_COLUMNS/);
  assert.match(source, /data-column-geometry=\{usesSharedActiveGeometry \? 'active-projects-v1'/);
  assert.match(source, /usesSharedActiveGeometry && <th[\s\S]{0,160}>新設頂蓋<\/th>/);
  assert.match(source, /usesSharedActiveGeometry && <td className="p-1">[\s\S]{0,80}\{showRoof && <DateDualInput/);
  assert.match(source, /usesSharedActiveGeometry && <td className="p-1">[\s\S]{0,80}\{showStartDate && <SmartDateInput/);
});

test('active project route contract remains catch-all compatible', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/projects/[[...filter]]/page.tsx'), 'utf8');
  assert.match(source, /parseProjectsRoute/);
});
