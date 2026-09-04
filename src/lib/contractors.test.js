const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'contractors.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = module.paths;
sourceModule._compile(transpiled, sourcePath);

const {
  ensurePrimaryCapability,
  getContractorsForWorkType,
  validateContractorCapabilities,
} = sourceModule.exports;

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20260904154311_construction_progress_v2.sql',
);

const contractor = (id, contractorType, workCapabilities, overrides = {}) => ({
  id,
  name: id,
  contractor_type: contractorType,
  work_capabilities: workCapabilities,
  is_active: true,
  deleted_at: null,
  ...overrides,
});

test('migration backfills each existing primary category as its initial capability', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /SET work_capabilities = ARRAY\[contractor_type\]/);
  assert.match(migration, /CHECK \(cardinality\(work_capabilities\) > 0\)/);
  assert.match(migration, /CHECK \(contractor_type = ANY\(work_capabilities\)\)/);
  assert.match(migration, /work_capabilities <@ ARRAY\[/);
});

test('legacy-style insert is normalized before strict checks', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /BEFORE INSERT OR UPDATE ON public\.contractors/);
  assert.match(migration, /cardinality\(NEW\.work_capabilities\) = 0/);
  assert.match(migration, /NEW\.work_capabilities := ARRAY\[NEW\.contractor_type\]/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app_private\.normalize_contractor_work_capabilities\(\) FROM PUBLIC/);
});

test('legacy-style primary category update preserves old capability and adds the new primary', () => {
  assert.deepEqual(ensurePrimaryCapability(['steel'], 'electrical'), ['steel', 'electrical']);
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /array_append\([\s\S]*NEW\.work_capabilities,[\s\S]*NEW\.contractor_type/);
});

test('new-style insert keeps valid multiple capabilities unchanged', () => {
  assert.deepEqual(
    ensurePrimaryCapability(['electrical', 'racking'], 'electrical'),
    ['electrical', 'racking'],
  );
});

test('new-style update can remove a non-primary capability', () => {
  assert.deepEqual(ensurePrimaryCapability(['electrical'], 'electrical'), ['electrical']);
});

test('attempting to remove the primary capability causes normalization to restore it', () => {
  assert.deepEqual(ensurePrimaryCapability(['racking'], 'electrical'), ['racking', 'electrical']);
});

test('main category must be present in capabilities', () => {
  assert.equal(
    validateContractorCapabilities('electrical', ['racking']),
    '主要類別必須包含在可施作工項中',
  );
});

test('multiple capabilities are valid and changing primary preserves them', () => {
  assert.equal(validateContractorCapabilities('electrical', ['racking', 'electrical']), null);
  assert.deepEqual(ensurePrimaryCapability(['racking'], 'electrical'), ['racking', 'electrical']);
});

test('empty and unsupported capabilities are rejected by application validation', () => {
  assert.equal(validateContractorCapabilities('racking', []), '請至少選擇一項可施作工項');
  assert.equal(
    validateContractorCapabilities('racking', ['racking', 'waterproof']),
    '可施作工項包含不支援的類別',
  );
});

test('racking finds a contractor whose primary is electrical but capability includes racking', () => {
  const result = getContractorsForWorkType([
    contractor('multi', 'electrical', ['electrical', 'racking']),
  ], 'racking', false);
  assert.deepEqual(result.map(item => item.id), ['multi']);
});

test('steel contractor without racking capability is absent from default racking options', () => {
  const result = getContractorsForWorkType([
    contractor('steel-only', 'steel', ['steel']),
  ], 'racking', false);
  assert.deepEqual(result, []);
});

test('showAll returns every active, non-deleted contractor', () => {
  const result = getContractorsForWorkType([
    contractor('racking', 'racking', ['racking']),
    contractor('steel', 'steel', ['steel']),
    contractor('inactive', 'electrical', ['electrical'], { is_active: false }),
  ], 'racking', true);
  assert.deepEqual(result.map(item => item.id), ['racking', 'steel']);
});

test('other capability is not a wildcard for fixed work types', () => {
  const result = getContractorsForWorkType([
    contractor('other-only', 'other', ['other']),
  ], 'racking', false);
  assert.deepEqual(result, []);
});

test('custom other work defaults to contractors with other capability', () => {
  const result = getContractorsForWorkType([
    contractor('other-capable', 'steel', ['steel', 'other']),
    contractor('steel-only', 'steel', ['steel']),
  ], 'other', false);
  assert.deepEqual(result.map(item => item.id), ['other-capable']);
});

test('migration does not constrain legacy unnamed other progress rows', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.doesNotMatch(migration, /active_other_work_name_check/);
  assert.doesNotMatch(migration, /nullif\(btrim\(work_name\)/);
});
