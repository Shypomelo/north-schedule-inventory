import type { SupabaseClient } from '@supabase/supabase-js';
import { createReceivingV5Api, type CreateArrivalResult } from './receiving-v5';
import { receivingError } from '../receiving-v5';
import type { ArrivalLine } from '../receiving-v5';
import { receivedPostCommand, type HandoffScope, type HandoffTransaction, type ReceivedStage, type ReceivingV6Snapshot } from '../receiving-v6';
import type { ReceivingProjectRequirement } from '../receiving-project-requirements';
import type { InventoryTransaction, MaterialReceipt } from './types';

type InventoryInReversalResult = {
  receipt: MaterialReceipt;
  inventory_transaction: InventoryTransaction;
  staged_quantity?: number;
  remaining_staged_quantity?: number;
};
type PostArrivalLineResult = {
  line: ArrivalLine;
  receipt: MaterialReceipt;
  inventory_transaction: InventoryTransaction;
  remaining_staged_quantity: number;
};

export function createReceivingV6Api(client: SupabaseClient, procurementReadOnly = false) {
  const base = createReceivingV5Api(client, procurementReadOnly);
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  async function rows<T>(table: string, columns: string, order: string | string[]): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      let query = client.from(table).select(columns);
      for (const column of Array.isArray(order) ? order : [order]) query = query.order(column);
      const { data, error } = await query.range(offset, offset + 499);
      if (error) throw new Error(error.message);
      result.push(...data as T[]);
      if (data.length < 500) return result;
    }
  }
  async function rowsByIds<T>(table: string, columns: string, filter: string, ids: string[]): Promise<T[]> {
    const result: T[] = [];
    for (let start = 0; start < ids.length; start += 100) {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await client.from(table).select(columns).in(filter, ids.slice(start, start + 100)).order('id').range(offset, offset + 499);
        if (error) throw new Error(error.message);
        result.push(...data as T[]);
        if (data.length < 500) break;
      }
    }
    return result;
  }
  return {
    ...base,
    createPendingBatch: (args: { p_request_id: string; p_project_id: string | null; p_notes: string | null;
      p_items: { item_id: string; quantity: number; expected_at: string; serials: string[] }[] }) =>
      rpc<{ id: string }[]>('create_receiving_pending_batch', args),
    createBatches: (args: { p_request_id: string; p_actual_received_at: string; p_project_id: string | null;
      p_batches: { kind: 'BOX' | 'LOOSE'; lines: { inventory_item_id: string | null; quantity: number; raw_serials?: string[] }[];
        matches: { line_index: number; quantity: number; project_material_id?: string; se_supply_record_id?: string; raw_serials?: string[] }[] }[] }) =>
      rpc<CreateArrivalResult[]>('create_receiving_batches', args),
    completeBatch: (args: { p_request_id: string; p_line_ids: string[]; p_item_id: string }) =>
      rpc<ArrivalLine[]>('complete_receiving_arrival_lines', args),
    async load(): Promise<ReceivingV6Snapshot> {
      const [data, transactions, closings, actors, receiptSerials, cancellations] = await Promise.all([
        base.load(),
        rows<HandoffTransaction>('inventory_transactions', 'id,item_id,project_id,transaction_type,quantity,transaction_date,schedule_task_id,is_voided,excluded_by_initialization_id,source,handler,created_at,reverses_transaction_id,reenters_reversal_id', 'id'),
        rows<ReceivingV6Snapshot['closings'][number]>('inventory_monthly_closings', 'year,month,status', 'id'),
        (procurementReadOnly ? rpc<ReceivingV6Snapshot['actors']>('get_procurement_actor_labels', {}) : rows<ReceivingV6Snapshot['actors'][number]>('team_members', 'id,name', 'id')),
        rows<ReceivingV6Snapshot['receiptSerials'][number]>('material_receipt_serials', 'receipt_id,entry_id,inventory_serial_id,linked_existing', ['receipt_id', 'entry_id']),
        rows<ReceivingV6Snapshot['cancellations'][number]>('receiving_arrival_stage_cancellations', 'id,arrival_line_id,reversal_receipt_id,quantity,entry_ids,reason,created_by,created_at', 'id'),
      ]);
      const [inventorySerials, transactionSerials] = await Promise.all([
        rowsByIds<ReceivingV6Snapshot['inventorySerials'][number]>('inventory_serials', 'id,item_id,serial_number,status', 'id',
          Array.from(new Set(receiptSerials.map(link => link.inventory_serial_id)))),
        rowsByIds<ReceivingV6Snapshot['transactionSerials'][number]>('inventory_transaction_serials', 'id,transaction_id,serial_id,is_pending', 'transaction_id',
          Array.from(new Set(data.receipts.map(receipt => receipt.inventory_transaction_id).filter((id): id is string => Boolean(id))))),
      ]);
      const scopes: Record<string, HandoffScope> = {}, scopeErrors: Record<string, string> = {};
      const receipts = data.receipts.filter(r => r.event_type === 'RECEIVE' && r.receipt_location === 'OFFICE' && r.inventory_linked);
      for (let start = 0; start < receipts.length; start += 8) await Promise.all(receipts.slice(start, start + 8).map(async r => {
        try { scopes[r.id] = await rpc<HandoffScope>('get_receiving_handoff_scope', { p_receipt_id: r.id }); }
        catch (error) { scopeErrors[r.id] = receivingError(error); }
      }));
      return { ...data, scopes, scopeErrors, transactions, closings, actors, receiptSerials, inventorySerials, transactionSerials, cancellations };
    },
    projectRequirements: (projectId: string, itemId: string) => rpc<ReceivingProjectRequirement[]>('get_receiving_project_requirements', { p_project_id: projectId, p_item_id: itemId }),
    postArrivalLine: (args: { p_request_id: string; p_line_id: string; p_quantity: number; p_entry_ids: string[]; p_posting_date: string | null }) =>
      rpc<PostArrivalLineResult>('post_receiving_arrival_line', args),
    postReceivedToInventory: (args: { stage: ReceivedStage; requestId: string; quantity: number; entryIds: string[]; receivedAt: string }) => {
      const command = receivedPostCommand(args.stage, args.requestId, args.quantity, args.entryIds, args.receivedAt);
      return command.name === 'post_receiving_arrival_line'
        ? rpc<PostArrivalLineResult>(command.name, command.args)
        : rpc<InventoryInReversalResult>(command.name, command.args);
    },
    routeStaged: (args: { stage: ReceivedStage; requestId: string; route: 'SE' | 'PROJECT_PREP'; quantity: number;
      entryIds: string[]; projectId: string | null; materialId: string | null; createNew: boolean; receivedAt: string }) =>
      rpc('route_staged_receiving', { p_request_id: args.requestId, p_stage_kind: args.stage.kind,
        p_line_id: args.stage.lineId, p_reversal_receipt_id: args.stage.reversalReceiptId,
        p_route_type: args.route, p_quantity: args.quantity, p_entry_ids: args.entryIds,
        p_project_id: args.projectId, p_material_id: args.materialId, p_create_new: args.createNew,
        p_received_at: args.receivedAt, p_notes: null }),
    cancelPhysicalStage: (args: { requestId: string; lineId: string; reversalReceiptId: string | null;
      quantity: number; entryIds: string[]; matchReductions: { match_id: string; quantity: number }[]; reason: string }) =>
      rpc('cancel_receiving_physical_stage', { p_request_id: args.requestId, p_line_id: args.lineId,
        p_reversal_receipt_id: args.reversalReceiptId, p_quantity: args.quantity,
        p_entry_ids: args.entryIds, p_match_reductions: args.matchReductions, p_reason: args.reason }),
    handoff: (args: { p_request_id: string; p_receipt_id: string; p_route_type: 'SE' | 'SITE'; p_quantity: number; p_serial_ids: string[]; p_project_id: string | null; p_received_at: string; p_material_id: string | null; p_create_new: boolean }) => rpc('route_receiving_inventory', { ...args, p_notes: null }),
    prepareReceipt: (args: { p_request_id: string; p_receipt_id: string; p_quantity: number; p_serial_ids: string[];
      p_project_id: string; p_material_id: string | null; p_create_new: boolean; p_prepared_at: string }) =>
      rpc('prepare_receiving_project_material', { ...args, p_notes: null }),
    returnSE: (args: { p_request_id: string; p_record_id: string; p_reason: string }) =>
      rpc('return_receiving_se_to_received', { ...args, p_reversed_at: null }),
    returnProjectPrep: (args: { p_request_id: string; p_allocation_id: string; p_reason: string }) =>
      rpc('return_receiving_project_prep_to_received', { ...args, p_reversed_at: null }),
    reverseIn: (args: { p_request_id: string; p_receipt_id: string; p_quantity: number; p_entry_ids: string[]; p_reversed_at: string; p_reason: string }) =>
      rpc<InventoryInReversalResult>('reverse_receiving_inventory_in', args),
    reenterIn: (args: { p_request_id: string; p_reversal_receipt_id: string; p_quantity: number; p_entry_ids: string[]; p_received_at: string; p_notes: string | null }) =>
      rpc<InventoryInReversalResult>('reenter_receiving_inventory', args),
    retract: (args: { p_request_id: string; p_allocation_id: string; p_reason: string }) => rpc('retract_receiving_handoff', args),
    changeHandoff: (args: { p_request_id: string; p_allocation_id: string; p_quantity: number; p_serial_id: string | null; p_project_id: string | null; p_expected_updated_at: string }) => rpc('change_receiving_se_handoff', args),
    deletePending: (args: { p_request_id: string; p_source_type: 'PROJECT_MATERIAL' | 'SE_SUPPLY'; p_source_id: string; p_expected_updated_at: string }) =>
      rpc<{ outcome: 'DELETED'; id: string; retired_entry_ids: string[]; inventory_effect: 0 }>('delete_receiving_pending_source', args),
  };
}
export type ReceivingV6Api = ReturnType<typeof createReceivingV6Api>;
