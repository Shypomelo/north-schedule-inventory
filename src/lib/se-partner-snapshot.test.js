const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { createSEPartnerSnapshotApi } = load(path.resolve(__dirname, 'db/se-partner.ts'));

function client(tables) {
  const calls = [];
  return { calls, from(table) {
    calls.push(table);
    return { select() { return this; }, order() { return this; },
      async range(start, end) { return { data: (tables[table] || []).slice(start, end + 1), error: null }; } };
  } };
}

test('empty snapshot has no orders and only reads Supabase SE tables', async () => {
  const db = client({});
  const rows = await createSEPartnerSnapshotApi(db).load();
  assert.deepEqual(rows, []);
  assert.deepEqual(db.calls, ['se_orders', 'se_order_items', 'se_order_item_links', 'se_order_item_serials']);
});

test('snapshot preserves raw duplicate rows and maps only active links', async () => {
  const raw = [{ name: 'MODEL', qty: 1 }, { name: 'MODEL', qty: 2 }];
  const db = client({
    se_orders: [{ order_no: 'SO-1', case_numbers: ['7000001'], site_name: 'Site', raw_items: raw,
      status: 'shipped', status_label: '已出貨', carrier: '', tracking_nos: ['TRACK-1'],
      created_on: '2026-10-02', api_updated_at: null, scope_state: 'NORTH', project_id: 'P',
      removed_at: null, removed_reason: null }],
    se_order_items: [{ id: 'I', order_no: 'SO-1', model_name: 'MODEL', quantity: 3, is_active: true }],
    se_order_item_links: [{ id: 'L1', item_id: 'I', source_type: 'SE_SUPPLY', source_id: 'S',
      project_id: 'P', quantity: 2, cancelled_at: null }, { id: 'L2', item_id: 'I',
      source_type: 'SE_SUPPLY', source_id: 'OLD', project_id: 'P', quantity: 1,
      cancelled_at: '2026-10-03T00:00:00Z' }],
    se_order_item_serials: [],
  });
  const [view] = await createSEPartnerSnapshotApi(db).load();
  assert.deepEqual(view.order.items, raw);
  assert.equal(view.order.updatedAt, '');
  assert.equal(view.items[0].quantity, 3);
  assert.deepEqual(view.items[0].links.map(link => link.sourceId), ['S']);
  assert.deepEqual(view.items[0].serials, []);
});
