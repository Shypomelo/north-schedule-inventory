export type ActivityPresentationRow = {
  action: string;
  action_type?: string | null;
  target_type: string;
  target_id: string;
  project_id?: string | null;
  target_label?: string | null;
  project_name?: string | null;
  before_value?: string | null;
  after_value?: string | null;
  changes?: unknown;
  message?: string | null;
  description?: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  CREATE_TASK: '新增排程',
  UPDATE_TASK: '修改排程',
  COMPLETE_TASK: '完成排程',
  DELETE_TASK: '刪除排程',
  DRAG_MOVE_TASK: '拖曳改期',
  RESCHEDULE_TASK: '排程改期',
  ASSIGNEE_CHANGE_TASK: '更換排程負責人',
  CREATE_TRANSACTION: '新增庫存交易',
  VOID_TRANSACTION: '作廢庫存交易',
  REVERSE_IN: '沖銷入庫',
  REENTER_IN: '重新入庫',
  ARRIVAL_CREATED: '登錄到貨',
  ARRIVAL_STAGED: '暫存到貨',
  ARRIVAL_MATCH: '配對到貨',
  ARRIVAL_METADATA: '更正到貨資訊',
  ARRIVAL_FIRST_POST: '首次到貨入庫',
  ARRIVAL_ROUTE_POST: '到貨入庫過帳',
  ROUTE_RECEIVING: '分流收貨',
  DELETE_RECEIVING_PENDING: '撤銷待收貨紀錄',
  RECEIVING_INVENTORY: '確認收貨入庫',
  RESERVE_INVENTORY_FOR_SE: '加入供貨追蹤',
  DELIVER_INVENTORY_TO_PROJECT: '出庫送達案場',
  WORKFLOW_INITIALIZED: '建立案場流程',
  WORKFLOW_STATUS_CHANGED: '修改工項狀態',
  WORKFLOW_PLANNED_DATE_CHANGED: '修改工項預計日期',
  WORKFLOW_REORDERED: '調整工項順序',
  REGISTER_MAINTENANCE_EQUIPMENT: '登錄維修設備',
  CREATE_TODO: '新增待辦',
  UPDATE_TODO: '修改待辦',
};

const TARGET_LABELS: Record<string, string> = {
  ScheduleTask: '排程任務',
  INVENTORY_TRANSACTION: '庫存交易',
  PROJECT_MILESTONE: '案場工項',
  PROJECT_WORKFLOW: '案場流程',
  MaintenanceEquipmentRecord: '維修設備紀錄',
  Todo: '待辦事項',
};

const FIELD_LABELS: Record<string, string> = {
  status: '狀態', site: '案場', project_name: '案場名稱',
  title: '名稱', name: '名稱', item_name: '品項名稱', material_name: '物料名稱',
  task_type: '排程類型', task_date: '排程日期', planned_date: '預計日期',
  actual_date: '實際日期', start_time: '開始時間', end_time: '結束時間',
  notes: '備註', content: '內容', primary_assignee: '主要負責人',
  collaborators: '協作人員', quantity: '數量', quantity_received: '收貨數量',
  transaction_type: '交易類型', transaction_date: '交易日期',
  source: '來源', source_type: '來源類型', handler: '經手人',
  unit: '單位', is_voided: '是否作廢', voided_reason: '作廢原因',
  receive_date: '收貨日期', received_at: '收貨時間',
  actual_received_at: '實際收貨時間', posting_date: '過帳日期',
  receipt_location: '收貨地點', resolution_state: '處理狀態',
  new_model: '新機型', old_model: '舊機型', new_serial: '新序號',
  faulty_serial: '故障序號', fault_reason: '故障原因',
  procurement_status: '採購狀態', expected_delivery_at: '預計到貨時間',
  order: '工項順序', lines: '到貨明細', allocations: '分配明細',
  matches: '配對紀錄', serials: '序號明細',
};

const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: '未開始', IN_PROGRESS: '進行中', COMPLETED: '完成',
  BLOCKED: '受阻', CANCELLED: '取消', PENDING: '待處理',
};
const TRANSACTION_LABELS: Record<string, string> = {
  IN: '入庫', OUT: '出庫', RETURN: '退料', ADJUST: '調整',
  IN_REVERSAL: '入庫沖銷',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TECHNICAL_FIELD = /(^id$|_id$|_ids$|^created_at$|^updated_at$|^version$|^created_by$|^updated_by$)/;

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action;
}

export function targetTypeLabel(targetType: string): string {
  return TARGET_LABELS[targetType] || targetType;
}

export function parseNestedJson(value: unknown): unknown {
  let parsed = value;
  for (let depth = 0; depth < 4 && typeof parsed === 'string'; depth++) {
    const text = parsed.trim();
    if (!/^[\[{"]/.test(text)) break;
    try { parsed = JSON.parse(text); } catch { break; }
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = parseNestedJson(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
}

function sides(row: ActivityPresentationRow): { before: unknown; after: unknown } {
  const changes = record(row.changes);
  return {
    before: parseNestedJson(changes?.before ?? row.before_value ?? null),
    after: parseNestedJson(changes?.after ?? row.after_value ?? null),
  };
}

function meaningfulName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && !UUID.test(value.trim())
    ? value.trim() : null;
}

export function targetPresentation(row: ActivityPresentationRow): { type: string; name: string | null; id: string } {
  const type = targetTypeLabel(row.target_type);
  const { before, after } = sides(row);
  const afterRecord = record(after);
  const beforeRecord = record(before);
  const label = meaningfulName(row.target_label);
  const labelIsCode = label === row.action || label === row.action_type || label === row.target_type;
  const fields = ['title', 'task_name', 'material_name', 'item_name', 'name'];
  const snapshotName = fields.map(field => meaningfulName(afterRecord?.[field]) || meaningfulName(beforeRecord?.[field])).find(Boolean);
  const name = (!labelIsCode && label) || snapshotName || meaningfulName(row.project_name) || null;
  return { type, name, id: row.target_id };
}

function valueText(value: unknown, field: string): string {
  const parsed = parseNestedJson(value);
  if (parsed === null || parsed === undefined || parsed === '') return '—';
  if (typeof parsed === 'boolean') return parsed ? '是' : '否';
  if (Array.isArray(parsed)) return parsed.length ? `${parsed.length} 筆` : '—';
  if (typeof parsed === 'object') return '資料已更新';
  if (typeof parsed === 'number') return String(parsed);
  const text = String(parsed);
  if (field === 'status') return STATUS_LABELS[text] || text;
  if (field === 'transaction_type') return TRANSACTION_LABELS[text] || text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll('-', '/');
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const time = new Date(text);
    if (!Number.isNaN(time.getTime())) return time.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  }
  return UUID.test(text) ? `ID ${text.slice(0, 8)}…` : text;
}

export type ActivityDifference = { field: string; label: string; before: string; after: string };

export function activityDifferences(row: ActivityPresentationRow): ActivityDifference[] {
  const { before, after } = sides(row);
  const beforeRecord = record(before);
  const afterRecord = record(after);
  if (!beforeRecord && !afterRecord) {
    if (before === null && after === null) return [];
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ field: 'value', label: '內容', before: valueText(before, 'value'), after: valueText(after, 'value') }];
  }
  const keys = Array.from(new Set([...Object.keys(beforeRecord || {}), ...Object.keys(afterRecord || {})]));
  return keys.filter(field => {
    if (TECHNICAL_FIELD.test(field)) return false;
    const oldValue = parseNestedJson(beforeRecord?.[field]);
    const newValue = parseNestedJson(afterRecord?.[field]);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return false;
    // Snapshots on creation/deletion can contain many empty and technical fields.
    if ((!beforeRecord || !afterRecord) && !FIELD_LABELS[field]) return false;
    return oldValue != null && oldValue !== '' || newValue != null && newValue !== '';
  }).slice(0, 12).map(field => ({
    field,
    label: FIELD_LABELS[field] || field,
    before: field === 'order' ? '原順序' : valueText(beforeRecord?.[field], field),
    after: field === 'order' ? '已調整' : valueText(afterRecord?.[field], field),
  }));
}

export function activitySummary(row: ActivityPresentationRow): string {
  const message = (row.message || row.description || '').trim();
  return /[\u3400-\u9fff]/.test(message) ? message : '查看異動內容';
}
