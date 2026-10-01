import { actualRows, pendingRows, matchSourceKey, sourceFields, serialsAlias, type ActualRow, type PendingRow, type ReceivingSnapshot, type CreateArrivalLine } from './receiving-v5';
import { normalizeSerialInput } from './inventory-serial-normalization';
import type { InventorySerialLookupResult } from './db/types';
import type { ReceivingAllocation } from './db/receiving-routing';

export function matchesReceivingFilter(status: string, filter: string): boolean {
  return filter === '全部' || (filter === '待處理'
    ? status === '待收' || status === '部分到貨' || status === '待補資料'
    : status === filter);
}

export interface HandoffAllocation extends ReceivingAllocation {
  state: 'ACTIVE' | 'CANCELLED' | 'REVERSED' | 'USED' | 'TERMINAL';
  supersedes_allocation_id: string | null; reversal_receipt_id: string | null;
}
export interface HandoffScope {
  receipt_id: string; item_id: string; requires_serial: boolean; received: number; se: number; site: number;
  other: number; available: number; available_serial_ids: string[]; allocations: HandoffAllocation[];
}
export interface HandoffTransaction { id: string; item_id: string; project_id: string | null; transaction_type: string; quantity: number; transaction_date: string; schedule_task_id: string | null; is_voided: boolean; excluded_by_initialization_id: string | null }
export interface ReceivingV6Snapshot extends ReceivingSnapshot {
  scopes: Record<string, HandoffScope>; scopeErrors: Record<string, string>;
  transactions: HandoffTransaction[]; closings: { year: string; month: string; status: string }[];
}
export interface ArrivalSlice { actual: ActualRow; quantity: number; entryIds: string[]; serialIds: string[]; receiptId: string | null }
export type WorkStatus = '待收' | '部分到貨' | '已收到' | '待補資料' | '已取消';
export interface ReceivingWorkItem {
  key: string; label: string; projectLabel: string; status: WorkStatus; pending?: PendingRow;
  slices: ArrivalSlice[]; received: number; unit: string; at: string | null;
}

/** Matching partitions an Arrival for display only. Every received unit appears once. */
export function receivingWorkItems(data: ReceivingSnapshot): ReceivingWorkItem[] {
  const pending = pendingRows(data);
  const result = new Map<string, ReceivingWorkItem>(pending.map(p => [p.key, {
    key: p.key, label: p.label, projectLabel: p.projectLabel, pending: p, slices: [], unit: p.unit,
    received: p.fulfilment.fulfilled, at: p.expectedAt,
    status: p.fulfilment.cancellation && !p.fulfilment.fulfilled ? '已取消' : p.fulfilment.remaining <= 0 ? '已收到' : p.fulfilment.fulfilled > 0 ? '部分到貨' : '待收',
  }]));
  for (const actual of actualRows(data)) {
    const receiptId = actual.line?.receipt_id || actual.receipt?.id || null;
    const slice = (quantity: number, entries = actual.observations): ArrivalSlice => ({ actual, quantity, receiptId, entryIds: entries.map(e => e.id), serialIds: entries.flatMap(e => e.inventory_serial_id ? [e.inventory_serial_id] : []) });
    const net = Math.max(0, actual.quantity - actual.reversed);
    if (actual.receipt) {
      const key = matchSourceKey(actual.receipt);
      const owner = result.get(key);
      if (owner) { owner.slices.push(slice(net)); continue; }
    }
    let assigned = 0; const assignedEntries = new Set<string>();
    for (const match of actual.matches) {
      const owner = result.get(matchSourceKey(match));
      if (!owner) throw new Error('收貨對應資料不完整，請重新整理。');
      const ids = new Set(data.matchObservations.filter(m => m.match_id === match.id && !m.cancelled_at).map(m => m.arrival_entry_id));
      const entries = actual.observations.filter(e => ids.has(e.id));
      if (entries.some(e => assignedEntries.has(e.id)) || (actual.observations.length && entries.length !== Number(match.quantity))) throw new Error('收貨序號對應不一致，請重新整理。');
      entries.forEach(e => assignedEntries.add(e.id)); assigned += Number(match.quantity);
      owner.slices.push(slice(Number(match.quantity), entries));
    }
    if (assigned > net) throw new Error('收貨對應數量不一致，請重新整理。');
    if (net > assigned || actual.state === 'UNRESOLVED') result.set(actual.key, {
      key: actual.key, label: actual.label, projectLabel: actual.projectLabel, status: actual.state === 'UNRESOLVED' ? '待補資料' : '已收到',
      slices: [slice(net - assigned, actual.observations.filter(e => !assignedEntries.has(e.id)))], received: net - assigned, unit: actual.unit, at: actual.at,
    });
  }
  return Array.from(result.values()).sort((a, b) => {
    const rank = (r: ReceivingWorkItem) => r.status === '待補資料' ? 0 : r.status === '部分到貨' ? 1 : r.status === '待收' ? 2 : 3;
    return rank(a) - rank(b) || (b.at || '').localeCompare(a.at || '') || a.key.localeCompare(b.key);
  });
}
export function workItemSearch(row: ReceivingWorkItem, query: string) {
  return [row.label, row.projectLabel, ...row.pending?.observations.map(e => e.normalized_serial) || [], ...row.slices.flatMap(s => s.actual.observations.filter(e => s.entryIds.includes(e.id)).map(e => e.normalized_serial))].join(' ').toLowerCase().includes(query.trim().toLowerCase());
}

/** Never attribute a quantity-only handoff to a particular match without provenance. */
export function workItemStock(row: ReceivingWorkItem, data: ReceivingV6Snapshot) {
  let available = 0, se = 0, site = 0, shared = false, known = false;
  for (const slice of row.slices) {
    const scope = slice.receiptId && data.scopes[slice.receiptId]; if (!scope) continue;
    known = true;
    if (!scope.requires_serial && slice.quantity !== scope.received) { shared = true; continue; }
    if (!scope.requires_serial) { available += scope.available; se += scope.se; site += scope.site; continue; }
    available += scope.available_serial_ids.filter(id => slice.serialIds.includes(id)).length;
    for (const a of scope.allocations.filter(a => !a.cancelled_at && a.inventory_serial_id && slice.serialIds.includes(a.inventory_serial_id))) {
      if (a.route_type === 'SE') se += Number(a.quantity); else site += Number(a.quantity);
    }
  }
  return { available, se, site, shared, known };
}

export interface SerialAutoDraft {
  raw: string; itemId: string | null; state: 'known' | 'unknown' | 'conflict';
  pendingKey: string | null; candidates: string[]; choiceRequired: boolean;
}
/** Only an exact unclaimed preregistration is automatic. Aliases require an explicit choice. */
export function pendingSerialDraft(raw: string, data: ReceivingSnapshot, projectId: string | null = null): SerialAutoDraft {
  const normalized = normalizeSerialInput(raw);
  const claimed = new Set(data.matchObservations.filter(m => !m.cancelled_at).map(m => m.pending_entry_id));
  const candidates = pendingRows(data).filter(p => !p.legacy && p.fulfilment.active && p.fulfilment.remaining > 0
    && (!projectId || !p.projectId || p.projectId === projectId)
    && p.observations.some(e => !e.active_receipt_id && !claimed.has(e.id) && serialsAlias(e.normalized_serial, normalized)));
  const exact = candidates.filter(p => p.observations.some(e => !claimed.has(e.id) && normalizeSerialInput(e.normalized_serial) === normalized));
  // A second alias owner is ambiguity, even when one of them is an exact match.
  const automatic = candidates.length === 1 && exact.length === 1 ? exact[0] : undefined;
  const ids = new Set(candidates.map(p => p.itemId));
  const inferred = ids.size === 1 ? candidates[0]?.itemId : null;
  return { raw: normalized, itemId: inferred || null, state: inferred ? 'known' : 'unknown', pendingKey: automatic?.key || null, candidates: candidates.map(p => p.key), choiceRequired: candidates.length > 0 && !automatic };
}
export function finishSerialDraft(draft: SerialAutoDraft, lookup: InventorySerialLookupResult, data: ReceivingSnapshot, preferred?: PendingRow): SerialAutoDraft {
  if (lookup.result_type !== 'no_match' || data.observations.some(e => !e.retired_at && (e.arrival_line_id || e.active_receipt_id) && serialsAlias(e.normalized_serial, draft.raw)))
    return { ...draft, itemId: null, state: 'conflict', pendingKey: null, choiceRequired: false };
  if (draft.candidates.length) return draft;
  const hinted = data.observations.filter(e => !e.retired_at && serialsAlias(e.normalized_serial, draft.raw));
  const ids = new Set(hinted.map(e => e.inventory_item_id).filter(Boolean));
  const itemId = ids.size === 1 ? Array.from(ids)[0] : preferred?.itemId;
  const item = data.items.find(i => i.id === itemId && i.is_active && i.requires_serial);
  return { ...draft, itemId: item?.id || null, state: item ? 'known' : 'unknown' };
}
export function groupedSerialArrival(drafts: SerialAutoDraft[], pending: PendingRow[]) {
  const groups = new Map<string, { line: CreateArrivalLine; pending?: PendingRow }>();
  for (const d of drafts) {
    if (d.state === 'conflict') throw new Error(`序號 ${d.raw} 已存在或與品項衝突，請返回掃描確認。`);
    if (d.choiceRequired) throw new Error('請先選擇有多種可能的預計收貨，或保留未對應。');
    const target = pending.find(p => p.key === d.pendingKey);
    if (d.pendingKey && (!target || target.itemId !== d.itemId || !target.fulfilment.active)) throw new Error('預計收貨已變更，請重新整理。');
    const key = d.itemId ? `${d.itemId}:${d.pendingKey || 'standalone'}` : d.raw;
    const group = groups.get(key) || { line: { inventory_item_id: d.itemId, quantity: 0, raw_serials: [] }, pending: target };
    group.line.quantity++; group.line.raw_serials!.push(d.raw); groups.set(key, group);
  }
  const values = Array.from(groups.values());
  for (const g of values) if (g.pending && g.line.quantity > g.pending.fulfilment.remaining) throw new Error('本批超過預計收貨剩餘數量，請調整分組。');
  return { lines: values.map(g => g.line), matches: values.flatMap((g, line_index) => g.pending ? [{ ...sourceFields(g.pending), line_index, quantity: g.line.quantity, raw_serials: g.line.raw_serials }] : []) };
}

export function handoffCorrectionRequired(a: HandoffAllocation, scope: HandoffScope, data: ReceivingV6Snapshot, now = new Date()) {
  if (a.state !== 'ACTIVE') return true;
  if (a.route_type === 'SE') {
    const se = data.supplies.find(s => s.id === a.se_supply_record_id);
    return !se || Boolean(se.replace_date || se.cancelled_at) || se.inventory_serial_id !== a.inventory_serial_id || Number(se.quantity) !== Number(a.quantity);
  }
  const tx = data.transactions.find(t => t.id === a.inventory_transaction_id);
  const site = data.receipts.find(r => r.id === a.site_receipt_id);
  const group = scope.allocations.filter(x => x.site_receipt_id === a.site_receipt_id);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const currentMonth = `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
  return !tx || !site || tx.is_voided || Boolean(tx.excluded_by_initialization_id || tx.schedule_task_id)
    || tx.transaction_type !== 'OUT' || group.some(x => x.state !== 'ACTIVE')
    || Number(site.quantity_received) !== Number(tx.quantity)
    || data.receipts.some(r => r.reversal_of_id === site.id)
    || data.closings.some(c => c.status === 'CLOSED' && [`${c.year}-${c.month.padStart(2, '0')}`].some(month => tx.transaction_date.startsWith(month) || currentMonth.includes(month)));
}
