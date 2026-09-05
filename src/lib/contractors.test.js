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
  CONTRACTOR_CAPABILITY_OPTIONS,
  CONTRACTOR_TYPE_OPTIONS,
  ensurePrimaryCapability,
  getContractorsForWorkType,
  isContractorType,
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
const ladderMigrationPath = path.join(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20260905090500_add_contractor_ladder_installation_capability.sql',
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
    ensurePrimaryCapability(['electrical', 'racking', 'ladder_installation'], 'electrical'),
    ['electrical', 'racking', 'ladder_installation'],
  );
  assert.equal(validateContractorCapabilities(
    'electrical', ['electrical', 'racking', 'ladder_installation'],
  ), null);
});

test('ladder installation is capability-only and the six primary contractor types stay unchanged', () => {
  assert.deepEqual(CONTRACTOR_TYPE_OPTIONS.map(option => option.key), [
    'racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other',
  ]);
  assert.deepEqual(CONTRACTOR_CAPABILITY_OPTIONS.map(option => option.key), [
    'racking', 'electrical', 'steel', 'roof_cover', 'civil', 'ladder_installation', 'other',
  ]);
  assert.equal(isContractorType('ladder_installation'), false);
  assert.equal(
    validateContractorCapabilities('ladder_installation', ['ladder_installation']),
    '主要類別包含不支援的類別',
  );
});

test('new migration only expands the capability allow-list without backfilling or changing primary types', () => {
  const migration = fs.readFileSync(ladderMigrationPath, 'utf8');
  assert.match(migration, /DROP CONSTRAINT contractors_work_capabilities_allowed_check/);
  assert.match(migration, /ADD CONSTRAINT contractors_work_capabilities_allowed_check/);
  assert.match(migration, /'ladder_installation'/);
  assert.match(migration, /array_position\(work_capabilities, NULL\) IS NULL/);
  assert.doesNotMatch(migration, /contractors_contractor_type_check|\bUPDATE\b/i);
  assert.doesNotMatch(migration, /work_capabilities_nonempty_check|primary_category_capability_check/);
});

test('Admin capability UI includes ladder while the primary category select remains six types', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'admin', 'contractors', 'page.tsx'), 'utf8');
  assert.match(page, /CONTRACTOR_CAPABILITY_OPTIONS\.map/);
  assert.match(page, /ladder_installation: 'text-cyan-400/);
  assert.match(page, /CONTRACTOR_CAPABILITIES\.map\(type =>/);
  assert.match(page, /<select[\s\S]*?CONTRACTOR_TYPES\.map\(t =>/);
  assert.match(page, /CONTRACTOR_TYPE_OPTIONS\.map/);
});

test('contractor adapters validate capability values while preserving the six-value primary contract', () => {
  const adapter = fs.readFileSync(path.join(__dirname, 'db', 'poc-supabase.ts'), 'utf8');
  const createSource = adapter.slice(adapter.indexOf('createContractor: async'), adapter.indexOf('updateContractor: async'));
  const updateSource = adapter.slice(adapter.indexOf('updateContractor: async'), adapter.indexOf('deleteContractor: async'));
  assert.match(createSource, /validateContractorCapabilities\(c\.contractor_type, c\.work_capabilities\)/);
  assert.match(updateSource, /isContractorType\(updates\.contractor_type\)/);
  assert.match(updateSource, /validateContractorCapabilityValues\(updates\.work_capabilities\)/);
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

test('ladder custom work defaults to ladder-capable contractors instead of generic other', () => {
  const contractors = [
    contractor('ladder', 'electrical', ['electrical', 'ladder_installation']),
    contractor('generic-other', 'other', ['other']),
    contractor('inactive-ladder', 'other', ['other', 'ladder_installation'], { is_active: false }),
  ];
  assert.deepEqual(
    getContractorsForWorkType(contractors, 'other', false, '  爬梯安裝  ').map(item => item.id),
    ['ladder'],
  );
  assert.deepEqual(
    getContractorsForWorkType(contractors, 'other', true, '爬梯安裝').map(item => item.id),
    ['ladder', 'generic-other'],
  );
  assert.deepEqual(
    getContractorsForWorkType(contractors, 'other', false, '防水').map(item => item.id),
    ['generic-other'],
  );
  const section = fs.readFileSync(path.join(__dirname, '..', 'components', 'ConstructionProgressSection.tsx'), 'utf8');
  assert.match(section, /workName=\{row\.work_name\}/);
  assert.match(section, /workType="other" workName=\{name\}/);
});

test('migration does not constrain legacy unnamed other progress rows', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.doesNotMatch(migration, /active_other_work_name_check/);
  assert.doesNotMatch(migration, /nullif\(btrim\(work_name\)/);
});
