const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildReceiptScheduleTask,
  formatRecentReceiptDateTime,
  selectEngineeringProjectIds,
  selectRecentReceiptGroups,
} = require('./test-load-ts.cjs')(path.join(__dirname, 'material-reminders.ts'));

const project = (id, name, status = '施工中') => ({ id, name, status, is_active: true, address: `${name}地址` });
const responsibility = (memberId, projectRow, positionName = '工程') => ({
  assignment: { member_id: memberId, project_id: projectRow.id, position_id: positionName },
  project: projectRow,
  position: { id: positionName, name: positionName, sort_order: 1 },
  milestones: [], current_milestone: null, previous_milestone: null, current_planned_date: null,
});
const batch = (id, projectId, name, plannedReceiptAt, overrides = {}) => ({
  id, project_id: projectId, batch_name: name, planned_receipt_at: plannedReceiptAt,
  received_at: null, ...overrides,
});
const material = (id, projectId, batchId, expected, overrides = {}) => ({
  id, project_id: projectId, batch_id: batchId, item_name: `物料${id}`, specification: null,
  quantity: 1, unit: '式', procurement_status: 'ORDERED', expected_delivery_at: expected,
  received_at: null, reminder_enabled: true, reminder_days_before: 7, ...overrides,
});

test('engineering ownership uses only the canonical active engineering assignment', () => {
  const owned = project('owned', '我的案場');
  const other = project('other', '他人案場');
  const closed = project('closed', '結案案場', '已結案');
  assert.deepEqual(selectEngineeringProjectIds([
    responsibility('me', owned),
    responsibility('me', other, '設計'),
    responsibility('other-user', other),
    responsibility('me', closed),
  ], 'me'), ['owned']);
});

test('recent receipts honor overdue, 14-day, reminder, receipt, grouping, and owner rules', () => {
  const now = new Date('2026-09-15T04:00:00.000Z');
  const owned = project('owned', '我的案場');
  const other = project('other', '他人案場');
  const batches = [
    batch('overdue', owned.id, '逾期批次', '2026-09-14T04:00:00.000Z'),
    batch('upcoming', owned.id, '近期批次', '2026-09-20T06:00:00.000Z'),
    batch('other', other.id, '他人批次', '2026-09-14T04:00:00.000Z'),
  ];
  const groups = selectRecentReceiptGroups({
    memberId: 'me',
    responsibilities: [responsibility('me', owned), responsibility('other-user', other)],
    projects: [owned, other],
    batches,
    materials: [
      material('overdue-disabled', owned.id, 'overdue', null, { reminder_enabled: false, reminder_days_before: null }),
      material('partial', owned.id, 'overdue', null, { procurement_status: 'PARTIAL_RECEIVED' }),
      material('future-visible', owned.id, 'upcoming', null),
      material('future-too-early', owned.id, 'upcoming', '2026-09-24T06:00:00.000Z', { reminder_days_before: 3 }),
      material('future-disabled', owned.id, 'upcoming', null, { reminder_enabled: false, reminder_days_before: null }),
      material('received', owned.id, 'upcoming', '2026-09-20T06:00:00.000Z', { procurement_status: 'RECEIVED', received_at: '2026-09-15T02:00:00.000Z' }),
      material('beyond-horizon', owned.id, 'upcoming', '2026-10-01T06:00:00.000Z', { reminder_days_before: 30 }),
      material('not-mine', other.id, 'other', '2026-09-14T04:00:00.000Z'),
    ],
    scheduleTasks: [{ id: 'task-1', source_material_batch_id: 'upcoming', source_material_receipt_at: '2026-09-20T06:00:00.000Z', status: '' }],
    now,
  });

  assert.deepEqual(groups.map(group => group.batch.id), ['overdue', 'upcoming']);
  assert.equal(groups[0].status, 'OVERDUE');
  assert.equal(groups[0].overdueDays, 1);
  assert.equal(groups[0].materials.length, 2);
  assert.equal(groups[0].isPartial, true);
  assert.deepEqual(groups[1].materials.map(row => row.id), ['future-disabled', 'future-visible']);
  assert.equal(groups[1].scheduleTaskId, 'task-1');
});

test('receipt schedule prefill binds the batch and preserves the Taipei delivery time', () => {
  const projectRow = project('project-1', '聯華觀音廠');
  const batchRow = batch('batch-1', projectRow.id, '第一批叫料', '2026-09-20T06:00:00.000Z');
  const materialRow = material('m1', projectRow.id, batchRow.id, '2026-09-20T06:00:00.000Z', { specification: 'XLPE_250', quantity: 300, unit: '米' });
  const group = selectRecentReceiptGroups({
    memberId: 'owner-1', responsibilities: [responsibility('owner-1', projectRow)], projects: [projectRow],
    batches: [batchRow], materials: [materialRow], scheduleTasks: [], now: new Date('2026-09-15T04:00:00.000Z'),
  })[0];
  const task = buildReceiptScheduleTask({ group, workGroupId: 'engineering', owner: { id: 'owner-1' }, creator: { id: 'owner-1', name: '王工程師' } });
  assert.equal(formatRecentReceiptDateTime(group.expectedDeliveryAt), '9/20 14:00');
  assert.equal(task.task_type, '收料');
  assert.equal(task.title, '收料');
  assert.equal(task.project_id, projectRow.id);
  assert.equal(task.main_assignee_id, 'owner-1');
  assert.equal(task.task_date, '2026-09-20');
  assert.equal(task.start_time, '14:00');
  assert.equal(task.source_material_batch_id, batchRow.id);
  assert.equal(task.source_material_receipt_at, group.expectedDeliveryAt);
  assert.match(task.description, /第一批叫料｜1 項物料/);
  assert.match(task.description, /XLPE_250 × 300米/);
});

test('one batch splits into one dashboard group per effective receipt time', () => {
  const projectRow = project('project-1', 'A 案場');
  const batchRow = batch('batch-1', projectRow.id, '採購代叫', '2026-09-22T01:00:00.000Z');
  const groups = selectRecentReceiptGroups({
    memberId: 'owner-1', responsibilities: [responsibility('owner-1', projectRow)], projects: [projectRow],
    batches: [batchRow],
    materials: [
      material('xlpe', projectRow.id, batchRow.id, null),
      material('pv', projectRow.id, batchRow.id, null),
      material('rsg', projectRow.id, batchRow.id, '2026-09-25T06:00:00.000Z'),
    ],
    scheduleTasks: [], now: new Date('2026-09-20T01:00:00.000Z'),
  });
  assert.deepEqual(groups.map(group => [group.expectedDeliveryAt, group.materials.map(row => row.id)]), [
    ['2026-09-22T01:00:00.000Z', ['pv', 'xlpe']],
    ['2026-09-25T06:00:00.000Z', ['rsg']],
  ]);
});

test('completed batches disappear even when their material rows are stale', () => {
  const projectRow = project('project-1', '聯華觀音廠');
  const batchRow = batch('batch-1', projectRow.id, '完成批次', '2026-09-14T06:00:00.000Z', {
    received_at: '2026-09-15T06:00:00.000Z',
  });
  const groups = selectRecentReceiptGroups({
    memberId: 'owner-1', responsibilities: [responsibility('owner-1', projectRow)], projects: [projectRow],
    batches: [batchRow], materials: [material('m1', projectRow.id, batchRow.id, batchRow.planned_receipt_at)],
    scheduleTasks: [], now: new Date('2026-09-16T04:00:00.000Z'),
  });
  assert.deepEqual(groups, []);
});

test('Phase A migration is additive, canonical, indexed, and database-deduplicated', () => {
  const migrationsDir = path.resolve(__dirname, '../../supabase/migrations');
  const filename = fs.readdirSync(migrationsDir).find(name => name.endsWith('_material_reminder_schedule_relation.sql'));
  assert.ok(filename);
  const migration = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
  assert.match(migration, /ADD COLUMN source_material_batch_id uuid/);
  assert.match(migration, /REFERENCES public\.project_material_batches\(id\) ON DELETE SET NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX schedule_tasks_active_material_batch_unique_idx/);
  assert.match(migration, /status IS DISTINCT FROM '取消'/);
  assert.match(migration, /INSERT INTO public\.schedule_task_types/);
  assert.match(migration, /SELECT '收料'/);
  assert.match(migration, /project_materials_pending_receipt_project_time_idx/);
  assert.doesNotMatch(migration, /CREATE TABLE|DROP (TABLE|COLUMN)|inventory_transactions/);
});

test('Phase A.1 migration makes the batch time canonical without touching inventory', () => {
  const migrationsDir = path.resolve(__dirname, '../../supabase/migrations');
  const filename = fs.readdirSync(migrationsDir).find(name => name.endsWith('_material_receipt_plan_convergence.sql'));
  assert.ok(filename);
  const migration = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
  assert.match(migration, /ADD COLUMN planned_receipt_at timestamptz/);
  assert.match(migration, /ADD COLUMN received_at timestamptz/);
  assert.match(migration, /update_material_receipt_plan/);
  assert.match(migration, /complete_material_receipt_schedule/);
  assert.match(migration, /SECURITY INVOKER/g);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon/);
  assert.doesNotMatch(migration, /inventory_transactions|CREATE TABLE|DROP (TABLE|COLUMN)/);
});

test('receipt-time group migration is additive, scoped, invoker-safe, and preserves receipt audit rows', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../supabase/migrations/20260916120000_material_receipt_time_groups.sql'),
    'utf8',
  );
  assert.match(migration, /ADD COLUMN same_day_delivery boolean NOT NULL DEFAULT true/);
  assert.match(migration, /ADD COLUMN source_material_receipt_at timestamptz/);
  assert.match(migration, /schedule_tasks_active_material_receipt_group_unique_idx/);
  assert.match(migration, /source_material_batch_id, source_material_receipt_at/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.update_material_receipt_override/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reschedule_material_receipt_group/);
  assert.match(migration, /SECURITY INVOKER/g);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_material_batch_same_day/);
  assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM) public\.material_receipts/);
  assert.doesNotMatch(migration, /inventory_|CREATE TABLE|DROP TABLE|DROP COLUMN/);
});

test('material UI supports batch defaults and explicit material overrides', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/ProjectMaterials.tsx'), 'utf8');
  assert.match(source, /updateMaterialReceiptPlan\(batch\.id, batch\.planned_receipt_at\)/);
  assert.match(source, /同天到貨/);
  assert.match(source, /預設到貨/);
  assert.match(source, /batch\.received_at \? <p[^>]*>已收料/);
  assert.match(source, /same_day_delivery/);
  assert.match(source, /updateMaterialReceiptOverride/);
  assert.match(source, /getEffectiveExpectedDeliveryAt/);
  assert.match(source, /formatCompactTaipeiReceiptTime/);
});

test('schedule completion appends canonical receipt events instead of writing actual time directly', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../supabase/migrations/20260916170000_material_receipt_corrections.sql'),
    'utf8',
  );
  const completeFunction = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_material_receipt_schedule'),
    migration.indexOf('REVOKE ALL ON FUNCTION public.reverse_material_receipt'),
  );
  assert.match(completeFunction, /public\.confirm_material_receipt/);
  assert.match(completeFunction, /source_material_receipt_at/);
  assert.doesNotMatch(completeFunction, /UPDATE public\.project_materials[\s\S]*received_at/);
});
