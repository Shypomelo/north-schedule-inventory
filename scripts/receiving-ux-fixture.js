// Isolated in-memory transport for the Receiving UX browser check.
const at = new Date().toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();
let seq = 0;
const id = () => `ux-${++seq}`;
const serial = index => `UXSN${String(index).padStart(4, '0')}-AA`;
export const store = { calls: [], snapshot: {
  projects: [{ id: 'active', name: '進行中案場', status: '進行中', deleted_at: null },
    { id: 'completed', name: '已完工案場', status: '已完工', deleted_at: null },
    { id: 'closed', name: '已結案案場', status: '已結案', deleted_at: null },
    { id: 'deleted', name: '已刪除案場', status: '進行中', deleted_at: at }],
  items: [{ id: 'serial', code: 'SE4000H', name: '逆變器', unit: '台', requires_serial: true, is_active: true },
    { id: 'serial2', code: 'P401', name: '設備', unit: '台', requires_serial: true, is_active: true },
    { id: 'plain', code: 'CABLE', name: '線材', unit: 'pcs', requires_serial: false, is_active: true }],
  materials: [], supplies: [], batches: [],
  arrivals: [{ id: 'box1', actual_received_at: at, project_id: 'completed', batch_kind: 'BOX', batch_position: 1,
    created_at: at, created_by: 'actor', voided_at: null },
  { id: 'box2', actual_received_at: at, project_id: 'completed', batch_kind: 'BOX', batch_position: 2,
    created_at: at, created_by: 'actor', voided_at: null },
  { id: 'oldbox', actual_received_at: yesterday, project_id: 'closed', batch_kind: 'BOX', batch_position: 1,
    created_at: yesterday, created_by: 'actor', voided_at: null }],
  lines: [], observations: [], matches: [], matchObservations: [], receipts: [], fulfilment: {},
  scopes: {}, scopeErrors: {}, transactions: [], closings: [], actors: [{ id: 'actor', name: '測試人員' }],
  receiptSerials: [], inventorySerials: [], transactionSerials: [], cancellations: [],
} };
for (let index = 1; index <= 8; index++) {
  store.snapshot.lines.push({ id: `unknown${index}`, arrival_id: 'box1', inventory_item_id: null,
    quantity: 1, unit: null, resolution_state: 'UNRESOLVED', receipt_id: null });
  store.snapshot.observations.push({ id: `entry${index}`, arrival_line_id: `unknown${index}`,
    raw_serial: serial(index), normalized_serial: serial(index), inventory_item_id: null,
    inventory_serial_id: null, active_receipt_id: null, retired_at: null });
}
store.snapshot.lines.push({ id: 'known1', arrival_id: 'box2', inventory_item_id: 'serial2',
  quantity: 2, unit: '台', resolution_state: 'STAGED', receipt_id: null },
{ id: 'yesterday', arrival_id: 'oldbox', inventory_item_id: 'plain',
  quantity: 2, unit: 'pcs', resolution_state: 'STAGED', receipt_id: null });
for (let index = 9; index <= 10; index++) store.snapshot.observations.push({ id: `entry${index}`,
  arrival_line_id: 'known1', raw_serial: serial(index), normalized_serial: serial(index), inventory_item_id: 'serial2',
  inventory_serial_id: null, active_receipt_id: null, retired_at: null });
export const supabase = {};
export const useUser = () => ({ currentUser: { id: 'actor', name: '測試人員', role: 'ADMIN' } });
export const createReceivingV6Api = () => ({
  load: async () => structuredClone(store.snapshot),
  lookup: async () => ({ result_type: 'no_match', candidates: [] }),
  lookupBatch: async raws => raws.map(() => ({ result_type: 'no_match', candidates: [] })),
  activeArrivalSerials: async () => [],
  createItem: async args => {
    const item = { id: id(), code: args.p_identity_key, name: args.p_identity_key, unit: args.p_unit,
      requires_serial: args.p_requires_serial, is_active: true };
    store.snapshot.items.push(item); return { item, created: true };
  },
  createPendingBatch: async args => {
    store.calls.push({ name: 'createPendingBatch', args });
    const result = args.p_items.map(spec => {
      const item = store.snapshot.items.find(value => value.id === spec.item_id);
      const row = { id: id(), receiving_only: true, inventory_item_id: item.id, project_id: args.p_project_id,
        new_model: item.code, quantity: spec.quantity, unit: item.unit, expected_delivery_at: spec.expected_at,
        notes: args.p_notes, updated_at: at };
      store.snapshot.supplies.push(row);
      store.snapshot.fulfilment[`SE_SUPPLY:${row.id}`] = { expected: spec.quantity, fulfilled: 0,
        remaining: spec.quantity, active: true, remaining_status: 'ACTIVE', cancellation: null };
      for (const raw of spec.serials) store.snapshot.observations.push({ id: id(), se_supply_record_id: row.id,
        normalized_serial: raw, raw_serial: raw, inventory_item_id: item.id, retired_at: null, active_receipt_id: null });
      return row;
    });
    return structuredClone(result);
  },
  createBatches: async args => {
    store.calls.push({ name: 'createBatches', args });
    const results = args.p_batches.map((batch, index) => {
      const arrival = { id: id(), actual_received_at: args.p_actual_received_at, project_id: args.p_project_id,
        batch_kind: batch.kind, batch_position: index + 1, created_at: at, created_by: 'actor', voided_at: null };
      store.snapshot.arrivals.push(arrival);
      const lines = batch.lines.map(spec => {
        const item = store.snapshot.items.find(value => value.id === spec.inventory_item_id);
        const line = { id: id(), arrival_id: arrival.id, inventory_item_id: item?.id || null,
          quantity: spec.quantity, unit: item?.unit || null, resolution_state: item ? 'STAGED' : 'UNRESOLVED', receipt_id: null };
        store.snapshot.lines.push(line);
        for (const raw of spec.raw_serials || []) store.snapshot.observations.push({ id: id(), arrival_line_id: line.id,
          normalized_serial: raw, raw_serial: raw, inventory_item_id: item?.id || null,
          inventory_serial_id: null, active_receipt_id: null, retired_at: null });
        return line;
      });
      return { arrival, lines, matches: [] };
    });
    return structuredClone(results);
  },
  completeBatch: async args => {
    store.calls.push({ name: 'completeBatch', args });
    const item = store.snapshot.items.find(value => value.id === args.p_item_id);
    return args.p_line_ids.map(lineId => {
      const line = store.snapshot.lines.find(value => value.id === lineId);
      line.inventory_item_id = item.id; line.unit = item.unit; line.resolution_state = 'STAGED';
      for (const entry of store.snapshot.observations.filter(value => value.arrival_line_id === lineId)) entry.inventory_item_id = item.id;
      return structuredClone(line);
    });
  },
  routeStaged: async args => { store.calls.push({ name: 'routeStaged', args }); return {}; },
  postReceivedToInventory: async args => { store.calls.push({ name: 'postReceivedToInventory', args }); return {}; },
  cancelPhysicalStage: async args => { store.calls.push({ name: 'cancelPhysicalStage', args }); return {}; },
  projectRequirements: async () => [],
});
