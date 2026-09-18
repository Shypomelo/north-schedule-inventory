const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'se-supply', 'page.tsx'), 'utf8');

test('SE project-name column expands to the longest full name and keeps scoped horizontal scrolling', () => {
  assert.match(source, /const projectColumnWidth = useMemo/);
  assert.match(source, /records\.map\(record => getProjectDisplayName\(record\)\)/);
  assert.match(source, /projects\.filter\(project => project\.is_active\)\.map\(project => project\.name\)/);
  assert.match(source, /Math\.min\(30, Math\.max\(16, longestDisplayUnits \+ 2\)\)/);
  assert.match(source, /w-max min-w-\[82\.5rem\] table-auto/);
  assert.match(source, /style=\{\{ width: projectColumnWidth, minWidth: projectColumnWidth, maxWidth: projectColumnWidth \}\}/);
  assert.match(source, /flex-1 overflow-auto/);
  assert.doesNotMatch(source, /w-48">案名|truncate|text-ellipsis/);
});

test('SE table filtering, inline editing, and Excel export remain on the existing flow', () => {
  assert.match(source, /const filteredRecords = useMemo/);
  assert.match(source, /handleProjectInputChange/);
  assert.match(source, /handleProjectBlur/);
  assert.match(source, /handleCellBlur/);
  assert.match(source, /XLSX\.utils\.json_to_sheet\(data\)/);
  assert.match(source, /XLSX\.writeFile/);
});
