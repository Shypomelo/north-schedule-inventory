const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const {selectProjectRequirement: select} = load(path.resolve(__dirname, 'receiving-project-requirements.ts'));
const row = (id, quantity, received) => ({id, quantity, received});
test('8 received of 20: next 3 reuses the only requirement', () => {
  assert.deepEqual(select([row('A',20,8)],3,''),{materialId:'A',createNew:false});
});
test('multiple compatible requirements need explicit selection', () => {
  const rows=[row('A',20,8),row('B',5,0)];
  assert.equal(select(rows,3,''),null);
  assert.deepEqual(select(rows,3,'B'),{materialId:'B',createNew:false});
});
test('insufficient or already fulfilled requirements cannot absorb shipment', () => {
  assert.deepEqual(select([row('A',20,20),row('B',5,4)],3,''),{materialId:null,createNew:true});
});
test('stale explicit selection does not silently create a new requirement', () => {
  assert.equal(select([row('B',20,8)],3,'A'),null);
  assert.equal(select([row('A',20,19)],3,'A'),null);
});
test('numeric strings from Postgres and exact remaining capacity are accepted', () => {
  assert.deepEqual(select([row('A','20','8')],12,''),{materialId:'A',createNew:false});
});
