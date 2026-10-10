const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const {
  actionLabel, activityDifferences, parseNestedJson, targetPresentation, targetTypeLabel,
} = load(path.join(__dirname, 'activity-presentation.ts'));

const row = (extra = {}) => ({
  action: 'UPDATE_TASK', target_type: 'ScheduleTask', target_id: '123e4567-e89b-12d3-a456-426614174000',
  target_label: '', project_name: '新竹香山', before_value: null, after_value: null,
  changes: null, ...extra,
});

test('actual schedule, inventory, project, receiving and other actions have Chinese labels', () => {
  assert.equal(actionLabel('CREATE_TASK'), '新增排程');
  assert.equal(actionLabel('COMPLETE_TASK'), '完成排程');
  assert.equal(actionLabel('CREATE_TRANSACTION'), '新增庫存交易');
  assert.equal(actionLabel('VOID_TRANSACTION'), '作廢庫存交易');
  assert.equal(actionLabel('WORKFLOW_STATUS_CHANGED'), '修改工項狀態');
  assert.equal(actionLabel('ARRIVAL_STAGED'), '暫存到貨');
  assert.equal(actionLabel('RECEIVING_INVENTORY'), '確認收貨入庫');
  assert.equal(actionLabel('REGISTER_MAINTENANCE_EQUIPMENT'), '登錄維修設備');
  assert.equal(actionLabel('UNSEEN_ACTION'), 'UNSEEN_ACTION');
});

test('target uses an existing name, ignores action-code labels, and preserves the original ID', () => {
  const schedule = targetPresentation(row({ changes: { after: { title: '現勘任務' } } }));
  assert.deepEqual(schedule, { type: '排程任務', name: '現勘任務', id: row().target_id });
  const inventory = targetPresentation(row({
    action: 'CREATE_TRANSACTION', target_type: 'INVENTORY_TRANSACTION',
    target_label: 'CREATE_TRANSACTION', project_name: null,
  }));
  assert.deepEqual(inventory, { type: '庫存交易', name: null, id: row().target_id });
  assert.equal(targetTypeLabel('PROJECT_MILESTONE'), '案場工項');
});

test('schedule before and after snapshots show only changed Chinese fields', () => {
  const differences = activityDifferences(row({
    before_value: '{"status":"已排程","task_date":"2026-10-12","site":"新竹香山"}',
    after_value: '{"status":"完成","task_date":"2026-10-15","site":"新竹香山"}',
  }));
  assert.deepEqual(differences, [
    { field: 'status', label: '狀態', before: '已排程', after: '完成' },
    { field: 'task_date', label: '排程日期', before: '2026/10/12', after: '2026/10/15' },
  ]);
});

test('inventory and project snapshots turn codes into readable values', () => {
  assert.deepEqual(activityDifferences(row({
    action: 'VOID_TRANSACTION', target_type: 'INVENTORY_TRANSACTION',
    changes: { before: { is_voided: false, quantity: 1 }, after: { is_voided: true, quantity: 1 } },
  })), [{ field: 'is_voided', label: '是否作廢', before: '否', after: '是' }]);
  assert.deepEqual(activityDifferences(row({
    action: 'WORKFLOW_STATUS_CHANGED', target_type: 'PROJECT_MILESTONE',
    changes: { before: { status: 'IN_PROGRESS' }, after: { status: 'COMPLETED' } },
  })), [{ field: 'status', label: '狀態', before: '進行中', after: '完成' }]);
});

test('nested JSON strings parse safely and malformed content stays available', () => {
  const nested = row({
    changes: { before: JSON.stringify(JSON.stringify({ task_date: '2026-10-12' })),
      after: JSON.stringify({ task_date: '2026-10-15' }) },
  });
  assert.equal(activityDifferences(nested)[0].after, '2026/10/15');
  assert.equal(parseNestedJson('{bad json'), '{bad json');
  assert.deepEqual(activityDifferences(row({ before_value: '{bad json', after_value: '完成' })),
    [{ field: 'value', label: '內容', before: '{bad json', after: '完成' }]);
});
