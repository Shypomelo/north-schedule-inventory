const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { buildProjectMaterialOverview } = require('./test-load-ts.cjs')(path.join(__dirname, 'project-material-overview.ts'));

const batches = [
  { id: 'b1', project_id: 'p', batch_name: '第一次叫料' },
  { id: 'b2', project_id: 'p', batch_name: '第二次叫料' },
  { id: 'other', project_id: 'q', batch_name: '其他案場' },
];
const material = (id, batch_id, specification, quantity, project_id = 'p') => ({ id, batch_id, project_id, item_name: '支架材料', specification, unit: '組', quantity });
const receipt = (id, project_material_id, quantity_received, event_type = 'RECEIVE', reversal_of_id = null) => ({ id, source_type: 'PROJECT_MATERIAL', project_material_id, quantity_received, event_type, reversal_of_id, received_at: '2026-10-10' });

test('overview scopes to project, groups exact name/spec/unit, and nets reversals once', () => {
  const rows = buildProjectMaterialOverview('p', [material('m1', 'b1', 'A', 50), material('m2', 'b2', 'A', 30), material('m3', 'b2', 'B', 20), material('m4', 'other', 'A', 999, 'q')], batches, [
    receipt('r1', 'm1', 40), receipt('r1', 'm1', 40), receipt('r2', 'm1', 10, 'REVERSAL', 'r1'), receipt('r3', 'm2', 30), receipt('r4', 'm4', 999),
  ]);
  assert.equal(rows.length, 2);
  const a = rows.find(row => row.specification === 'A');
  assert.deepEqual([a.ordered, a.received, a.remaining], [80, 60, 20]);
  assert.deepEqual(a.sources.map(source => source.batchName), ['第一次叫料', '第二次叫料']);
  assert.deepEqual([rows.find(row => row.specification === 'B').ordered, rows.find(row => row.specification === 'B').remaining], [20, 20]);
});
