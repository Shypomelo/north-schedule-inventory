const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'construction-progress.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = module.paths;
sourceModule._compile(transpiled, sourcePath);

const { classifyConstructionItem, getProjectEntryDate } = sourceModule.exports;

const row = (workType, plannedStartDate, overrides = {}) => ({
  work_type: workType,
  planned_start_date: plannedStartDate,
  is_completed: false,
  deleted_at: null,
  ...overrides,
});

test('project entry is the earlier active racking/electrical date', () => {
  assert.equal(getProjectEntryDate([
    row('racking', '2026-09-08'),
    row('electrical', '2026-09-12'),
  ]), '2026-09-08');
});

test('project entry can come from electrical alone', () => {
  assert.equal(getProjectEntryDate([
    row('racking', null),
    row('electrical', '2026-09-12'),
  ]), '2026-09-12');
});

test('project entry is null when both main work dates are missing', () => {
  assert.equal(getProjectEntryDate([
    row('racking', null),
    row('electrical', null),
  ]), null);
});

test('non-main work before project entry is PREWORK', () => {
  assert.equal(
    classifyConstructionItem(row('other', '2026-09-01'), '2026-09-08', '2026-09-04'),
    'PREWORK',
  );
});

test('non-main work after project entry is not PREWORK', () => {
  assert.equal(
    classifyConstructionItem(row('roof_cover', '2026-09-10'), '2026-09-08', '2026-09-04'),
    'SCHEDULED',
  );
});

test('completed takes precedence over all date-derived statuses', () => {
  assert.equal(
    classifyConstructionItem(
      row('other', '2026-09-01', { is_completed: true }),
      '2026-09-08',
      '2026-09-04',
    ),
    'COMPLETED',
  );
});

test('future main work is SCHEDULED', () => {
  assert.equal(
    classifyConstructionItem(row('racking', '2026-09-08'), '2026-09-08', '2026-09-04'),
    'SCHEDULED',
  );
});

test('past main work is IN_PROGRESS', () => {
  assert.equal(
    classifyConstructionItem(row('electrical', '2026-09-03'), '2026-09-03', '2026-09-04'),
    'IN_PROGRESS',
  );
});
