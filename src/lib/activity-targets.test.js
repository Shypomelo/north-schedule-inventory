const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const file = path.join(__dirname, 'activity-targets.ts');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (extra = {}) => ({
  action: 'CREATE_TASK', target_type: 'ScheduleTask', target_id: id(1),
  target_label: '', project_id: null, project_name: null, changes: null, ...extra,
});
const tables = {
  projects: [
    { id: id(10), project_name: '同名案場' },
    { id: id(11), project_name: '同名案場' },
  ],
  schedule_tasks: [
    { id: id(1), title: '初次現勘', task_type: '現勘', project_id: id(10), project_name: '同名案場' },
    { id: id(2), title: '完工驗收', task_type: '驗收', project_id: id(11), project_name: '同名案場' },
  ],
  inventory_transactions: [
    { id: id(30), item_id: id(40), quantity: 2, unit: '台', transaction_type: 'OUT', project_id: null, project_name: null },
    { id: id(31), item_id: id(41), quantity: 5, unit: '台', transaction_type: 'IN', project_id: null, project_name: null },
  ],
  inventory_items: [
    { id: id(40), name: '逆變器 SE82.8K', unit: '台' },
    { id: id(41), name: '逆變器 SE82.8K', unit: '台' },
  ],
  project_milestones: [{ id: id(50), label: '初次現勘', project_id: id(10) }],
  project_materials: [{ id: id(60), project_id: id(10), item_name: '支架', specification: '鋁製', quantity: 3, unit: '組', inventory_item_id: null }],
  se_supply_records: [{ id: id(61), project_id: id(11), project_name: '同名案場', new_model: 'SE82.8K', old_model: null, quantity: 1, unit: '台', inventory_item_id: id(41) }],
  receiving_arrivals: [], receiving_arrival_lines: [], receiving_arrival_matches: [],
  material_receipts: [{ id: id(70), project_material_id: id(60), se_supply_record_id: null, inventory_transaction_id: null, arrival_line_id: null, quantity_received: 3 }],
};
const calls = [];
const fakeSupabase = {
  from(table) {
    return {
      select() {
        return {
          in(field, keys) {
            calls.push({ table, field, keys });
            return Promise.resolve({ data: (tables[table] || []).filter(entry => keys.includes(entry[field])), error: null });
          },
        };
      },
    };
  },
};
const { loadActivityTargetData, resolveBusinessTarget } = load(file, {
  './db/supabaseClient': { supabase: fakeSupabase },
});

test('schedule and milestone use exact IDs even when project names repeat', async () => {
  const rows = [
    row({ target_id: id(1), project_id: id(10) }),
    row({ target_id: id(2), project_id: id(11) }),
    row({ action: 'WORKFLOW_STATUS_CHANGED', target_type: 'PROJECT_MILESTONE', target_id: id(50), project_id: id(10), target_label: '初次現勘' }),
  ];
  const data = await loadActivityTargetData(rows);
  assert.deepEqual(resolveBusinessTarget(rows[0], data).lines, ['同名案場', '初次現勘']);
  assert.deepEqual(resolveBusinessTarget(rows[1], data).lines, ['同名案場', '完工驗收']);
  assert.deepEqual(resolveBusinessTarget(rows[2], data).lines, ['同名案場', '初次現勘']);
  assert.equal(calls.filter(call => call.table === 'schedule_tasks').length, 1);
});

test('inventory item is matched by ID and transaction quantity, not by model text', async () => {
  const rows = [
    row({ action: 'CREATE_TRANSACTION', target_type: 'INVENTORY_TRANSACTION', target_id: id(30), target_label: 'CREATE_TRANSACTION' }),
    row({ action: 'CREATE_TRANSACTION', target_type: 'INVENTORY_TRANSACTION', target_id: id(31), target_label: 'CREATE_TRANSACTION' }),
  ];
  const data = await loadActivityTargetData(rows);
  assert.deepEqual(resolveBusinessTarget(rows[0], data).lines, ['逆變器 SE82.8K', '出庫 2 台']);
  assert.deepEqual(resolveBusinessTarget(rows[1], data).lines, ['逆變器 SE82.8K', '入庫 5 台']);
  assert.equal(calls.filter(call => call.table === 'inventory_transactions').length >= 1, true);
});

test('receiving receipt follows its material ID to the exact project and item', async () => {
  const receipt = row({
    action: 'RECEIVING_INVENTORY', target_type: 'INVENTORY_TRANSACTION',
    target_id: id(70), target_label: 'RECEIVING_INVENTORY',
    changes: { after: { id: id(70), project_material_id: id(60), quantity_received: 3 } },
  });
  const data = await loadActivityTargetData([receipt]);
  assert.deepEqual(resolveBusinessTarget(receipt, data).lines, ['同名案場', '支架']);
});

test('missing or conflicting links degrade without guessing a name', async () => {
  const missing = row({ action: 'ARRIVAL_CREATED', target_type: 'INVENTORY_TRANSACTION', target_id: id(99), target_label: 'ARRIVAL_CREATED' });
  const conflict = row({
    action: 'RECEIVING_INVENTORY', target_type: 'INVENTORY_TRANSACTION', target_id: id(70),
    project_id: id(11), changes: { after: { project_material_id: id(60) } },
  });
  const data = await loadActivityTargetData([missing, conflict]);
  assert.deepEqual(resolveBusinessTarget(missing, data).lines, ['無法辨識案場', '無法辨識對象']);
  assert.deepEqual(resolveBusinessTarget(conflict, data).lines, ['無法辨識案場', '支架']);
});

test('a schedule without a task title does not present its generic task type as a name', async () => {
  const untitled = row({ target_id: id(3), project_name: '同名案場', changes: { after: { task_type: '維修', title: null } } });
  const data = await loadActivityTargetData([untitled]);
  assert.deepEqual(resolveBusinessTarget(untitled, data).lines, ['同名案場', '無法辨識對象']);
});

test('receiving route uses model and project names embedded in its actual allocation snapshot', async () => {
  const routed = row({
    action: 'ROUTE_RECEIVING', target_type: 'INVENTORY_TRANSACTION', target_id: id(88),
    changes: { after: { allocations: [{ id: id(61), new_model: 'SE82.8K', project_id: id(11), project_name: '同名案場' }] } },
  });
  const data = await loadActivityTargetData([routed]);
  assert.deepEqual(resolveBusinessTarget(routed, data).lines, ['同名案場', 'SE82.8K']);
});

test('other records keep their recorded business target name', async () => {
  const todo = row({ action: 'UPDATE_TODO', target_type: 'Todo', target_id: id(80), target_label: '待安排設備更換' });
  const data = await loadActivityTargetData([todo]);
  assert.deepEqual(resolveBusinessTarget(todo, data).lines, ['待安排設備更換']);
});
