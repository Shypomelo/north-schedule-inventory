const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function load(file, imports = {}) {
  const filename = path.join(__dirname, file);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => {
    if (Object.hasOwn(imports, id)) return imports[id];
    if (id === './types') return load('types.ts');
    if (id === './inventory-stock') return load('inventory-stock.ts');
    throw new Error(`Unmapped dependency: ${id}`);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  return mod.exports;
}

const stock = load('inventory-stock.ts');
const { calculateInventoryMonthlyReport } = load('inventory-monthly-report.ts');
const item = { id: 'item', name: 'Test item', unit: 'pcs', category: 'CONSTRUCTION',
  source_type: 'TEST', item_category: 'TEST', opening_quantity: 0, is_active: true };
const tx = (type, quantity, date = '2026-10-02') => ({
  id: `${type}-${date}-${quantity}`, item_id: 'item', transaction_type: type,
  quantity, transaction_date: date, is_voided: false, excluded_by_initialization_id: null,
});

test('IN reversal is a debit while business OUT and inflow semantics stay distinct', () => {
  assert.equal(stock.getInventoryTransactionQuantityDelta('IN', 7), 7);
  assert.equal(stock.getInventoryTransactionQuantityDelta('IN_REVERSAL', 3), -3);
  assert.equal(stock.getInventoryInflowQuantity('IN_REVERSAL', 3), 0);
  assert.equal(stock.calculateInventoryStockQuantity({ inQuantity: 7, inReversalQuantity: 3 }), 4);
  assert.equal(stock.calculateInventoryStockQuantity({ inQuantity: 10, inReversalQuantity: 4 }), 6);
  assert.equal(stock.getInventoryTransactionQuantityDelta('OUT', 3), -3);
  assert.equal(stock.getInventoryTransactionQuantityDelta('RETURN', 3), 3);
  assert.equal(stock.getInventoryTransactionQuantityDelta('ADJUST', -3), -3);
});

test('OPEN month shows gross IN and correction separately without usage', () => {
  const [row] = calculateInventoryMonthlyReport({ year: '2026', month: '10', items: [item],
    transactions: [tx('IN', 7), tx('IN_REVERSAL', 3), tx('IN', 3)] });
  assert.equal(row.monthly_in, 10);
  assert.equal(row.monthly_in_reversal, 3);
  assert.equal(row.monthly_out, 0);
  assert.equal(row.usage_quantity, 0);
  assert.equal(row.closing_quantity, 7);
});

test('prior CLOSED snapshot remains an opening anchor and is not recalculated', () => {
  const snapshot = { inventory_item_id: 'item', closing_quantity: 7, monthly_in: 7,
    monthly_out: 0, usage_quantity: 0 };
  const [row] = calculateInventoryMonthlyReport({ year: '2026', month: '10', items: [item],
    previousClosingItems: [snapshot], transactions: [tx('IN', 7, '2026-09-28'),
      tx('IN_REVERSAL', 3)] });
  assert.equal(row.opening_quantity, 7);
  assert.equal(row.monthly_in_reversal, 3);
  assert.equal(row.closing_quantity, 4);
  assert.equal(snapshot.closing_quantity, 7);
  assert.equal(snapshot.monthly_in, 7);
});

test('voided and initialization-excluded corrections do not affect an OPEN month', () => {
  const voided = { ...tx('IN_REVERSAL', 2), id: 'voided', is_voided: true };
  const excluded = { ...tx('IN_REVERSAL', 1), id: 'excluded', excluded_by_initialization_id: 'init' };
  const [row] = calculateInventoryMonthlyReport({ year: '2026', month: '10', items: [item],
    transactions: [tx('IN', 7), voided, excluded] });
  assert.equal(row.monthly_in_reversal, 0);
  assert.equal(row.closing_quantity, 7);
});
