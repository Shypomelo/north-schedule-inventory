const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const ts = require('typescript');

const projectRoot = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveProjectAlias(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    request = path.join(projectRoot, 'src', request.slice(2));
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const {
  filterAvailableSerials,
  findExactAvailableSerial,
  getAvailableSerialsFIFO,
} = require('../src/lib/inventory-serial-selector.ts');

const makeSerial = (overrides) => ({
  id: overrides.id,
  item_id: overrides.item_id,
  batch_id: overrides.batch_id,
  serial_number: overrides.serial_number,
  status: overrides.status,
  project_id: null,
  notes: null,
  created_at: overrides.created_at,
  updated_at: overrides.created_at,
});

const batches = [
  { id: 'batch-old', in_date: '2026-08-20' },
  { id: 'batch-target', in_date: '2026-08-24' },
];

const allSerials = [
  makeSerial({
    id: 'fifo-first', item_id: 'item-a', batch_id: 'batch-old',
    serial_number: 'SJ1823A-03068570E-F9', status: '在庫', created_at: '2026-08-20T01:00:00Z',
  }),
  makeSerial({
    id: 'target', item_id: 'item-a', batch_id: 'batch-target',
    serial_number: 'SJ1823A-0306856C0-AE', status: '在庫', created_at: '2026-08-24T01:00:00Z',
  }),
  makeSerial({
    id: 'already-out', item_id: 'item-a', batch_id: 'batch-old',
    serial_number: 'SJ1823A-0306857C0-AE', status: '已出庫', created_at: '2026-08-20T02:00:00Z',
  }),
  makeSerial({
    id: 'other-item', item_id: 'item-b', batch_id: 'batch-old',
    serial_number: 'SJ1823A-0306858C0-AE', status: '在庫', created_at: '2026-08-20T03:00:00Z',
  }),
];

const available = getAvailableSerialsFIFO({
  allSerials,
  batches,
  itemId: 'item-a',
  transactionType: 'OUT',
  requiresSerial: true,
  isEditMode: false,
  initialSerials: [],
});

test('partial and full serial searches use the canonical available list', () => {
  assert.deepEqual(filterAvailableSerials(available, 'AE').map(row => row.id), ['target']);
  assert.deepEqual(filterAvailableSerials(available, '6C0').map(row => row.id), ['target']);
  assert.deepEqual(filterAvailableSerials(available, '0306856C0').map(row => row.id), ['target']);
  assert.equal(findExactAvailableSerial(available, 'sj1823a-0306856c0-ae').id, 'target');
  assert.equal(filterAvailableSerials(available, 'NOT-FOUND').length, 0);
});

test('unavailable and other-item serials cannot enter OUT results', () => {
  assert.equal(available.some(row => row.id === 'already-out'), false);
  assert.equal(available.some(row => row.id === 'other-item'), false);
  assert.equal(filterAvailableSerials(available, '0306857C0').length, 0);
  assert.equal(filterAvailableSerials(available, '0306858C0').length, 0);
});

test('filtered rows share selection and clearing search preserves it', () => {
  const selectedSerials = new Set();
  const [searchRow] = filterAvailableSerials(available, '6c0');
  selectedSerials.add(searchRow.serial_number);

  assert.equal(selectedSerials.has(available.find(row => row.id === 'target').serial_number), true);
  assert.deepEqual(filterAvailableSerials(available, '').map(row => row.id), ['fifo-first', 'target']);
  assert.equal(selectedSerials.has(searchRow.serial_number), true);
});

test('substring filtering preserves FIFO order', () => {
  assert.deepEqual(
    filterAvailableSerials(available, 'SJ1823A').map(row => row.id),
    ['fifo-first', 'target'],
  );
});
