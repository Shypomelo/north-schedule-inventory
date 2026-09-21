import { inventoryWriteError } from './inventory-atomic';
export type EquipmentSource = 'INVENTORY' | 'SE_SUPPLY' | 'BOTH';
export const equipmentSourceLabel: Record<EquipmentSource, string> = { INVENTORY: '庫存', SE_SUPPLY: 'SE供貨', BOTH: '庫存＋SE供貨' };
export interface EquipmentCandidate {
  key: string; inventory_serial_id: string | null; inventory_item_id: string | null; se_supply_record_id: string | null;
  source_type: EquipmentSource; serial: string; model: string; item_name: string | null; project_name: string | null;
  eligible: boolean; conflict: string | null; version: string;
  cross_project?: boolean; original_project_name?: string; maintenance_project_name?: string; current_record?: boolean;
}
export interface MaintenanceEquipmentRecord {
  id: string; request_id: string; project_id: string; schedule_task_id: string; source_type: EquipmentSource;
  inventory_item_id: string | null; inventory_serial_id: string | null; inventory_transaction_id: string | null;
  se_supply_record_id: string | null; model_snapshot: string; serial_snapshot: string; replaced_at: string;
  notes: string | null; created_by: string; created_at: string;
  revision: number; updated_at: string; updated_by: string | null;
}
export function groupMaintenanceEquipmentRecords(rows: MaintenanceEquipmentRecord[]) {
  const groups = new Map<string, MaintenanceEquipmentRecord[]>();
  for (const row of rows) {
    // request_id belongs to a single device, not a batch. Group presentation only.
    const key = JSON.stringify([row.model_snapshot, new Date(row.replaced_at).toISOString(), row.source_type]);
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  return Array.from(groups, ([key, records]) => ({ key, records }));
}
export function filterEquipmentCandidates(rows: EquipmentCandidate[], input: string) {
  const query = input.trim().toLocaleLowerCase();
  return rows.filter(row => [row.serial, row.model, row.item_name].some(value => value?.toLocaleLowerCase().includes(query)));
}
type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
export function createMaintenanceEquipmentApi(client: RpcClient) {
  return {
    async search(taskId: string, recordId?: string): Promise<EquipmentCandidate[]> {
      const { data, error } = await client.rpc(recordId ? 'search_maintenance_equipment_for_edit' : 'search_maintenance_equipment', recordId ? { p_record_id: recordId } : { p_schedule_task_id: taskId });
      if (error) throw inventoryWriteError(error);
      if (!Array.isArray(data)) throw new Error('設備來源載入失敗，請重試。');
      return data as EquipmentCandidate[];
    },
    async register(input: { requestId: string; taskId: string; candidate: EquipmentCandidate; replacedAt: string; notes: string; confirmCrossProject?: boolean; record?: MaintenanceEquipmentRecord }): Promise<MaintenanceEquipmentRecord> {
      if (!input.candidate.eligible) throw new Error('來源需確認，不能直接登錄。');
      if (input.candidate.cross_project && !input.confirmCrossProject) throw new Error('請確認跨案場使用');
      const { data, error } = await client.rpc(input.record ? 'correct_maintenance_equipment_replacement' : 'register_maintenance_equipment_replacement', {
        p_request_id: input.requestId,
        ...(input.record ? { p_record_id: input.record.id, p_expected_revision: input.record.revision } : { p_schedule_task_id: input.taskId }),
        p_inventory_serial_id: input.candidate.inventory_serial_id, p_se_supply_record_id: input.candidate.se_supply_record_id,
        p_replaced_at: input.replacedAt, p_notes: input.notes, p_version: input.candidate.version,
        p_confirm_cross_project: !!input.confirmCrossProject,
      });
      if (error) throw inventoryWriteError(error);
      if (!data) throw new Error('未取得登錄結果，請保留視窗重試或重新載入查看。');
      return data as MaintenanceEquipmentRecord;
    },
  };
}
