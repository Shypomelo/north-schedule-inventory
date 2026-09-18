const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildReceiptHistoryItems,
  filterPendingReceivingItems,
  getReceiptReversibleQuantity,
  getReceivingGroupStatusLabel,
  groupPendingReceivingItems,
  selectPendingReceivingItems,
  selectReceivingItems,
  summarizeMaterialReceipts,
} = require('./test-load-ts.cjs')(path.join(__dirname, 'material-receiving.ts'));

const project = { id: 'project-1', name: '北辦案場', status: '施工中', deleted_at: null };
const batch = { id: 'batch-1', project_id: project.id, planned_receipt_at: '2026-09-20T06:00:00Z' };
const users = [
  { id: 'receiver-1', name: '姿妤', is_active: true },
  { id: 'requester-1', name: '育丞', is_active: true },
];
const material = (id, destination, overrides = {}) => ({
  id,
  project_id: project.id,
  batch_id: batch.id,
  item_name: '盤體',
  specification: null,
  quantity: 10,
  unit: '台',
  procurement_status: 'ORDERED',
  expected_delivery_at: null,
  received_at: null,
  delivery_destination: destination,
  ...overrides,
});
const seRecord = (overrides = {}) => ({
  id: 'se-1',
  project_id: null,
  project_name: null,
  old_model: null,
  new_model: 'P401',
  quantity: 2,
  unit: '台',
  expected_delivery_at: '2026-09-21T01:00:00Z',
  requested_by: 'requester-1',
  procurement_status: 'ORDERED',
  received_at: null,
  ...overrides,
});
const receipt = (overrides = {}) => ({
  id: 'receipt-1',
  source_type: 'PROJECT_MATERIAL',
  project_material_id: 'office-1',
  se_supply_record_id: null,
  event_type: 'RECEIVE',
  reversal_of_id: null,
  quantity_received: 6,
  received_by: 'receiver-1',
  received_at: '2026-09-20T06:32:00Z',
  notes: null,
  created_at: '2026-09-20T06:32:00Z',
  ...overrides,
});

test('receiving center lists only unfinished OFFICE project materials and canonical SE rows', () => {
  const rows = selectPendingReceivingItems({
    projects: [project],
    batches: [batch],
    projectMaterials: [
      material('office-1', 'OFFICE'),
      material('site-1', 'SITE'),
      material('warehouse-1', 'WAREHOUSE'),
      material('done-1', 'OFFICE', { procurement_status: 'RECEIVED', received_at: '2026-09-19T00:00:00Z' }),
    ],
    seRecords: [seRecord(), seRecord({ id: 'legacy-received', receive_date: '2026-09-19' })],
    receipts: [],
    users,
  });
  assert.deepEqual(rows.map(row => row.sourceId), ['office-1', 'se-1']);
  assert.equal(rows[0].expectedDeliveryAt, batch.planned_receipt_at);
  assert.equal(rows[1].contextLabel, '育丞');
});

test('partial receipts reduce the remaining quantity and keep the source pending', () => {
  const rows = selectPendingReceivingItems({
    projects: [project],
    batches: [batch],
    projectMaterials: [material('office-1', 'OFFICE')],
    seRecords: [],
    receipts: [receipt()],
    users,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receivedQuantity, 6);
  assert.equal(rows[0].remainingQuantity, 4);
  assert.equal(rows[0].status, 'PARTIAL_RECEIVED');
});

test('receiving archive hides canonical project and SE rows without changing receipt history', () => {
  const archivedAt = '2026-09-17T00:00:00.000Z';
  const archivedReceipt = receipt({ project_material_id: 'archived-office' });
  const rows = selectReceivingItems({
    projects: [project],
    batches: [batch],
    projectMaterials: [
      material('office-1', 'OFFICE'),
      material('archived-office', 'OFFICE', { receiving_archived_at: archivedAt }),
    ],
    seRecords: [seRecord(), seRecord({ id: 'archived-se', receiving_archived_at: archivedAt })],
    receipts: [archivedReceipt],
    users,
  });
  assert.deepEqual(rows.map(row => row.sourceId), ['office-1', 'se-1']);
  assert.equal(buildReceiptHistoryItems({
    receipts: [archivedReceipt],
    projectMaterials: [material('archived-office', 'OFFICE', { receiving_archived_at: archivedAt })],
    seRecords: [],
    projects: [project],
    users,
  }).length, 1);
});

test('append-only reversals subtract effective quantity and return corrected sources to pending', () => {
  const original = receipt({ quantity_received: 10 });
  const reversal = receipt({
    id: 'reversal-1',
    event_type: 'REVERSAL',
    reversal_of_id: original.id,
    quantity_received: 4,
    received_at: '2026-09-20T07:00:00Z',
  });
  const receipts = [original, reversal];
  const rows = selectPendingReceivingItems({
    projects: [project], batches: [batch],
    projectMaterials: [material('office-1', 'OFFICE', {
      procurement_status: 'RECEIVED', received_at: '2026-09-20T06:32:00Z',
    })],
    seRecords: [], receipts, users,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receivedQuantity, 6);
  assert.equal(rows[0].remainingQuantity, 4);
  assert.equal(rows[0].status, 'PARTIAL_RECEIVED');
  assert.equal(getReceiptReversibleQuantity(original, receipts), 6);
  assert.deepEqual(summarizeMaterialReceipts(receipts, 'PROJECT_MATERIAL', 'office-1', 10), {
    effectiveQuantity: 6,
    status: 'PARTIAL_RECEIVED',
    lastReceivedAt: original.received_at,
  });
});

test('receiving projection groups the same project and Taipei local date without collapsing canonical times', () => {
  const otherBatch = { ...batch, id: 'batch-2', planned_receipt_at: '2026-09-20T01:00:00Z' };
  const rows = selectReceivingItems({
    projects: [project], batches: [batch, otherBatch],
    projectMaterials: [
      material('office-1', 'OFFICE', { batch_id: otherBatch.id }),
      material('office-2', 'OFFICE'),
      material('office-3', 'OFFICE', { expected_delivery_at: '2026-09-21T06:00:00Z' }),
    ],
    seRecords: [], receipts: [], users,
  });
  const groups = groupPendingReceivingItems(rows);
  assert.deepEqual(groups.map(group => group.items.map(item => item.sourceId)), [
    ['office-1', 'office-2'],
    ['office-3'],
  ]);
  assert.deepEqual(groups[0].items.map(item => item.expectedDeliveryAt), [
    '2026-09-20T01:00:00Z',
    '2026-09-20T06:00:00Z',
  ]);
});

test('a receiving group belongs to exactly one current-state tab and corrections move it back to pending', () => {
  const received = receipt({ quantity_received: 10 });
  const base = { projects: [project], batches: [batch], projectMaterials: [material('office-1', 'OFFICE')], seRecords: [], users };
  const completedGroups = groupPendingReceivingItems(selectReceivingItems({ ...base, receipts: [received] }));
  assert.equal(completedGroups[0].status, 'RECEIVED');
  assert.equal(getReceivingGroupStatusLabel(completedGroups[0].status), '已收到');

  const correctedGroups = groupPendingReceivingItems(selectReceivingItems({
    ...base,
    receipts: [received, receipt({ id: 'reversal-1', event_type: 'REVERSAL', reversal_of_id: received.id, quantity_received: 4 })],
  }));
  assert.equal(correctedGroups[0].status, 'PARTIAL_RECEIVED');
  assert.equal(getReceivingGroupStatusLabel(correctedGroups[0].status), '未全');
  assert.equal(correctedGroups[0].items[0].remainingQuantity, 4);
});

test('search covers project, applicant, item, and model labels', () => {
  const rows = selectPendingReceivingItems({
    projects: [project],
    batches: [batch],
    projectMaterials: [material('office-1', 'OFFICE')],
    seRecords: [seRecord()],
    receipts: [],
    users,
  });
  assert.deepEqual(filterPendingReceivingItems(rows, '北辦案場').map(row => row.sourceId), ['office-1']);
  assert.deepEqual(filterPendingReceivingItems(rows, '育丞').map(row => row.sourceId), ['se-1']);
  assert.deepEqual(filterPendingReceivingItems(rows, 'P401').map(row => row.sourceId), ['se-1']);
});

test('receipt history is append-only evidence sorted newest first with receiver identity', () => {
  const rows = buildReceiptHistoryItems({
    receipts: [
      receipt(),
      receipt({
        id: 'receipt-2',
        source_type: 'SE_SUPPLY',
        project_material_id: null,
        se_supply_record_id: 'se-1',
        quantity_received: 2,
        received_at: '2026-09-21T07:00:00Z',
      }),
    ],
    projectMaterials: [material('office-1', 'OFFICE')],
    seRecords: [seRecord()],
    projects: [project],
    users,
  });
  assert.deepEqual(rows.map(row => row.receipt.id), ['receipt-2', 'receipt-1']);
  assert.equal(rows[0].receivedByLabel, '姿妤');
  assert.equal(rows[1].contextLabel, '北辦案場');
});

test('Phase A.2 migration enforces one real source, server-derived receiver, RLS, and no inventory side effect', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260916093042_material_receiving_center.sql'),
    'utf8',
  );
  assert.match(migration, /CREATE TABLE public\.material_receipts/);
  assert.match(migration, /material_receipts_single_source_check/);
  assert.match(migration, /REFERENCES public\.project_materials\(id\)/);
  assert.match(migration, /REFERENCES public\.se_supply_records\(id\)/);
  assert.match(migration, /v_member_id := app_private\.current_member_id\(\)/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.confirm_material_receipt/);
  assert.match(migration, /TO authenticated/);
  assert.match(migration, /p_quantity_received > v_material\.quantity - v_received/);
  assert.match(migration, /p_quantity_received > v_se\.quantity - v_received/);
  assert.match(migration, /UPDATE public\.project_material_batches/);
  assert.doesNotMatch(migration, /inventory_transactions|inventory_items/);
});

test('all allowed Dashboard perspectives expose one shared receiving center without a sidebar route', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'components', 'SidebarV3.tsx'), 'utf8');
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  assert.match(dashboard, /availableDashboardSubpages/);
  assert.match(dashboard, /物料到貨/);
  assert.equal((dashboard.match(/<MaterialReceivingCenter\/>/g) || []).length, 1);
  assert.match(center, /aria-label="物料到貨狀態"/);
  assert.match(center, />確認收到</);
  assert.doesNotMatch(sidebar, /物料到貨/);
});

test('receiving group delete archives exact canonical rows and receipt history stays delete-free', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  assert.match(center, /Promise\.all\(group\.items\.map/);
  assert.match(center, /updateProjectMaterial\(item\.sourceId, \{ receiving_archived_at: archivedAt \}\)/);
  assert.match(center, /updateSESupplyRecord\(item\.sourceId, \{ receiving_archived_at: archivedAt \}\)/);
  assert.doesNotMatch(center, /deleteProjectMaterial|deleteSESupplyRecord/);
  assert.doesNotMatch(center, /deleteMaterialReceipt|deleteReceipt/);
});

test('receiving archive migration is additive and grants only the new SE update column', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260917002655_receiving_center_archive.sql'),
    'utf8',
  );
  assert.match(migration, /ALTER TABLE public\.project_materials[\s\S]*ADD COLUMN receiving_archived_at timestamptz/);
  assert.match(migration, /ALTER TABLE public\.se_supply_records[\s\S]*ADD COLUMN receiving_archived_at timestamptz/);
  assert.match(migration, /GRANT UPDATE \(receiving_archived_at\)[\s\S]*public\.se_supply_records[\s\S]*authenticated/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE|material_receipts/);
});

test('receiving center offers canonical procurement-created project materials without replacing SE creation', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  assert.match(center, />新增到貨</);
  assert.match(center, /onChoose\('project'\)/);
  assert.match(center, /onChoose\('se'\)/);
  assert.match(center, /createProjectMaterialBatch/);
  assert.match(center, /createProjectMaterial\(buildProcurementCreatedProjectMaterial/);
  assert.match(center, /createSESupplyRecord/);
  assert.doesNotMatch(center, /incoming_materials|temporary_receipts/);
});

test('receiving detail edits expected time through canonical default and override flows', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  const projectMaterials = fs.readFileSync(path.join(__dirname, '..', 'components', 'ProjectMaterials.tsx'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260915163310_material_receipt_plan_convergence.sql'), 'utf8');
  const relationMigration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260915155604_material_reminder_schedule_relation.sql'), 'utf8');
  assert.match(center, /dbAdapter\.updateMaterialReceiptPlan\(editingItem\.batchId, expectedAt\)/);
  assert.match(center, /dbAdapter\.updateMaterialReceiptOverride\(editingItem\.sourceId, expectedAt\)/);
  assert.match(center, /dbAdapter\.updateSESupplyRecord\(editingItem\.sourceId, \{ expected_delivery_at: expectedAt \}\)/);
  assert.match(projectMaterials, /dbAdapter\.updateMaterialReceiptPlan\(batch\.id, batch\.planned_receipt_at\)/);
  assert.match(projectMaterials, /dbAdapter\.updateMaterialReceiptOverride\(material\.id, expectedDeliveryAt\)/);
  assert.match(migration, /UPDATE public\.project_materials[\s\S]*SET expected_delivery_at = p_planned_receipt_at/);
  assert.match(migration, /UPDATE public\.schedule_tasks[\s\S]*task_date = \(p_planned_receipt_at AT TIME ZONE 'Asia\/Taipei'\)::date/);
  assert.match(relationMigration, /schedule_tasks_active_material_batch_unique_idx/);
});

test('receipt correction migration is additive, bounded, append-only, and shared by project and SE sources', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260916170000_material_receipt_corrections.sql'),
    'utf8',
  );
  assert.match(migration, /ADD COLUMN event_type text NOT NULL DEFAULT 'RECEIVE'/);
  assert.match(migration, /ADD COLUMN reversal_of_id uuid REFERENCES public\.material_receipts/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reverse_material_receipt/);
  assert.match(migration, /p_quantity_reversed > v_original\.quantity_received - v_already_reversed/);
  assert.match(migration, /event_type = 'REVERSAL'/);
  assert.match(migration, /app_private\.rederive_material_receipt_source/);
  assert.match(migration, /p_source_type = 'SE_SUPPLY'/);
  assert.doesNotMatch(migration, /DELETE FROM public\.material_receipts|UPDATE public\.material_receipts/);
  assert.doesNotMatch(migration, /inventory_transactions|inventory_items/);
});

test('received history and project material actual display both open the shared correction dialog', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  const projectMaterials = fs.readFileSync(path.join(__dirname, '..', 'components', 'ProjectMaterials.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceiptHistoryDialog.tsx'), 'utf8');
  assert.match(center, /<MaterialReceiptHistoryDialog/);
  assert.match(projectMaterials, /<MaterialReceiptHistoryDialog/);
  assert.match(dialog, /dbAdapter\.reverseMaterialReceipt/);
  assert.match(dialog, />收料更正</);
  assert.match(dialog, /原收料保留/);
});

test('procurement-created project selection reuses the Schedule autocomplete filter contract', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  const scheduleForm = fs.readFileSync(path.join(__dirname, '..', 'components', 'ScheduleTaskForm.tsx'), 'utf8');
  assert.match(center, /filterProjectsForAutocomplete\(projects, query\)/);
  assert.match(scheduleForm, /filterProjectsForAutocomplete\(projects, projectNameInput\)/);
  assert.match(center, /setOpen\(Boolean\(value\.trim\(\)\)\)/);
  assert.match(center, /if \(projectId\) onSelect\(''\)/);
});

test('project arrival uses five expandable slots and creates only canonical project material rows', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  const projectMaterials = fs.readFileSync(path.join(__dirname, 'project-materials.ts'), 'utf8');
  assert.match(center, /createArrivalSlots\(0\)/);
  assert.match(center, /createArrivalSlots\(current\.length\)/);
  assert.match(center, /filledSlots = slots\.filter\(slot => slot\.itemName\.trim\(\)\)/);
  assert.match(center, /Promise\.all\(filledSlots\.map/);
  assert.match(projectMaterials, /include_in_purchase_request: false/);
  assert.doesNotMatch(center, /incoming_materials|receiving_only/);
});

test('project arrival uses active canonical material groups instead of legacy group names', () => {
  const center = fs.readFileSync(path.join(__dirname, '..', 'components', 'MaterialReceivingCenter.tsx'), 'utf8');
  assert.match(center, /dbAdapter\.listMaterialGroups\(false\)/);
  assert.match(center, /filterSelectableMaterialCatalogItems\(catalog, activeGroups\)/);
  assert.match(center, /filterMaterialCatalogByGroupId\(selectableCatalog, slot\.groupId\)/);
  assert.match(center, /activeGroups\.map\(group => <option key=\{group\.id\} value=\{group\.id\}>\{group\.name\}<\/option>\)/);
  assert.doesNotMatch(center, /catalog\.map\(item => item\.group_name/);
});
