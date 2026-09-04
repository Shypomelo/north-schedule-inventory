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
  buildWorkflowActivityLog,
  getCurrentAndNextMilestones,
  getCustomInsertSortOrder,
  getMilestoneCapabilities,
  getVisibleWorkflowMilestones,
  getWorkflowActivityMessage,
  normalizeMilestoneCompletion,
  normalizeWorkflowSortOrders,
  reorderWorkflowMilestones,
} = sourceModule.exports;

const milestone = (id, sortOrder, status = 'NOT_STARTED', overrides = {}) => ({
  id,
  sort_order: sortOrder,
  created_at: `2026-09-04T00:00:${String(sortOrder).padStart(2, '0')}.000Z`,
  status,
  is_applicable: true,
  deleted_at: null,
  phase_key_snapshot: 'PREPARATION',
  ...overrides,
});

test('NOT_STARTED transitions to IN_PROGRESS without an actual date', () => {
  assert.deepEqual(normalizeMilestoneCompletion('IN_PROGRESS', null, '2026-09-04'), {
    status: 'IN_PROGRESS', actual_date: null,
  });
});

test('IN_PROGRESS transitions to COMPLETED with today when actual date is empty', () => {
  assert.deepEqual(normalizeMilestoneCompletion('COMPLETED', null, '2026-09-04'), {
    status: 'COMPLETED', actual_date: '2026-09-04',
  });
});

test('reopening a completed milestone clears actual date', () => {
  assert.deepEqual(normalizeMilestoneCompletion('NOT_STARTED', '2026-09-03'), {
    status: 'NOT_STARTED', actual_date: null,
  });
  assert.deepEqual(normalizeMilestoneCompletion('BLOCKED', '2026-09-03'), {
    status: 'BLOCKED', actual_date: null,
  });
});

test('TEMPLATE milestones can reorder but cannot edit identity or delete', () => {
  assert.deepEqual(getMilestoneCapabilities('TEMPLATE'), {
    editProgress: true, editIdentity: false, changePosition: true, softDelete: false,
  });
});

test('Supabase adapter exposes sort_order to both origins without opening template identity', () => {
  const adapterSource = fs.readFileSync(path.join(__dirname, 'db', 'poc-supabase.ts'), 'utf8');
  assert.match(adapterSource, /'is_applicable', 'status', 'planned_date', 'actual_date', 'notes', 'sort_order'/);
  assert.match(adapterSource, /const customFields[^]*'label', 'source_phase_id', 'source_type_id'/);
});

test('PROJECT_CUSTOM milestones can reorder, edit identity, and soft-delete', () => {
  assert.deepEqual(getMilestoneCapabilities('PROJECT_CUSTOM'), {
    editProgress: true, editIdentity: true, changePosition: true, softDelete: true,
  });
});

test('same-phase reorder moves the dragged milestone before the target', () => {
  const result = reorderWorkflowMilestones([
    milestone('a', 10), milestone('b', 20), milestone('c', 30),
  ], 'c', 'a');
  assert.deepEqual(result.map(row => row.id), ['c', 'a', 'b']);
});

test('cross-phase reorder is rejected', () => {
  assert.throws(() => reorderWorkflowMilestones([
    milestone('a', 10),
    milestone('b', 20, 'NOT_STARTED', { phase_key_snapshot: 'STARTUP' }),
  ], 'a', 'b'), /同一階段/);
});

test('reorder normalization assigns stable global increments of ten', () => {
  const result = normalizeWorkflowSortOrders([
    milestone('c', 35), milestone('a', 5), milestone('b', 22),
  ]);
  assert.deepEqual(result.map(row => [row.id, row.sort_order]), [
    ['c', 10], ['a', 20], ['b', 30],
  ]);
});

test('current and next follow the latest reordered workflow', () => {
  const reordered = reorderWorkflowMilestones([
    milestone('done', 10, 'COMPLETED'),
    milestone('next', 20),
    milestone('current', 30, 'IN_PROGRESS'),
  ], 'current', 'next');
  const result = getCurrentAndNextMilestones(reordered);
  assert.equal(result.current.id, 'current');
  assert.equal(result.next.id, 'next');
});

test('current prioritizes BLOCKED and skips non-applicable milestones for next', () => {
  const result = getCurrentAndNextMilestones([
    milestone('done', 10, 'COMPLETED'),
    milestone('blocked', 20, 'BLOCKED'),
    milestone('not-applicable', 30, 'IN_PROGRESS', { is_applicable: false }),
    milestone('future', 40),
  ]);
  assert.equal(result.current.id, 'blocked');
  assert.equal(result.next.id, 'future');
});

test('hide completed is a frontend-only filter', () => {
  const rows = [milestone('done', 10, 'COMPLETED'), milestone('open', 20)];
  assert.deepEqual(getVisibleWorkflowMilestones(rows, true).map(row => row.id), ['open']);
  assert.deepEqual(getVisibleWorkflowMilestones(rows, false).map(row => row.id), ['done', 'open']);
});

test('workflow activity builder stores only supplied changed fields', () => {
  const log = buildWorkflowActivityLog({
    action: 'WORKFLOW_STATUS_CHANGED',
    targetType: 'PROJECT_MILESTONE',
    targetId: 'milestone-1',
    targetLabel: '初次現勘',
    projectId: 'project-1',
    projectName: '日鑫電纜（二）',
    actorUserId: 'user-1',
    actorName: '測試者',
    before: { status: 'NOT_STARTED' },
    after: { status: 'IN_PROGRESS' },
  });
  assert.deepEqual(JSON.parse(log.before_value), { status: 'NOT_STARTED' });
  assert.deepEqual(JSON.parse(log.after_value), { status: 'IN_PROGRESS' });
  assert.equal(log.target_type, 'PROJECT_MILESTONE');
  assert.equal(log.project_id, 'project-1');
});

test('workflow activity messages are directly readable', () => {
  assert.equal(getWorkflowActivityMessage('WORKFLOW_STATUS_CHANGED', '初次現勘', { status: 'IN_PROGRESS' }), '初次現勘開始');
  assert.equal(getWorkflowActivityMessage('WORKFLOW_PLANNED_DATE_CHANGED', '審查意見書', { planned_date: '2026-09-15' }), '審查意見書預計日期改為 2026-09-15');
  assert.equal(getWorkflowActivityMessage('WORKFLOW_CUSTOM_DELETED', '消防補件'), '消防補件刪除');
  assert.equal(getWorkflowActivityMessage('WORKFLOW_REORDERED', '專案流程'), '流程順序已調整');
});

test('custom insertion retains deterministic gap behavior for creation', () => {
  const rows = [milestone('a', 10), milestone('b', 20)];
  assert.equal(getCustomInsertSortOrder(rows, 'a'), 15);
  assert.equal(getCustomInsertSortOrder(rows, 'b'), 30);
});
