import type { InventoryItem, InventorySerialLookupResult, MaterialReceipt, Project, ProjectMaterial, ProjectMaterialBatch, SESupplyRecord } from './db/types';
import { classifySerialFormat, deriveShortSerialKey, normalizeSerialInput } from './inventory-serial-normalization';

export type PendingKind = 'PROJECT_MATERIAL' | 'SE_SUPPLY';
export interface Arrival {
  id: string; actual_received_at: string; project_id: string | null; notes: string | null; created_by: string;
  version: number; created_at: string; voided_at: string | null;
}
export interface ArrivalLine {
  id: string; arrival_id: string; inventory_item_id: string | null; quantity: number; unit: string | null;
  resolution_state: 'UNRESOLVED' | 'STAGED' | 'POSTED'; receipt_id: string | null; version: number;
}
export interface ArrivalObservation {
  id: string; project_material_id: string | null; se_supply_record_id: string | null; arrival_line_id: string | null;
  inventory_item_id: string | null; raw_serial: string; normalized_serial: string;
  inventory_serial_id: string | null; active_receipt_id: string | null; retired_at: string | null; updated_at: string;
}
export interface ArrivalMatch {
  id: string; arrival_line_id: string; project_material_id: string | null; se_supply_record_id: string | null;
  quantity: number; cancelled_at: string | null; created_at: string;
}
export interface MatchObservation { match_id: string; arrival_entry_id: string; pending_entry_id: string | null; cancelled_at: string | null }
// Keep the V5 receipt boundary explicit; older callers still accept planning-source receipts.
export type ArrivalReceipt = MaterialReceipt & { arrival_line_id: string | null; route_arrival_line_id: string | null };
export interface PendingFulfilment {
  expected: number; fulfilled: number; remaining: number; active: boolean;
  remaining_status: 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'INACTIVE';
  cancellation: { cancelled_remaining: number; fulfilled_at_cancellation: number; cancelled_at: string } | null;
}
export interface ReceivingSnapshot {
  projects: Project[]; items: InventoryItem[]; materials: ProjectMaterial[]; supplies: SESupplyRecord[]; batches: ProjectMaterialBatch[];
  arrivals: Arrival[]; lines: ArrivalLine[]; observations: ArrivalObservation[]; matches: ArrivalMatch[];
  matchObservations: MatchObservation[]; receipts: ArrivalReceipt[]; fulfilment: Record<string, PendingFulfilment>;
}
export interface PendingRow {
  key: string; kind: PendingKind; id: string; itemId: string | null; label: string; unit: string;
  projectId: string | null; projectLabel: string; expectedAt: string | null; notes: string | null;
  fulfilment: PendingFulfilment; observations: ArrivalObservation[]; legacy: boolean; updatedAt: string; batchId: string | null; sameDay: boolean;
}
export const pendingKey = (kind: PendingKind, id: string) => `${kind}:${id}`;
export const sourceFields = (row: Pick<PendingRow, 'kind' | 'id'>) => row.kind === 'PROJECT_MATERIAL'
  ? { project_material_id: row.id } : { se_supply_record_id: row.id };
export const matchSourceKey = (match: Pick<ArrivalMatch, 'project_material_id' | 'se_supply_record_id'>) => match.project_material_id
  ? pendingKey('PROJECT_MATERIAL', match.project_material_id) : pendingKey('SE_SUPPLY', match.se_supply_record_id!);
export const itemLabel = (item?: InventoryItem) => item ? `${item.code} · ${item.name}` : '待補品項';
export const projectLabel = (projects: Project[], id: string | null) => projects.find(p => p.id === id)?.name || (id ? '歷史案件' : '未指定案件');

export function pendingRows(data: ReceivingSnapshot): PendingRow[] {
  const project = data.materials.filter(m => m.delivery_destination === 'OFFICE').map(m => ({
    kind: 'PROJECT_MATERIAL' as const, id: m.id, itemId: m.inventory_item_id || null,
    label: [m.item_name, m.specification].filter(Boolean).join(' · '), unit: m.unit,
    projectId: m.project_id, expectedAt: m.expected_delivery_at || data.batches.find(b => b.id === m.batch_id)?.planned_receipt_at || null,
    notes: m.notes, updatedAt: m.updated_at, batchId: m.batch_id, sameDay: Boolean(data.batches.find(b => b.id === m.batch_id)?.same_day_delivery),
  }));
  const se = data.supplies.filter(s => s.receiving_only).map(s => ({
    kind: 'SE_SUPPLY' as const, id: s.id, itemId: s.inventory_item_id || null,
    label: s.new_model || '待補品項', unit: s.unit, projectId: s.project_id,
    expectedAt: s.expected_delivery_at, notes: s.notes, updatedAt: s.updated_at, batchId: null, sameDay: false,
  }));
  return [...project, ...se].map(row => ({ ...row, key: pendingKey(row.kind, row.id),
    label: row.itemId ? itemLabel(data.items.find(i => i.id === row.itemId)) : row.label,
    projectLabel: projectLabel(data.projects, row.projectId),
    fulfilment: data.fulfilment[pendingKey(row.kind, row.id)],
    observations: data.observations.filter(e => !e.retired_at && (row.kind === 'PROJECT_MATERIAL' ? e.project_material_id === row.id : e.se_supply_record_id === row.id)),
    legacy: data.receipts.some(r => !r.arrival_line_id && (row.kind === 'PROJECT_MATERIAL' ? r.project_material_id === row.id : r.se_supply_record_id === row.id)),
  })).filter(row => Boolean(row.fulfilment)).sort((a, b) => (a.expectedAt || '9999').localeCompare(b.expectedAt || '9999') || a.key.localeCompare(b.key));
}
export interface ActualRow {
  key: string; label: string; quantity: number; unit: string; at: string | null; projectLabel: string;
  state: 'STAGED' | 'POSTED' | 'UNRESOLVED' | 'LEGACY'; arrival?: Arrival; line?: ArrivalLine; receipt?: ArrivalReceipt;
  observations: ArrivalObservation[]; matches: ArrivalMatch[]; reversed: number;
}
export function actualRows(data: ReceivingSnapshot): ActualRow[] {
  const parents = new Map(data.arrivals.filter(a => !a.voided_at).map(a => [a.id, a]));
  const linkedReceipts = new Set(data.lines.map(l => l.receipt_id).filter(Boolean));
  const rows: ActualRow[] = data.lines.filter(l => parents.has(l.arrival_id)).map(line => {
    const arrival = parents.get(line.arrival_id)!;
    const observations = data.observations.filter(e => e.arrival_line_id === line.id && !e.retired_at);
    return { key: `arrival:${line.id}`, arrival, line, label: line.inventory_item_id ? itemLabel(data.items.find(i => i.id === line.inventory_item_id)) : observations.map(e => e.normalized_serial).join('、') || '待補品項',
      quantity: Number(line.quantity), unit: line.unit || '', at: arrival.actual_received_at,
      projectLabel: projectLabel(data.projects, arrival.project_id), state: line.resolution_state, observations,
      matches: data.matches.filter(m => m.arrival_line_id === line.id && !m.cancelled_at), reversed: 0 };
  });
  const seen = new Set<string>();
  for (const receipt of data.receipts) {
    // Neither reversal events nor receipts linked in either direction create another arrival.
    if (receipt.event_type !== 'RECEIVE' || receipt.arrival_line_id || receipt.route_arrival_line_id || receipt.source_type === 'ARRIVAL' || receipt.source_type === 'ARRIVAL_ROUTE' || linkedReceipts.has(receipt.id) || seen.has(receipt.id)) continue;
    const material = data.materials.find(m => m.id === receipt.project_material_id);
    const supply = data.supplies.find(s => s.id === receipt.se_supply_record_id);
    // Historical null locations are accepted only with an explicit OFFICE planning source.
    if (receipt.receipt_location !== 'OFFICE' && !(receipt.receipt_location == null && (material?.delivery_destination === 'OFFICE' || supply?.receiving_only))) continue;
    seen.add(receipt.id);
    rows.push({ key: `legacy:${receipt.id}`, receipt, label: material?.item_name || supply?.new_model || '歷史品項',
      quantity: Number(receipt.quantity_received), unit: material?.unit || supply?.unit || '',
      at: receipt.received_at || null, projectLabel: projectLabel(data.projects, material?.project_id || supply?.project_id || null),
      state: 'LEGACY', matches: [], observations: data.observations.filter(e => e.active_receipt_id === receipt.id),
      reversed: data.receipts.filter(r => r.event_type === 'REVERSAL' && r.reversal_of_id === receipt.id).reduce((n, r) => n + Number(r.quantity_received), 0) });
  }
  return rows.sort((a, b) => (b.at || '').localeCompare(a.at || '') || a.key.localeCompare(b.key));
}
export const searchPending = (row: PendingRow, query: string) => [row.label, row.projectLabel, ...row.observations.map(e => e.normalized_serial)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
export const searchActual = (row: ActualRow, query: string) => [row.label, row.projectLabel, ...row.observations.map(e => e.normalized_serial)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

export interface ArrivalSerialDraft { raw: string; itemId: string | null; state: 'known' | 'unknown' | 'conflict' }
export function serialsAlias(a: string, b: string): boolean {
  if (normalizeSerialInput(a) === normalizeSerialInput(b)) return true;
  // Two different full identities are never merged merely because their short keys agree.
  return (classifySerialFormat(a) === 'short' || classifySerialFormat(b) === 'short') && Boolean(deriveShortSerialKey(a)) && deriveShortSerialKey(a) === deriveShortSerialKey(b);
}
export function resolveArrivalSerial(raw: string, lookup: InventorySerialLookupResult, entries: ArrivalObservation[], items: InventoryItem[], preferred?: PendingRow): ArrivalSerialDraft {
  const normalized = normalizeSerialInput(raw);
  if (classifySerialFormat(normalized) === 'unknown') throw new Error('序號格式無法辨識，請確認完整序號。');
  if (lookup.result_type !== 'no_match') return { raw: normalized, itemId: null, state: 'conflict' };
  const matching = entries.filter(e => !e.retired_at && serialsAlias(e.normalized_serial, normalized));
  if (matching.some(e => e.arrival_line_id || e.active_receipt_id)) throw new Error('此序號已有到貨紀錄，請在已收到清單查看。');
  const identities = new Set(matching.map(e => e.normalized_serial));
  const itemIds = new Set(matching.map(e => e.inventory_item_id).filter(Boolean));
  if (identities.size > 1 || itemIds.size > 1 || (classifySerialFormat(normalized) === 'full' && matching.some(e => e.normalized_serial !== normalized))) return { raw: normalized, itemId: null, state: 'conflict' };
  const inferred = itemIds.size ? Array.from(itemIds)[0] : preferred?.itemId;
  if (preferred?.itemId && inferred && preferred.itemId !== inferred) return { raw: normalized, itemId: null, state: 'conflict' };
  const item = items.find(i => i.id === inferred && i.is_active && i.requires_serial);
  return { raw: identities.size === 1 ? Array.from(identities)[0] : normalized, itemId: item?.id || null, state: item ? 'known' : 'unknown' };
}
export interface CreateArrivalLine { inventory_item_id: string | null; quantity: number; unit?: string; raw_serials?: string[] }
export function serialDraftLines(drafts: ArrivalSerialDraft[]): CreateArrivalLine[] {
  const groups = new Map<string, CreateArrivalLine>();
  for (const draft of drafts) {
    // Unknown observations remain independently completable, even within a mixed batch.
    const key = draft.itemId || draft.raw;
    const line = groups.get(key) || { inventory_item_id: draft.itemId, quantity: 0, raw_serials: [] };
    line.quantity++; line.raw_serials!.push(draft.raw); groups.set(key, line);
  }
  return Array.from(groups.values());
}
export function receivingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message || '操作失敗，請重試。');
  const errors: [string, string][] = [
    ['INVENTORY_ITEM_DEFINITION_CONFLICT', '此型號已存在，但單位、序號設定或啟用狀態不同，請確認既有品項。'],
    ['AMBIGUOUS_EXISTING_ITEMS', '有多筆同名品項，請選擇既有品項，或提供更明確的新型號／規格。'],
    ['PROJECT_REQUIREMENT_CHANGED', '案場物料需求已變更，請重新選擇。'],
    ['PENDING_DELETE_DOWNSTREAM_EXISTS', '此筆已有到貨或後續紀錄，無法直接刪除，請使用取消／撤回／更正。'],
    ['PENDING_DELETE_VERSION_CONFLICT', '此筆待收已變更，請重新整理後再確認。'],
    ['PENDING_DELETE_INACTIVE', '此筆待收已結束，請重新整理清單。'],
    ['PENDING_DELETE_REQUEST_CONFLICT', '刪除請求與前次內容不符，請重新整理後重試。'],
    ['DOWNSTREAM_CORRECTION_REQUIRED', '此筆已有後續使用或已關帳，需走更正流程。'],
    ['HANDOFF_CAPACITY_CONFLICT', '本批可用數量已改變，請重新整理後調整。'],
    ['HANDOFF_SERIAL_SCOPE_CONFLICT', '請選擇本批仍可用的序號。'],
    ['HANDOFF_RESERVED_QUANTITY_CONFLICT', '可用庫存不足，部分數量已保留給 SE 供貨。'],
    ['HANDOFF_NOT_ACTIVE', '此筆後續處理已變更，請重新整理。'],
    ['HANDOFF_SOURCE_INACTIVE', '此筆收貨目前無法進行後續處理。'],
    ['ARRIVAL_PROJECT_CONFLICT_WITH_MATCH', '此到貨已對應其他案件的待收，請先調整待收對應。'],
    ['VERSION_CONFLICT', '資料已被其他操作更新，請重新整理後再調整。'],
    ['MATCH_CAPACITY_CONFLICT', '待收剩餘或本次到貨可對應數量已改變，請重新整理後調整。'],
    ['MATCH_PENDING_INACTIVE', '此待收已結束；可解除對應，請重新選擇有效待收。'],
    ['MATCH_PREDECLARED_SERIAL_CONFLICT', '選取的序號與預登數量衝突，請選擇符合的到貨序號。'],
    ['MATCH_PROJECT_CONFLICT', '案件與待收不符，請先確認到貨案件。'],
    ['MATCH_ITEM_UNIT_CONFLICT', '品項或單位與待收不符。'],
    ['MATCH_LEGACY_RECEIPT_REQUIRES_PROJECTION', '這筆待收含歷史收貨，請先核對歷史紀錄。'],
    ['ARRIVAL_EXISTING_IN_STOCK', '此序號已在庫，請先確認原到貨紀錄，不能重複入庫。'],
    ['ARRIVAL_SERIAL_IDENTITY_CONFLICT', '序號身份待確認，尚未入庫；請核對原序號資料。'],
    ['MATCHED_PENDING_CORRECTION_REQUIRED', '此待收已有到貨對應，品項、案件與單位不可變更，數量不可少於已收到。'],
    ['PENDING_VERSION_CONFLICT', '待收已更新，請重新整理再修改。'],
  ];
  return errors.find(([code]) => message.includes(code))?.[1] || message;
}
