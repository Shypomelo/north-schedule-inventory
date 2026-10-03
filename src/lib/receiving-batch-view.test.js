const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { receivingBatchViews, receivingBatchMatches, receivingTaipeiDay } = load(path.resolve(__dirname, 'receiving-batch-view.ts'));
const { selectReceivingProjects } = load(path.resolve(__dirname, 'project-selectors.ts'));

const empty = () => ({
  projects: [{ id: 'p', name: '已完工案場', status: '已完工', deleted_at: null }],
  items: [{ id: 'i', code: 'SE4000H', name: '設備', unit: '台', requires_serial: true, is_active: true }],
  materials: [], supplies: [], batches: [], arrivals: [], lines: [], observations: [], matches: [],
  matchObservations: [], receipts: [], fulfilment: {}, scopes: {}, scopeErrors: {}, transactions: [],
  closings: [], actors: [], receiptSerials: [], inventorySerials: [], transactionSerials: [], cancellations: [],
});

test('Receiving project choices keep completed and closed projects while excluding deleted rows', () => {
  const projects = [{ id: 'active', status: '進行中', deleted_at: null },
    { id: 'completed', status: '已完工', deleted_at: null },
    { id: 'closed', status: '已結案', deleted_at: null },
    { id: 'deleted', status: '進行中', deleted_at: '2026-10-03T00:00:00Z' }];
  assert.deepEqual(selectReceivingProjects(projects).map(project => project.id), ['active', 'completed', 'closed']);
});

test('one box keeps eight unknown serial lines as one visible work group, separate from the next box', () => {
  const data = empty();
  data.arrivals.push({ id: 'box1', actual_received_at: '2026-10-03T07:20:00Z', project_id: 'p', batch_kind: 'BOX', batch_position: 1 },
    { id: 'box2', actual_received_at: '2026-10-03T07:20:00Z', project_id: 'p', batch_kind: 'BOX', batch_position: 2 });
  for (let index = 0; index < 8; index++) {
    data.lines.push({ id: `unknown${index}`, arrival_id: 'box1', inventory_item_id: null, quantity: 1, unit: null,
      resolution_state: 'UNRESOLVED', receipt_id: null });
    data.observations.push({ id: `entry${index}`, arrival_line_id: `unknown${index}`, normalized_serial: `SN00${index + 1}-AA`,
      inventory_serial_id: null, active_receipt_id: null, retired_at: null });
  }
  data.lines.push({ id: 'known', arrival_id: 'box2', inventory_item_id: 'i', quantity: 1, unit: '台',
    resolution_state: 'STAGED', receipt_id: null });
  data.observations.push({ id: 'known-entry', arrival_line_id: 'known', normalized_serial: 'KNOWN-AA',
    inventory_serial_id: null, active_receipt_id: null, retired_at: null });
  const views = receivingBatchViews(data, []);
  assert.deepEqual(views.map(batch => batch.label).sort(), ['箱 1', '箱 2']);
  const first = views.find(batch => batch.id === 'box1'), second = views.find(batch => batch.id === 'box2');
  assert.equal(first.groups.length, 1);
  assert.equal(first.groups[0].quantity, 8);
  assert.equal(first.groups[0].rows.length, 8);
  assert.equal(first.groups[0].rows.flatMap(row => row.observations.map(entry => entry.normalized_serial)).length, 8);
  assert.equal(second.groups[0].pn, 'SE4000H');
  assert.equal(receivingBatchMatches(first, 'SN008-AA'), true);
  assert.equal(receivingBatchMatches(second, 'SN008-AA'), false);
  assert.equal(receivingBatchMatches(second, 'SE4000H'), true);
  assert.equal(receivingBatchMatches(second, '已完工案場'), true);
  assert.equal(receivingBatchMatches(second, '10/03'), true);
  assert.equal(receivingTaipeiDay('2026-10-02T16:00:00Z'), '2026-10-03');
});

test('fully posted batch remains in history with its physical batch identity', () => {
  const data = empty();
  data.arrivals.push({ id: 'loose', actual_received_at: '2026-10-02T05:00:00Z', project_id: 'p', batch_kind: 'LOOSE', batch_position: 1 });
  data.lines.push({ id: 'line', arrival_id: 'loose', inventory_item_id: 'i', quantity: 1, unit: '台',
    resolution_state: 'POSTED', receipt_id: null });
  data.observations.push({ id: 'entry', arrival_line_id: 'line', normalized_serial: 'DONE-AA',
    inventory_serial_id: 'serial', active_receipt_id: 'receipt', retired_at: null });
  data.receipts.push({ id: 'receipt', source_type: 'ARRIVAL_ROUTE', route_arrival_line_id: 'line',
    event_type: 'RECEIVE', quantity_received: 1 });
  const views = receivingBatchViews(data, []);
  assert.equal(views[0].label, '散料');
  assert.equal(views[0].workCount, 0);
  assert.equal(receivingBatchMatches(views[0], 'DONE-AA'), true);
});
