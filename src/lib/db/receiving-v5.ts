import type { SupabaseClient } from '@supabase/supabase-js';
import type { InventoryItem, InventorySerialLookupResult, Project, ProjectMaterial, ProjectMaterialBatch, SESupplyRecord } from './types';
import { classifySerialFormat } from '../inventory-serial-normalization';
import {
  pendingKey, pendingRows, matchSourceKey,
  type Arrival, type ArrivalLine, type ArrivalMatch, type ArrivalObservation, type ArrivalReceipt,
  type CreateArrivalLine, type MatchObservation, type PendingFulfilment, type PendingRow, type ReceivingSnapshot,
} from '../receiving-v5';

export interface MatchInput { project_material_id?: string; se_supply_record_id?: string; quantity: number; entry_ids?: string[] }
export interface MatchCandidate extends PendingRow { eligibleEntryIds?: string[]; unregisteredEntryIds?: string[]; unregisteredCapacity?: number }
export interface CreateArrivalResult { arrival: Arrival; lines: ArrivalLine[]; matches: { status: 'MATCHED' | 'CONFLICT'; message?: string }[] }
export function createReceivingV5Api(client: SupabaseClient) {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  // Explicit paging prevents the PostgREST row limit from hiding arrivals or breaking deduplication.
  async function rows<T>(table: string, filters: Record<string, unknown> = {}, order = 'id'): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      let query = client.from(table).select('*').order(order).range(offset, offset + 499);
      if (table === 'receiving_arrival_match_serials') query = query.order('arrival_entry_id');
      for (const [column, value] of Object.entries(filters)) query = value === null ? query.is(column, null) : query.eq(column, value);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      result.push(...(data || []) as T[]);
      if (!data || data.length < 500) return result;
    }
  }
  async function lookup(raw: string): Promise<InventorySerialLookupResult> {
    const data = await rpc<(InventorySerialLookupResult['candidates'][number] & Omit<InventorySerialLookupResult, 'candidates'>)[]>('lookup_inventory_serial', { p_input: raw, p_item_id: null, p_allowed_statuses: null });
    if (!data.length) throw new Error('序號查詢未回傳結果，請重試。');
    return { result_type: data[0].result_type, candidate_count: data[0].candidate_count, filtered_candidate_count: data[0].filtered_candidate_count, candidates: data.filter(r => r.id) };
  }
  async function fulfilments(materials: ProjectMaterial[], supplies: SESupplyRecord[]) {
    const sources = [...materials.map(m => ({ kind: 'PROJECT_MATERIAL' as const, id: m.id })), ...supplies.filter(s => s.receiving_only).map(s => ({ kind: 'SE_SUPPLY' as const, id: s.id }))];
    const result: Record<string, PendingFulfilment> = {};
    // Bound RPC fanout. Errors fail the read rather than making zero-fulfilled placeholders.
    for (let start = 0; start < sources.length; start += 8) await Promise.all(sources.slice(start, start + 8).map(async source => {
      result[pendingKey(source.kind, source.id)] = await rpc<PendingFulfilment>('get_receiving_pending_fulfilment', {
        p_project_material_id: source.kind === 'PROJECT_MATERIAL' ? source.id : null,
        p_se_supply_record_id: source.kind === 'SE_SUPPLY' ? source.id : null,
      });
    }));
    return result;
  }
  async function load(): Promise<ReceivingSnapshot> {
    const [projects, items, materials, supplies, arrivals, lines, observations, matches, matchObservations, receipts, batches] = await Promise.all([
      rows<Project & { project_name?: string; project_short_name?: string; deleted_at?: string | null }>('projects'), rows<InventoryItem>('inventory_items'),
      rows<ProjectMaterial>('project_materials', { delivery_destination: 'OFFICE' }), rows<SESupplyRecord>('se_supply_records'),
      rows<Arrival>('receiving_arrivals'), rows<ArrivalLine>('receiving_arrival_lines'),
      rows<ArrivalObservation>('receiving_serial_entries'), rows<ArrivalMatch>('receiving_arrival_matches'),
      rows<MatchObservation>('receiving_arrival_match_serials', {}, 'match_id'), rows<ArrivalReceipt>('material_receipts'),
      rows<ProjectMaterialBatch>('project_material_batches'),
    ]);
    return { projects: projects.map(p => ({ ...p, name: p.project_name || p.name, short_name: p.project_short_name || p.short_name, is_active: p.is_active !== false && !p.deleted_at })), items, materials, supplies, arrivals, lines, observations, matches, matchObservations, receipts, batches,
      fulfilment: await fulfilments(materials, supplies) };
  }
  return {
    load,
    createItem: (args: { p_identity_key: string; p_unit: string; p_requires_serial: boolean }) => rpc<{ item: InventoryItem; created: boolean }>('get_or_create_inventory_item', args),
    async candidates(line: ArrivalLine, arrival: Arrival, snapshot: ReceivingSnapshot): Promise<MatchCandidate[]> {
      // Item/unit/lifecycle constraints run on the server; the authoritative capacity is the V5 RPC.
      const common = { inventory_item_id: line.inventory_item_id, unit: line.unit, receiving_archived_at: null };
      const [materials, supplies, receipts, observations, matches, links] = await Promise.all([
        rows<ProjectMaterial>('project_materials', { ...common, delivery_destination: 'OFFICE' }),
        rows<SESupplyRecord>('se_supply_records', { ...common, receiving_only: true, cancelled_at: null }),
        rows<ArrivalReceipt>('material_receipts'),
        rows<ArrivalObservation>('receiving_serial_entries', { retired_at: null }),
        rows<ArrivalMatch>('receiving_arrival_matches', { cancelled_at: null }),
        rows<MatchObservation>('receiving_arrival_match_serials', { cancelled_at: null }, 'match_id'),
      ]);
      const fulfilment = await fulfilments(materials, supplies);
      const candidates = pendingRows({ ...snapshot, materials, supplies, receipts, fulfilment, observations }).filter(p => {
        const current = matches.filter(m => m.arrival_line_id === line.id && matchSourceKey(m) === p.key).reduce((n, m) => n + Number(m.quantity), 0);
        return !p.legacy && (p.fulfilment.active || (current > 0 && p.fulfilment.remaining_status === 'FULFILLED'))
          && p.fulfilment.remaining + current > 0 && (!arrival.project_id || !p.projectId || arrival.project_id === p.projectId);
      });
      const actual = observations.filter(e => e.arrival_line_id === line.id && e.active_receipt_id === line.receipt_id);
      if (!actual.length) return candidates;
      const compatible: MatchCandidate[] = [];
      for (const p of candidates) {
        const otherMatches = new Set(matches.filter(m => m.arrival_line_id !== line.id && matchSourceKey(m) === p.key).map(m => m.id));
        const claimed = links.filter(l => otherMatches.has(l.match_id));
        const shortLookups = new Map<string, InventorySerialLookupResult>();
        await Promise.all(p.observations.filter(e => classifySerialFormat(e.raw_serial) === 'short').map(async e => { shortLookups.set(e.id, await lookup(e.raw_serial)); }));
        const unregisteredCapacity = Math.max(0, p.fulfilment.expected - p.observations.length - claimed.filter(l => !l.pending_entry_id).length);
        const eligibleEntryIds: string[] = [], unregisteredEntryIds: string[] = [];
        for (const e of actual) {
          const preregistered = p.observations.find(pe => pe.normalized_serial === e.normalized_serial || (shortLookups.get(pe.id)?.result_type === 'unique_match' && shortLookups.get(pe.id)?.candidates[0]?.id === e.inventory_serial_id));
          if (preregistered ? !claimed.some(l => l.pending_entry_id === preregistered.id) : unregisteredCapacity > 0) eligibleEntryIds.push(e.id);
          if (!preregistered) unregisteredEntryIds.push(e.id);
        }
        if (eligibleEntryIds.length) compatible.push({ ...p, eligibleEntryIds, unregisteredEntryIds, unregisteredCapacity });
      }
      return compatible;
    },
    lookup,
    create: (args: { p_request_id: string; p_actual_received_at: string; p_lines: CreateArrivalLine[]; p_project_id: string | null; p_matches: (MatchInput & { line_index: number; raw_serials?: string[] })[] }) => rpc<CreateArrivalResult>('create_receiving_arrival', { ...args, p_match_all_or_nothing: false }),
    complete: (args: { p_request_id: string; p_line_id: string; p_item_id: string }) => rpc<ArrivalLine>('complete_receiving_arrival_line', args),
    metadata: (args: { p_request_id: string; p_arrival_id: string; p_expected_version: number; p_project_id: string | null; p_notes: string | null }) => rpc<Arrival>('update_receiving_arrival_metadata', args),
    cancelRemaining: (args: { p_request_id: string; p_source_type: string; p_source_id: string; p_reason: string | null }) => rpc<PendingFulfilment>('cancel_receiving_pending_remaining', args),
    replaceMatches: (args: { p_request_id: string; p_line_id: string; p_expected_version: number; p_matches: MatchInput[] }) => rpc('replace_receiving_arrival_matches', args),
    createPending: (args: { p_request_id: string; p_item_id: string; p_quantity: number; p_expected_at: string | null; p_project_id: string | null; p_notes: string | null; p_serials: string[] }) => rpc<SESupplyRecord>('create_office_equipment_arrival', args),
    register: (row: PendingRow, raw: string) => rpc<ArrivalObservation>('register_receiving_serial', { p_source_type: row.kind, p_source_id: row.id, p_inventory_item_id: row.itemId, p_raw_serial: raw }),
    async updatePending(row: PendingRow, values: { itemId: string; quantity: number; projectId: string | null; expectedAt: string | null; notes: string | null }, item: InventoryItem) {
      // Existing planning-table permissions and V5 guards still apply; optimistic timestamp avoids lost edits.
      if (row.kind === 'SE_SUPPLY' && values.itemId !== row.itemId) throw new Error('待收品項已建立，請保留原品項。');
      const payload = { quantity: values.quantity, unit: item.unit,
        notes: values.notes,
        ...(row.kind === 'SE_SUPPLY' ? { project_id: values.projectId, expected_delivery_at: values.expectedAt, updated_at: new Date().toISOString() } : { inventory_item_id: values.itemId, item_name: item.name, specification: item.code }) };
      const { data, error } = await client.from(row.kind === 'SE_SUPPLY' ? 'se_supply_records' : 'project_materials')
        .update(payload).eq('id', row.id).eq('updated_at', row.updatedAt).select('id').maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('PENDING_VERSION_CONFLICT');
      if (row.kind === 'PROJECT_MATERIAL' && row.expectedAt !== values.expectedAt) {
        try {
          // Preserve the existing Schedule grouping/default contract.
          if (row.sameDay) await rpc('update_material_receipt_plan', { p_batch_id: row.batchId, p_planned_receipt_at: values.expectedAt });
          else await rpc('update_material_receipt_override', { p_material_id: row.id, p_expected_delivery_at: values.expectedAt });
        } catch (error) { throw new Error('基本資料已儲存，但預計時間未變更。請重新整理後再調整時間。' + (error instanceof Error ? error.message : '')); }
      }
    },
  };
}
export type ReceivingV5Api = ReturnType<typeof createReceivingV5Api>;
