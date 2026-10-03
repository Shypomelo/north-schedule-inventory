const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { receivedItemGroups, receivingHistory, reverseReceiptPayload, receivedPostCommand } = load(path.resolve(__dirname, 'receiving-v6.ts'));
const { createReceivingV6Api } = load(path.resolve(__dirname, 'db/receiving-v6.ts'));

const at = '2026-10-03T10:00:00Z';
const reentryAt = '2026-10-03T12:00:00Z';
function snapshot(serialized = true) {
  const itemId = serialized ? 'item-serial' : 'item-plain', quantity = serialized ? 7 : 10;
  const data = {
    projects: [], items: [{ id: itemId, code: serialized ? 'P401' : 'CABLE', name: '測試品項', unit: serialized ? '台' : 'm', requires_serial: serialized, is_active: true }],
    materials: [], supplies: [], batches: [], arrivals: [{ id: 'arrival', actual_received_at: at, created_at: at, created_by: 'actor', project_id: null, voided_at: null }],
    lines: [{ id: 'line', arrival_id: 'arrival', inventory_item_id: itemId, quantity, unit: serialized ? '台' : 'm', resolution_state: 'POSTED', receipt_id: 'in', version: 1 }],
    observations: [], matches: [], matchObservations: [], receipts: [{ id: 'in', source_type: 'ARRIVAL_ROUTE', route_arrival_line_id: 'line', arrival_line_id: null, event_type: 'RECEIVE', inventory_transaction_id: 'tx-in', inventory_linked: true, receipt_location: 'OFFICE', quantity_received: quantity, received_by: 'actor', received_at: at, created_at: at }],
    fulfilment: {}, scopes: {}, scopeErrors: {}, closings: [], actors: [{ id: 'actor', name: '測試員' }],
    transactions: [{ id: 'tx-in', item_id: itemId, transaction_type: 'IN', source: 'ARRIVAL_ROUTE', quantity, created_at: at, is_voided: false, excluded_by_initialization_id: null, reverses_transaction_id: null, reenters_reversal_id: null }],
    receiptSerials: [], inventorySerials: [], transactionSerials: [],
  };
  if (serialized) for (let n = 0; n < quantity; n++) {
    const entryId = `entry-${n}`, serialId = `serial-${n}`;
    data.observations.push({ id: entryId, arrival_line_id: 'line', normalized_serial: `SERIAL${n}-AA`, inventory_serial_id: serialId, active_receipt_id: 'in', retired_at: null });
    data.receiptSerials.push({ receipt_id: 'in', entry_id: entryId, inventory_serial_id: serialId, linked_existing: false });
    data.inventorySerials.push({ id: serialId, item_id: itemId, serial_number: `SERIAL${n}-AA`, status: '在庫' });
    data.transactionSerials.push({ transaction_id: 'tx-in', serial_id: serialId, is_pending: false });
  }
  return data;
}
function reverse(data, count) {
  data.receipts.push({ id: 'reversal', source_type: 'ARRIVAL_ROUTE', route_arrival_line_id: 'line', arrival_line_id: null, event_type: 'REVERSAL', reversal_of_id: 'in', inventory_transaction_id: 'tx-reversal', inventory_linked: true, receipt_location: 'OFFICE', quantity_received: count, received_by: 'actor', received_at: '2026-10-03T11:00:00Z', created_at: '2026-10-03T11:00:00Z' });
  data.transactions.push({ id: 'tx-reversal', item_id: data.items[0].id, transaction_type: 'IN_REVERSAL', source: 'RECEIVING_IN_REVERSAL', quantity: count, created_at: '2026-10-03T11:00:00Z', is_voided: false, excluded_by_initialization_id: null, reverses_transaction_id: 'tx-in', reenters_reversal_id: null });
  for (let n = 0; n < count && data.items[0].requires_serial; n++) {
    data.receiptSerials.push({ receipt_id: 'reversal', entry_id: `entry-${n}`, inventory_serial_id: `serial-${n}`, linked_existing: false });
    data.observations[n].active_receipt_id = null;
    data.inventorySerials[n].status = '待入庫';
    data.transactionSerials.push({ transaction_id: 'tx-reversal', serial_id: `serial-${n}`, is_pending: false });
  }
  data.lines[0].resolution_state = 'STAGED';
}

test('seven receipt serials map to exact canonical entry and inventory identities; three form reversal payload', () => {
  const data = snapshot();
  const row = receivingHistory(data).find(value => value.receiptId === 'in');
  assert.equal(row.transactionId, 'tx-in');
  assert.equal(row.arrivalLineId, 'line');
  assert.equal(row.itemId, 'item-serial');
  assert.equal(row.serials.length, 7);
  assert.equal(row.reversibleSerials.length, 7);
  assert.deepEqual(row.serials.map(value => [value.entryId, value.inventorySerialId]), Array.from({ length: 7 }, (_, n) => [`entry-${n}`, `serial-${n}`]));
  assert.deepEqual(reverseReceiptPayload(row, 'request', 3, ['entry-0', 'entry-2', 'entry-5'], at, '重新確認'), {
    p_request_id: 'request', p_receipt_id: 'in', p_quantity: 3,
    p_entry_ids: ['entry-0', 'entry-2', 'entry-5'], p_reversed_at: at, p_reason: '重新確認',
  });
  assert.throws(() => reverseReceiptPayload(row, 'request', 1, ['not-from-receipt'], at, '理由'));
});

test('reversal restores three staged serials and routes same identities through reentry RPC', () => {
  const data = snapshot(); reverse(data, 3);
  const group = receivedItemGroups(data)[0];
  assert.equal(group.quantity, 3);
  assert.equal(group.stages.length, 1);
  const stage = group.stages[0];
  assert.equal(stage.kind, 'REENTRY');
  assert.deepEqual(stage.serials.map(value => [value.entryId, value.inventorySerialId]), [['entry-0', 'serial-0'], ['entry-1', 'serial-1'], ['entry-2', 'serial-2']]);
  assert.deepEqual(receivedPostCommand(stage, 'request', 3, stage.serials.map(value => value.entryId), reentryAt), {
    name: 'reenter_receiving_inventory', args: { p_request_id: 'request', p_reversal_receipt_id: 'reversal', p_quantity: 3,
      p_entry_ids: ['entry-0', 'entry-1', 'entry-2'], p_received_at: new Date(reentryAt).toISOString(), p_notes: null },
  });
  const original = receivingHistory(data).find(value => value.receiptId === 'in');
  assert.equal(original.reversibleQuantity, 4);
  assert.deepEqual(original.reversibleSerials.map(value => value.entryId), ['entry-3', 'entry-4', 'entry-5', 'entry-6']);
});

test('full reversal and partial reentry retain canonical serial IDs and four staged entries', () => {
  const data = snapshot(); reverse(data, 7);
  assert.equal(receivedItemGroups(data)[0].stages[0].quantity, 7);
  data.transactions.push({ id: 'tx-rein', item_id: 'item-serial', transaction_type: 'IN', source: 'RECEIVING_REENTRY', quantity: 3,
    created_at: '2026-10-03T12:00:00Z', is_voided: false, excluded_by_initialization_id: null,
    reverses_transaction_id: null, reenters_reversal_id: 'tx-reversal' });
  data.receipts.push({ id: 'rein', source_type: 'ARRIVAL_ROUTE', route_arrival_line_id: 'line', arrival_line_id: null,
    event_type: 'RECEIVE', reentry_of_reversal_id: 'reversal', inventory_transaction_id: 'tx-rein',
    inventory_linked: true, receipt_location: 'OFFICE', quantity_received: 3,
    received_by: 'actor', received_at: '2026-10-03T12:00:00Z', created_at: '2026-10-03T12:00:00Z' });
  for (let n = 0; n < 3; n++) {
    data.observations[n].active_receipt_id = 'rein';
    data.inventorySerials[n].status = '在庫';
    data.receiptSerials.push({ receipt_id: 'rein', entry_id: `entry-${n}`, inventory_serial_id: `serial-${n}`, linked_existing: false });
    data.transactionSerials.push({ transaction_id: 'tx-rein', serial_id: `serial-${n}`, is_pending: false });
  }
  const stage = receivedItemGroups(data)[0].stages[0];
  assert.equal(stage.quantity, 4);
  assert.deepEqual(stage.serials.map(value => [value.entryId, value.inventorySerialId]),
    [['entry-3', 'serial-3'], ['entry-4', 'serial-4'], ['entry-5', 'serial-5'], ['entry-6', 'serial-6']]);
});

test('unposted arrival routes to normal posting; nonserial reversal keeps receipt and quantity identity', () => {
  const normal = snapshot();
  normal.receipts = []; normal.receiptSerials = []; normal.inventorySerials = []; normal.transactionSerials = []; normal.transactions = [];
  normal.lines[0].resolution_state = 'STAGED'; normal.lines[0].receipt_id = null;
  for (const entry of normal.observations) { entry.inventory_serial_id = null; entry.active_receipt_id = null; }
  const stage = receivedItemGroups(normal)[0].stages[0];
  assert.equal(stage.kind, 'NORMAL');
  assert.deepEqual(receivedPostCommand(stage, 'request', 3, ['entry-0', 'entry-1', 'entry-2'], at), {
    name: 'post_receiving_arrival_line', args: { p_request_id: 'request', p_line_id: 'line', p_quantity: 3,
      p_entry_ids: ['entry-0', 'entry-1', 'entry-2'], p_posting_date: null },
  });
  const plain = snapshot(false);
  const history = receivingHistory(plain).find(value => value.receiptId === 'in');
  assert.equal(history.reversibleQuantity, 10);
  assert.equal(history.serials.length, 0);
  assert.equal(reverseReceiptPayload(history, 'request', 4, [], at, '調整').p_receipt_id, 'in');
  reverse(plain, 4);
  const reentry = receivedItemGroups(plain)[0].stages[0];
  assert.equal(reentry.quantity, 4);
  assert.deepEqual(receivedPostCommand(reentry, 'request', 4, [], reentryAt), {
    name: 'reenter_receiving_inventory', args: { p_request_id: 'request', p_reversal_receipt_id: 'reversal', p_quantity: 4,
      p_entry_ids: [], p_received_at: new Date(reentryAt).toISOString(), p_notes: null },
  });
});

test('receiving adapter dispatches both canonical RPCs from projected stage', async () => {
  const calls = [];
  const api = createReceivingV6Api({ rpc: async (name, args) => { calls.push({ name, args }); return { data: {}, error: null }; } });
  const normal = snapshot(); normal.receipts = []; normal.transactions = [];
  normal.lines[0].resolution_state = 'STAGED';
  for (const entry of normal.observations) { entry.inventory_serial_id = null; entry.active_receipt_id = null; }
  const normalStage = receivedItemGroups(normal)[0].stages[0];
  await api.postReceivedToInventory({ stage: normalStage, requestId: 'one', quantity: 1, entryIds: ['entry-0'], receivedAt: at });
  const reversed = snapshot(); reverse(reversed, 1);
  await api.postReceivedToInventory({ stage: receivedItemGroups(reversed)[0].stages[0], requestId: 'two', quantity: 1, entryIds: ['entry-0'], receivedAt: at });
  assert.deepEqual(calls.map(call => call.name), ['post_receiving_arrival_line', 'reenter_receiving_inventory']);
});

test('receiving adapter reads receipt links, current serials, and transaction serial provenance', async () => {
  const data = snapshot();
  const tables = {
    projects: data.projects, inventory_items: data.items, project_materials: data.materials,
    se_supply_records: data.supplies, project_material_batches: data.batches,
    receiving_arrivals: data.arrivals, receiving_arrival_lines: data.lines,
    receiving_serial_entries: data.observations, receiving_arrival_matches: data.matches,
    receiving_arrival_match_serials: data.matchObservations, material_receipts: data.receipts,
    inventory_transactions: data.transactions, inventory_monthly_closings: data.closings,
    team_members: data.actors, material_receipt_serials: data.receiptSerials,
    inventory_serials: data.inventorySerials, inventory_transaction_serials: data.transactionSerials,
  };
  const client = {
    from(table) {
      let values = tables[table] || [], start = 0, end = 499;
      const query = {
        select() { return query; }, order() { return query; },
        eq(column, value) { values = values.filter(row => row[column] === value); return query; },
        in(column, ids) { values = values.filter(row => ids.includes(row[column])); return query; },
        range(first, last) { start = first; end = last; return query; },
        then(resolve) { return Promise.resolve({ data: values.slice(start, end + 1), error: null }).then(resolve); },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'get_receiving_handoff_scope');
      return { data: { receipt_id: args.p_receipt_id, available: 7, allocations: [] }, error: null };
    },
  };
  const loaded = await createReceivingV6Api(client).load();
  assert.equal(loaded.receiptSerials.length, 7);
  assert.equal(loaded.inventorySerials.length, 7);
  assert.equal(loaded.transactionSerials.length, 7);
  assert.equal(receivingHistory(loaded).find(row => row.receiptId === 'in').reversibleSerials.length, 7);
});
