import type { SupabaseClient } from '@supabase/supabase-js';
import { createReceivingV5Api } from './receiving-v5';
import { receivingError } from '../receiving-v5';
import type { HandoffScope, HandoffTransaction, ReceivingV6Snapshot } from '../receiving-v6';
import type { ReceivingProjectRequirement } from '../receiving-project-requirements';

export function createReceivingV6Api(client: SupabaseClient) {
  const base = createReceivingV5Api(client);
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  async function rows<T>(table: string, columns: string, order: string): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client.from(table).select(columns).order(order).range(offset, offset + 499);
      if (error) throw new Error(error.message);
      result.push(...data as T[]);
      if (data.length < 500) return result;
    }
  }
  return {
    ...base,
    async load(): Promise<ReceivingV6Snapshot> {
      const [data, transactions, closings] = await Promise.all([
        base.load(),
        rows<HandoffTransaction>('inventory_transactions', 'id,item_id,project_id,transaction_type,quantity,transaction_date,schedule_task_id,is_voided,excluded_by_initialization_id', 'id'),
        rows<ReceivingV6Snapshot['closings'][number]>('inventory_monthly_closings', 'year,month,status', 'id'),
      ]);
      const scopes: Record<string, HandoffScope> = {}, scopeErrors: Record<string, string> = {};
      const receipts = data.receipts.filter(r => r.event_type === 'RECEIVE' && r.receipt_location === 'OFFICE' && r.inventory_linked);
      for (let start = 0; start < receipts.length; start += 8) await Promise.all(receipts.slice(start, start + 8).map(async r => {
        try { scopes[r.id] = await rpc<HandoffScope>('get_receiving_handoff_scope', { p_receipt_id: r.id }); }
        catch (error) { scopeErrors[r.id] = receivingError(error); }
      }));
      return { ...data, scopes, scopeErrors, transactions, closings };
    },
    projectRequirements: (projectId: string, itemId: string) => rpc<ReceivingProjectRequirement[]>('get_receiving_project_requirements', { p_project_id: projectId, p_item_id: itemId }),
    handoff: (args: { p_request_id: string; p_receipt_id: string; p_route_type: 'SE' | 'SITE'; p_quantity: number; p_serial_ids: string[]; p_project_id: string | null; p_received_at: string; p_material_id: string | null; p_create_new: boolean }) => rpc('route_receiving_inventory', { ...args, p_notes: null }),
    retract: (args: { p_request_id: string; p_allocation_id: string; p_reason: string }) => rpc('retract_receiving_handoff', args),
    changeHandoff: (args: { p_request_id: string; p_allocation_id: string; p_quantity: number; p_serial_id: string | null; p_project_id: string | null; p_expected_updated_at: string }) => rpc('change_receiving_se_handoff', args),
  };
}
export type ReceivingV6Api = ReturnType<typeof createReceivingV6Api>;
