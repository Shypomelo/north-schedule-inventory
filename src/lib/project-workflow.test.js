const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'project-workflow.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = module.paths;
sourceModule._compile(transpiled, sourcePath);

const {
  getCurrentAndNextMilestones,
  getCustomInsertSortOrder,
  getMilestoneCapabilities,
  normalizeMilestoneCompletion,
} = sourceModule.exports;

const milestone = (id, sortOrder, status = 'NOT_STARTED', overrides = {}) => ({
  id,
  sort_order: sortOrder,
  created_at: `2026-09-04T00:00:0${sortOrder % 10}.000Z`,
  status,
  is_applicable: true,
  deleted_at: null,
  ...overrides,
});

test('current and next use the one ordered applicable workflow', () => {
  const result = getCurrentAndNextMilestones([
    milestone('done', 10, 'COMPLETED'),
    milestone('future', 40),
    milestone('blocked', 20, 'BLOCKED'),
    milestone('not-applicable', 30, 'IN_PROGRESS', { is_applicable: false }),
  ]);
  assert.equal(result.current.id, 'blocked');
  assert.equal(result.next.id, 'future');
});

test('current falls back to the first unfinished milestone', () => {
  const result = getCurrentAndNextMilestones([
    milestone('done', 10, 'COMPLETED'),
    milestone('first', 20),
    milestone('second', 30),
  ]);
  assert.equal(result.current.id, 'first');
  assert.equal(result.next.id, 'second');
});

test('completion normalization supplies and clears actual dates', () => {
  assert.deepEqual(normalizeMilestoneCompletion('COMPLETED', null, '2026-09-04'), {
    status: 'COMPLETED', actual_date: '2026-09-04',
  });
  assert.deepEqual(normalizeMilestoneCompletion('IN_PROGRESS', '2026-09-03'), {
    status: 'IN_PROGRESS', actual_date: null,
  });
});

test('custom insertion uses a gap, appends, and has a deterministic no-gap fallback', () => {
  const rows = [milestone('a', 10), milestone('b', 20)];
  assert.equal(getCustomInsertSortOrder(rows, 'a'), 15);
  assert.equal(getCustomInsertSortOrder(rows, 'b'), 30);
  assert.equal(getCustomInsertSortOrder([milestone('a', 10), milestone('b', 11)], 'a'), 10);
});

test('template and custom milestones expose only permitted UI capabilities', () => {
  assert.deepEqual(getMilestoneCapabilities('TEMPLATE'), {
    editProgress: true, editIdentity: false, changePosition: false, softDelete: false,
  });
  assert.deepEqual(getMilestoneCapabilities('PROJECT_CUSTOM'), {
    editProgress: true, editIdentity: true, changePosition: true, softDelete: true,
  });
});
