const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const { getActiveProjectColumns } = loadTypeScript(path.join(__dirname, 'active-project-columns.ts'));

test('active project header and rows share one colgroup contract', () => {
  const columns = getActiveProjectColumns({ showBracket: true, showPower: true, showInspection: true, showMeter: true, showRoof: true, showStartDate: true, showComplete: false });
  assert.deepEqual(columns.map(column => column.key), ['actions', 'code', 'name', 'capacity', 'manager', 'bracket', 'power', 'inspection', 'meter', 'roof', 'startDate', 'notes']);
  const source = fs.readFileSync(path.join(__dirname, '../app/projects/[[...filter]]/page.tsx'), 'utf8');
  assert.match(source, /<colgroup>[\s\S]*columns\.map/);
  assert.match(source, /table-fixed/);
  assert.doesNotMatch(source, /<table className="w-full text-left border-collapse min-w-\[1500px\]">/);
});

test('active project route contract remains catch-all compatible', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/projects/[[...filter]]/page.tsx'), 'utf8');
  assert.match(source, /parseProjectsRoute/);
});
