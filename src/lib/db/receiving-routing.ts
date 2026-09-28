import type { SupabaseClient } from '@supabase/supabase-js';
import type { MaterialReceipt, SESupplyRecord, InventorySerial, ProjectMaterial, InventoryItem } from './types';
import { classifySerialFormat, normalizeSerialInput } from '../inventory-serial-normalization';

export interface ReceivingSerialEntry {
  id: string; project_material_id: string | null; se_supply_record_id: string | null;
  inventory_item_id: string; raw_serial: string; normalized_serial: string;
  inventory_serial_id: string | null; active_receipt_id: string | null; updated_at: string; retired_at?: string | null;
}
export function validateReceivingRawSerial(raw: string): string {
  if (classifySerialFormat(raw) === 'unknown') throw new Error('序號格式無法辨識');
  return normalizeSerialInput(raw);
}
export function isActiveSEReservation(record: Pick<SESupplyRecord, 'inventory_serial_id' | 'replace_date' | 'cancelled_at' | 'receiving_only'>): boolean {
  return Boolean(record.inventory_serial_id && !record.replace_date && !record.cancelled_at && !record.receiving_only);
}
export function createReceivingApi(client: SupabaseClient) {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  return {
    sourceDetails: (type: string, id: string) => rpc<ReceivingSourceDetails>('get_receiving_source_details', { p_source_type: type, p_source_id: id }),
    routeReceipt: (args: Record<string, unknown>) => rpc<unknown>('route_receiving_inventory', args),
    cancelArrival: (args: Record<string, unknown>) => rpc<unknown>('cancel_receiving_arrival', args),
    changeSEProject: (record: SESupplyRecord, projectId: string | null) => rpc<SESupplyRecord>('change_receiving_se_project', { p_record_id: record.id, p_project_id: projectId, p_expected_updated_at: record.updated_at }),
    createArrival: (args: Record<string, unknown>) => rpc<SESupplyRecord>('create_office_equipment_arrival', args),
    receive: (args: Record<string, unknown>) => rpc<MaterialReceipt>('confirm_receiving_into_inventory', args),
    correct: (args: Record<string, unknown>) => rpc<MaterialReceipt>('correct_receiving_inventory', args),
    reserve: (args: Record<string, unknown>) => rpc<SESupplyRecord>('reserve_inventory_for_se', args),
    deliver: (args: Record<string, unknown>) => rpc<MaterialReceipt>('deliver_inventory_to_project', args),
    changeReservation: (record: SESupplyRecord, serialId: string) => rpc<SESupplyRecord>('change_se_inventory_reservation', { p_record_id: record.id, p_serial_id: serialId, p_expected_updated_at: record.updated_at }),
    cancelReservation: (record: SESupplyRecord) => rpc<void>('cancel_se_inventory_reservation', { p_record_id: record.id, p_expected_updated_at: record.updated_at }),
    async entries(type: string, id: string): Promise<ReceivingSerialEntry[]> {
      const { data, error } = await client.from('receiving_serial_entries').select('*')
        .eq(type === 'PROJECT_MATERIAL' ? 'project_material_id' : 'se_supply_record_id', id).is('retired_at', null).order('created_at');
      if (error) throw new Error(error.message);
      return data || [];
    },
    async sourceItem(type: string, id: string): Promise<string | null> {
      const { data, error } = await client.from(type === 'PROJECT_MATERIAL' ? 'project_materials' : 'se_supply_records')
        .select('inventory_item_id').eq('id', id).single();
      if (error) throw new Error(error.message);
      return data.inventory_item_id;
    },
    retireEntry: (entry: ReceivingSerialEntry) => rpc<void>('retire_pending_receiving_serial', { p_entry_id: entry.id, p_expected_updated_at: entry.updated_at }),
    registerRaw(type: string, id: string, itemId: string, raw: string) {
      validateReceivingRawSerial(raw);
      return rpc<ReceivingSerialEntry>('register_receiving_serial', { p_source_type: type, p_source_id: id, p_inventory_item_id: itemId, p_raw_serial: raw });
    },
  };
}

export interface ReceivingAllocation {
 id: string; office_receipt_id: string; inventory_item_id: string; inventory_serial_id: string | null; quantity: number; route_type: 'SE' | 'SITE';
 se_supply_record_id: string | null; project_material_id: string | null; inventory_transaction_id: string | null; site_receipt_id: string | null; cancelled_at: string | null; created_at: string;
}
export interface ReceivingSourceDetails {
 inventoryItem?: InventoryItem | null;
 receipts: MaterialReceipt[]; entries: ReceivingSerialEntry[]; allocations: ReceivingAllocation[]; serials: InventorySerial[]; seRecords: SESupplyRecord[];
 links: { receipt_id: string; entry_id: string; inventory_serial_id: string; linked_existing: boolean }[]; materials: ProjectMaterial[]; siteReceipts: MaterialReceipt[];
}
