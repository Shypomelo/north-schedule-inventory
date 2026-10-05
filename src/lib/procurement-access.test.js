const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, 'procurement-access.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObject = { exports: {} };
vm.runInNewContext(compiled, { module: moduleObject, exports: moduleObject.exports });
const { isInventoryEditor, isProcurementRoute, isStandardAppRole, landingPath } = moduleObject.exports;

test('existing editor roles retain write UI while Viewer and Procurement do not', () => {
  assert.equal(isInventoryEditor('ADMIN'), true);
  assert.equal(isInventoryEditor('ENGINEER'), true);
  assert.equal(isInventoryEditor('VIEWER'), false);
  assert.equal(isInventoryEditor('PROCUREMENT'), false);
});

test('standard app capability excludes Procurement from server business routes', () => {
  assert.equal(isStandardAppRole('ADMIN'), true);
  assert.equal(isStandardAppRole('ENGINEER'), true);
  assert.equal(isStandardAppRole('VIEWER'), true);
  assert.equal(isStandardAppRole('PROCUREMENT'), false);
});

test('Procurement can only navigate Inventory and Receiving routes', () => {
  for (const route of ['/inventory', '/inventory/transactions', '/inventory/serials', '/inventory/monthly', '/receiving']) {
    assert.equal(isProcurementRoute(route), true, route);
  }
  for (const route of ['/', '/schedule', '/projects', '/toolbox', '/todos', '/admin', '/se-supply', '/inventory-extra']) {
    assert.equal(isProcurementRoute(route), false, route);
  }
  assert.equal(landingPath('PROCUREMENT'), '/inventory');
  assert.equal(landingPath('ADMIN'), '/');
  assert.equal(landingPath('ENGINEER'), '/');
  assert.equal(landingPath('VIEWER'), '/');
});
