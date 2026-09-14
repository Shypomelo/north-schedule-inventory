const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'project-materials.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = module.paths;
sourceModule._compile(transpiled, sourcePath);

const {
  buildCustomProjectMaterial, buildProjectMaterialFromCatalog, buildPurchaseRequestText,
  deriveBatchProcurementSummary, filterMaterialCatalogByGroup, filterMaterialCatalogByGroupId,
  fromDatetimeLocalValue, getActiveMaterialGroups, getMaterialCatalogGroups,
  toDatetimeLocalValue, UNGROUPED_MATERIAL_CATALOG_VALUE,
} = sourceModule.exports;

const catalogItem = {
  id: 'catalog-1', group_id: 'group-1', group_name: 'XLPE', name: 'XLPE', default_specification: 'XLPE_250',
  default_unit: '米', default_reminder_enabled: true, default_reminder_days_before: 21,
  is_active: true, sort_order: 10, created_by: 'admin-1',
  created_at: '2026-09-13T00:00:00Z', updated_at: '2026-09-13T00:00:00Z',
};
const batch = {
  id: 'batch-1', project_id: 'project-1', batch_name: '第一次叫料',
  ordered_at: '2026-09-15T02:00:00.000Z', notes: null, created_by: 'member-1',
  created_at: '2026-09-13T00:00:00Z', updated_at: '2026-09-13T00:00:00Z',
};

test('catalog groups drive model filtering while preserving ungrouped rows', () => {
  const ungrouped = { ...catalogItem, id: 'catalog-2', group_name: null };
  const rsg = { ...catalogItem, id: 'catalog-3', group_name: 'RSG管' };
  assert.deepEqual(getMaterialCatalogGroups([ungrouped, catalogItem, rsg]), ['RSG管', 'XLPE', UNGROUPED_MATERIAL_CATALOG_VALUE]);
  assert.deepEqual(filterMaterialCatalogByGroup([ungrouped, catalogItem, rsg], 'XLPE'), [catalogItem]);
  assert.deepEqual(filterMaterialCatalogByGroup([ungrouped, catalogItem, rsg], UNGROUPED_MATERIAL_CATALOG_VALUE), [ungrouped]);
});

test('canonical groups drive ordered active quick-add filtering', () => {
  const groups = [
    { id: 'group-2', name: '停用', sort_order: 0, is_active: false },
    { id: 'group-1', name: 'AC線材', sort_order: 20, is_active: true },
    { id: 'group-3', name: 'RSG管', sort_order: 10, is_active: true },
  ];
  assert.deepEqual(getActiveMaterialGroups(groups).map(group => group.id), ['group-3', 'group-1']);
  assert.deepEqual(filterMaterialCatalogByGroupId([catalogItem, { ...catalogItem, id: 'catalog-2', group_id: 'group-3' }], 'group-1'), [catalogItem]);
});

test('catalog and custom material builders assign the selected batch', () => {
  const regular = buildProjectMaterialFromCatalog('project-1', 'batch-1', catalogItem, 'member-1');
  assert.equal(regular.batch_id, 'batch-1');
  assert.equal(regular.catalog_item_id, 'catalog-1');
  assert.equal(regular.specification, 'XLPE_250');
  assert.equal(regular.unit, '米');
  assert.equal(regular.reminder_days_before, 21);
  assert.equal(regular.expected_delivery_at, null);
  assert.equal(regular.received_at, null);
  const custom = buildCustomProjectMaterial('project-1', 'batch-1', 'member-1', { item_name: '特殊接頭', unit: '個' });
  assert.equal(custom.batch_id, 'batch-1');
  assert.equal(custom.catalog_item_id, null);
  assert.equal(custom.item_name, '特殊接頭');
  assert.equal(custom.unit, '個');
  assert.equal(custom.reminder_enabled, false);
});

test('batch status is derived without a second persisted status source', () => {
  const base = { ...buildProjectMaterialFromCatalog('project-1', 'batch-1', catalogItem, 'member-1'), id: 'material-1', created_at: '', updated_at: '' };
  assert.equal(deriveBatchProcurementSummary({ ...batch, ordered_at: null }, []).status, 'NOT_ORDERED');
  assert.equal(deriveBatchProcurementSummary(batch, [base]).status, 'ORDERED');
  assert.deepEqual(deriveBatchProcurementSummary(batch, [
    { ...base, received_at: '2026-09-20T06:00:00Z', procurement_status: 'RECEIVED' },
    { ...base, id: 'material-2', procurement_status: 'ORDERED' },
  ]), { status: 'PARTIAL_RECEIVED', total: 2, received: 1 });
  assert.equal(deriveBatchProcurementSummary(batch, [{ ...base, received_at: '2026-09-20T06:00:00Z', procurement_status: 'RECEIVED' }]).status, 'RECEIVED');
});

test('datetime-local conversion round trips through an ISO timestamp', () => {
  const localValue = '2026-09-20T14:00';
  const iso = fromDatetimeLocalValue(localValue);
  assert.ok(iso);
  assert.equal(toDatetimeLocalValue(iso), localValue);
  assert.equal(fromDatetimeLocalValue(''), null);
});

test('purchase request text is batch-scoped and only includes checked rows', () => {
  const base = { ...buildProjectMaterialFromCatalog('project-1', 'batch-1', catalogItem, 'member-1'), id: 'material-1', created_at: '', updated_at: '' };
  const text = buildPurchaseRequestText('天泰智慧-日鑫電纜(二)', batch, [
    { ...base, quantity: 10, include_in_purchase_request: true },
    { ...base, id: 'material-2', item_name: 'PVC', specification: 'PVC_80', quantity: 25, unit: '米', include_in_purchase_request: true },
    { ...base, id: 'material-3', item_name: '另一批', include_in_purchase_request: false },
  ]);
  assert.equal(text, '案場：天泰智慧-日鑫電纜(二)\nXLPE_250 10米\nPVC_80 25米');
  assert.doesNotMatch(text, /另一批/);
  assert.doesNotMatch(text, /批次|叫料時間|1\./);
});

test('base migration keeps procurement demand separate from inventory and reminders', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260913130945_create_material_catalog_and_project_materials.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE public\.material_catalog_items/);
  assert.match(migration, /CREATE TABLE public\.project_materials/);
  assert.doesNotMatch(migration, /CREATE TABLE public\.(todos|reminders|inventory_transactions)/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.(inventory_items|inventory_transactions)/);
});

test('group migration only adds the nullable catalog group column', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260913151412_add_material_catalog_group_name.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN group_name text/);
  assert.doesNotMatch(migration, /NOT NULL|CREATE TABLE|DROP TABLE|GRANT/);
});

test('batch migration is backward compatible, project-safe, and RLS protected', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260913160636_add_project_material_batches.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE public\.project_material_batches/);
  assert.match(migration, /ordered_at timestamptz/);
  assert.match(migration, /ADD COLUMN expected_delivery_at timestamptz/);
  assert.match(migration, /ADD COLUMN received_at timestamptz/);
  assert.match(migration, /'既有物料'/);
  assert.match(migration, /expected_delivery_on::timestamp AT TIME ZONE 'Asia\/Taipei'/);
  assert.match(migration, /FOREIGN KEY \(batch_id, project_id\)/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(migration, /ALTER COLUMN batch_id SET NOT NULL/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.project_material_batches FROM anon, authenticated/);
  assert.match(migration, /created_by = \(SELECT app_private\.current_member_id\(\)\)/);
  assert.doesNotMatch(migration, /CREATE TABLE public\.(todos|reminders|inventory_transactions)/);
  assert.doesNotMatch(migration, /DROP (TABLE|COLUMN)/);
});

test('material groups migration is non-destructive, backfills group ids, and mirrors catalog RLS', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260914133322_add_material_groups.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE public\.material_groups/);
  assert.match(migration, /ADD COLUMN group_id uuid REFERENCES public\.material_groups/);
  assert.match(migration, /UPDATE public\.material_catalog_items AS item/);
  assert.match(migration, /lower\(btrim\(item\.group_name\)\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.material_groups FROM anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.material_groups TO authenticated/);
  assert.match(migration, /created_by = \(SELECT app_private\.current_member_id\(\)\)/);
  assert.doesNotMatch(migration, /DROP (TABLE|COLUMN)|ALTER COLUMN group_name/);
});

test('project modal exposes the Phase 1 material tab', () => {
  const modal = fs.readFileSync(path.resolve(__dirname, '../components/ProjectDetailModal.tsx'), 'utf8');
  assert.match(modal, /id: 'materials', label: '物料'/);
  assert.match(modal, /<ProjectMaterials projectId=\{project\.id\}/);
});
