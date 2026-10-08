const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { receivingLedger } = load(path.resolve(__dirname, 'receiving-history-ledger.ts'));
const { locateReceivingScan } = load(path.resolve(__dirname, 'receiving-scan-locator.ts'));
const { seOrderMockResponse, seOrderViews, seOrderStatus, validateSEOrderMockResponse, matchSEOrderProject, matchSEOrderPending } = load(path.resolve(__dirname, 'se-order-mock.ts'));

function snapshot() {
  return {
    projects: [{ id: 'P', name: '範例北部案場 A', project_code: 'MOCK-NORTH-01' }],
    items: [{ id: 'I', code: 'RSESU-RW0S0NNN4', name: '逆變器', unit: '台', requires_serial: true, is_active: true }],
    materials: [], supplies: [], batches: [], arrivals: [], lines: [], observations: [], matches: [], matchObservations: [],
    receipts: [], fulfilment: {}, scopes: {}, scopeErrors: {}, transactions: [], closings: [], actors: [],
    receiptSerials: [], inventorySerials: [], transactionSerials: [], cancellations: [],
  };
}

test('Partner API v1.0 mock preserves exact raw fields and edge cases without confirming team scope', () => {
  assert.doesNotThrow(() => validateSEOrderMockResponse(seOrderMockResponse));
  const data = snapshot();
  const views = seOrderViews(seOrderMockResponse);
  const match = matchSEOrderProject(views[0], data.projects);
  assert.equal(match.state, 'UNCONFIRMED');
  assert.equal(match.project.id, 'P');
  assert.equal(data.receipts.length, 0);
  assert.equal(data.transactions.length, 0);
  assert.deepEqual(seOrderMockResponse.orders[0].caseNumbers, ['7000001', '7000001-2']);
  assert.equal(seOrderMockResponse.orders[0].items.filter(item => item.name === 'RSESU-RW0S0NNN4').length, 2);
  assert.equal(seOrderMockResponse.orders[0].trackingNos.length, 2);
  assert.deepEqual(seOrderMockResponse.orders[1].caseNumbers, []);
  assert.equal(seOrderMockResponse.orders[1].updatedAt, '');
  assert.match(seOrderStatus(views[1]).label, /partner_review/);
  assert.equal(matchSEOrderProject(views[2], data.projects).state, 'INVALID');
  assert.equal(views.filter(view => view.removal).length, 2);
  assert.equal(matchSEOrderPending(views[0], [], match.project), 'UNCONFIRMED');
  assert.throws(() => validateSEOrderMockResponse({ ...seOrderMockResponse, orders: [seOrderMockResponse.orders[0], seOrderMockResponse.orders[0]], count: 2 }));
  assert.throws(() => validateSEOrderMockResponse({ ...seOrderMockResponse, orders: [{ ...seOrderMockResponse.orders[0], serialNumbers: [] }, ...seOrderMockResponse.orders.slice(1)] }));
  assert.throws(() => validateSEOrderMockResponse({ ...seOrderMockResponse, orders: [{ ...seOrderMockResponse.orders[0], items: [{ name: 'X', qty: 1, lineId: 'fake' }] }, ...seOrderMockResponse.orders.slice(1)] }));
});

test('history shows 10, cancellation 2, effective 8 and a staged remainder only from valid quantity', () => {
  const data = snapshot();
  data.items[0].requires_serial = false;
  data.arrivals.push({ id: 'A', actual_received_at: '2026-10-08T01:00:00Z', created_at: '2026-10-08T01:00:00Z', created_by: 'U', project_id: 'P', voided_at: null });
  data.lines.push({ id: 'L', arrival_id: 'A', inventory_item_id: 'I', quantity: 10, unit: '台', resolution_state: 'STAGED', receipt_id: null });
  data.receipts.push({ id: 'R', source_type: 'ARRIVAL_ROUTE', route_arrival_line_id: 'L', event_type: 'RECEIVE', quantity_received: 6,
    received_by: 'U', received_at: '2026-10-08T02:00:00Z', created_at: '2026-10-08T02:00:00Z', receipt_location: 'OFFICE', inventory_linked: true });
  data.cancellations.push({ id: 'C', arrival_line_id: 'L', reversal_receipt_id: null, quantity: 2, reason: '破損', created_by: 'U', created_at: '2026-10-08T03:00:00Z' });
  data.scopes.R = { receipt_id: 'R', received: 6, requires_serial: false, available: 4, other: 0,
    se: 2, site: 0, prep: 0, available_serial_ids: [], allocations: [{ id: 'AL', route_type: 'SE', quantity: 2, created_at: '2026-10-08T02:30:00Z', cancelled_at: null, supersedes_allocation_id: null }] };
  const rows = receivingLedger(data);
  assert.deepEqual(rows.map(row => row.event.type), ['取消實際到貨', '分配', '正式入庫', '實際到貨']);
  assert.equal(rows.find(row => row.event.type === '實際到貨').original, 10);
  assert.equal(rows.find(row => row.event.type === '實際到貨').effective, 8);
  assert.equal(rows.find(row => row.event.type === '取消實際到貨').state, '已取消到貨');
  const posted = rows.find(row => row.event.type === '正式入庫');
  assert.equal(posted.original, 6);
  assert.equal(posted.effective, 6);
  assert.equal(posted.allocated, 2);
  assert.equal(posted.unallocated, 4);
  assert.equal(posted.state, '部分分配');
  assert.equal(data.lines[0].quantity - data.cancellations[0].quantity - data.receipts[0].quantity_received, 2);
  data.scopes.R.other = 1;
  assert.equal(receivingLedger(data).find(row => row.event.type === '正式入庫').state, '無法確認');
  data.scopes.R.allocations[0].cancelled_at = '2026-10-08T04:00:00Z';
  assert.equal(receivingLedger(data)[0].event.type, '分配撤回');
});

test('scanner locates exact pending, model candidates, received SN and Mock tracking without writing', () => {
  const data = snapshot();
  data.supplies.push({ id: 'S1', project_id: 'P', receiving_only: true, inventory_item_id: 'I', quantity: 2, unit: '台', new_model: 'RSESU-RW0S0NNN4' },
    { id: 'S2', project_id: 'P', receiving_only: true, inventory_item_id: 'I', quantity: 2, unit: '台', new_model: 'RSESU-RW0S0NNN4' });
  for (const id of ['S1', 'S2']) data.fulfilment[`SE_SUPPLY:${id}`] = { expected: 2, fulfilled: 0, remaining: 2, active: true, remaining_status: 'ACTIVE', cancellation: null };
  data.observations.push({ id: 'E', se_supply_record_id: 'S1', normalized_serial: 'MOCK-SN-01', raw_serial: 'MOCK-SN-01', retired_at: null, active_receipt_id: null });
  const before = JSON.stringify(data);
  const views = seOrderViews(seOrderMockResponse);
  assert.deepEqual(locateReceivingScan('MOCK-SN-01', data, views).keys, ['SE_SUPPLY:S1']);
  const model = locateReceivingScan('RSESU-RW0S0NNN4', data, views);
  assert.equal(model.kind, 'PENDING'); assert.equal(model.exact, false); assert.equal(model.keys.length, 2);
  data.observations.push({ id: 'A1', arrival_line_id: 'L', normalized_serial: 'MOCK-SN-01', raw_serial: 'MOCK-SN-01', retired_at: null });
  assert.equal(locateReceivingScan('MOCK-SN-01', data, views).kind, 'HISTORY');
  assert.deepEqual(locateReceivingScan('12345678901', data, views).orderNos, ['SO-20261002-153000']);
  assert.deepEqual(locateReceivingScan('12345678902', data, views).orderNos, ['SO-20261002-153000']);
  assert.equal(locateReceivingScan('UNKNOWN', data, views).kind, 'UNMATCHED');
  assert.equal(JSON.parse(before).receipts.length, data.receipts.length);
});
