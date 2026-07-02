export type UserRole = 'ADMIN' | 'ENGINEER' | 'VIEWER';
export type TaskStatus = '未開始' | '進行中' | '已完成' | '取消' | '' | '改期' | '完成';
export type TodoStatus = '待安排' | '已排程' | '已完成' | '取消';
export type TransactionType = 'IN' | 'OUT' | 'RETURN' | 'ADJUST';
export type StockCategory = 'CONSTRUCTION' | 'MAINTENANCE' | 'VENDOR_SPARE';
export type SerialStatus = '在庫' | '已出庫' | '已使用' | '已退回' | '待補' | '報廢';

export type ActivityActionType = 'CREATE_TASK' | 'UPDATE_TASK' | 'COMPLETE_TASK' | 'RESCHEDULE_TASK' | 'DELETE_TASK' | 'CREATE_TODO' | 'TODO_TO_TASK' | 'TASK_TO_TODO' | 'UPDATE_PROJECT' | 'COMPLETE_PROJECT' | 'CREATE_TRANSACTION' | 'UPDATE_TRANSACTION' | 'VOID_TRANSACTION';

export interface ActivityLog {
  id: string;
  actor_user_id: string;
  actor_name: string;
  action_type: ActivityActionType;
  target_type: string;
  target_id: string;
  target_label: string;
  project_id: string | null;
  project_name: string | null;
  before_value: string | null;
  after_value: string | null;
  message: string | null;
  created_at: string;
}

export interface SESupplyRecord {
  id: string;
  project_name: string | null;
  old_model: string | null;
  faulty_serial: string | null;
  fault_reason: string | null;
  new_serial: string | null;
  receive_method: string | null;
  receive_date: string | null; // YYYY-MM-DD
  replace_date: string | null; // YYYY-MM-DD
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  name: string;
  short_name: string;
  email: string;
  role: UserRole;
  category?: 'ENGINEERING' | 'OTHER';
  is_active: boolean;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  short_name: string | null;
  address: string | null;
  owner_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  is_active: boolean; // Keep this for soft delete or general status
  created_at: string;
  updated_at: string;
  
  // A. 基本資料 (Basic Info)
  capacity: string | null;
  region: string | null;
  project_type: string | null;
  status: string | null;
  manager: string | null;

  // B. 聯絡資料 (Contact Info)
  owner_phone: string | null;
  data_source: string | null;

  // C. 保固 / 維運資料 (Warranty / Maintenance Info)
  warranty_status: string | null;
  completion_date: string | null;
  warranty_years: string | null;
  warranty_end_date: string | null;
  has_maintenance_contract: string | null;
  maintenance_start_date: string | null;
  maintenance_end_date: string | null;
  maintenance_notes: string | null;

  // D. 設備資料 (Equipment Info)
  inverter_brand: string | null;
  inverter_warranty: string | null;
  monitoring_system: string | null;
  module_mounting_type: string | null;

  // E. 巡檢提醒設定，先預留 (Inspection settings)
  last_inspection_date: string | null;
  inspection_cycle_months: string | null;
  next_inspection_date: string | null;
  inspection_reminder_days: string | null;
  
  // F. 進行中案場專用 (Active Project Fields)
  project_code: string | null; // 案場代碼
  report_base_date?: string | null; // 週回報表基準日
  report_section?: string | null; // 手動分區
  
  // Legacy fields (kept for backward compatibility with weekly report)
  bracket_status?: string | null;
  power_status?: string | null;
  inspection_status?: string | null;
  inspection_expected_date?: string | null;
  inspection_completion_date?: string | null;
  meter_status?: string | null;
  meter_expected_date?: string | null;
  meter_completion_date?: string | null;
  roof_status?: string | null;
  start_date?: string | null;
  
  // 支架施工 (Racking)
  racking_contractor_id: string | null;
  racking_expected_start_date: string | null;
  racking_completion_date: string | null;
  racking_status: string | null;
  racking_notes: string | null;

  // 電力施工 (Electrical)
  electrical_contractor_id: string | null;
  electrical_expected_start_date: string | null;
  electrical_completion_date: string | null;
  electrical_status: string | null;
  electrical_notes: string | null;

  // 鋼構施工 (Steel)
  steel_contractor_id: string | null;
  steel_expected_start_date: string | null;
  steel_completion_date: string | null;
  steel_status: string | null;
  steel_notes: string | null;

  // 新設頂蓋施工 (Roof Cover)
  roof_cover_contractor_id: string | null;
  roof_cover_expected_start_date: string | null;
  roof_cover_completion_date: string | null;
  roof_cover_status: string | null;
  roof_cover_notes: string | null;

  // 挖地 / 土木施工 (Civil)
  civil_contractor_id: string | null;
  civil_expected_start_date: string | null;
  civil_completion_date: string | null;
  civil_status: string | null;
  civil_notes: string | null;

  // 其他施工 (Other)
  other_contractor_id: string | null;
  other_expected_start_date: string | null;
  other_completion_date: string | null;
  other_status: string | null;
  other_notes: string | null;
}

export type ContractorType = 'racking' | 'electrical' | 'steel' | 'roof_cover' | 'civil' | 'other';

export interface Contractor {
  id: string;
  name: string;
  contractor_type: ContractorType;
  contact_person: string | null;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScheduleTask {
  id: string;
  task_type: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  address: string | null;
  task_date: string; // YYYY-MM-DD
  start_time: string | null; // HH:mm
  end_time: string | null; // HH:mm
  is_all_day: boolean;
  is_tentative: boolean;
  status: TaskStatus;
  main_assignee_id: string | null;
  description: string | null;
  google_calendar_id: string | null;
  google_event_id: string | null;
  google_sync_status: 'pending' | 'synced' | 'failed' | null;
  google_sync_error: string | null;
  last_synced_at: string | null;
  created_by: string | null;
  source_todo_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleTaskMember {
  id: string;
  task_id: string;
  user_id: string;
  created_at: string;
}

export interface Todo {
  id: string;
  title: string;
  content: string | null;
  project_id: string | null;
  task_type: string | null;
  status: TodoStatus;
  created_by: string | null;
  converted_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryItem {
  id: string;
  code: string;
  category: string;
  item_category: string | null;
  name: string;
  source_type: string | null;
  unit: string;
  opening_quantity: number;
  low_stock_threshold: number;
  requires_serial: boolean;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InventoryTransaction {
  id: string;
  item_id: string;
  transaction_type: TransactionType;
  transaction_date: string; // YYYY-MM-DD
  quantity: number;
  unit: string | null;
  project_id: string | null;
  project_name: string | null;
  handler: string | null;
  source: string | null;
  notes: string | null;
  pending_serial_count?: number;
  is_voided?: boolean;
  voided_reason?: string | null;
  voided_by?: string | null;
  voided_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventorySerial {
  id: string;
  item_id: string;
  batch_id: string | null;
  serial_number: string;
  status: SerialStatus;
  project_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryTransactionSerial {
  id: string;
  transaction_id: string;
  serial_id: string | null;
  serial_no: string | null;
  is_pending: boolean;
  created_at: string;
}

export interface InventoryMonthlyClosing {
  id: string;
  year: string;
  month: string;
  closed_at: string;
  closed_by: string;
  status: string; // 'CLOSED'
  notes: string | null;
}

export interface InventoryMonthlyClosingItem {
  id: string;
  closing_id: string;
  inventory_item_id: string;
  stock_category: string;
  source: string;
  item_name: string;
  item_type: string;
  unit: string;
  opening_quantity: number;
  monthly_in: number;
  monthly_out: number;
  monthly_return: number;
  monthly_adjust: number;
  closing_quantity: number;
  usage_quantity: number; // typically same as monthly_out
  status: string;
  notes: string | null;
}

export interface InventoryBatch {
  id: string;
  batch_number: string; // IN-YYYYMMDD-00X
  item_id: string;
  in_date: string;
  source: string | null;
  quantity: number;
  unit: string | null;
  handler: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
