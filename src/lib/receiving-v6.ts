import { actualRows, pendingRows, matchSourceKey, sourceFields, serialsAlias, itemLabel, projectLabel, type ActualRow, type PendingRow, type ReceivingSnapshot, type CreateArrivalLine } from './receiving-v5';
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
export interface HandoffTransaction { id: string; item_id: string; project_id: string | null; transaction_type: string; quantity: number; transaction_date: string; schedule_task_id: string | null; is_voided: boolean; excluded_by_initialization_id: string | null; source: string | null; handler: string | null; created_at: string; reverses_transaction_id: string | null; reenters_reversal_id: string | null }
export interface ReceiptSerialLink { receipt_id: string; entry_id: string; inventory_serial_id: string; linked_existing: boolean }
export interface ReceivingInventorySerial { id: string; item_id: string; serial_number: string; status: string }
export interface ReceivingTransactionSerial { transaction_id: string; serial_id: string; is_pending: boolean }
export interface ReceivingV6Snapshot extends ReceivingSnapshot {
  scopes: Record<string, HandoffScope>; scopeErrors: Record<string, string>;
  transactions: HandoffTransaction[]; closings: { year: string; month: string; status: string }[];
  actors: { id: string; name: string }[];
  receiptSerials: ReceiptSerialLink[]; inventorySerials: ReceivingInventorySerial[];
  transactionSerials: ReceivingTransactionSerial[];
  cancellations: ReceivingStageCancellation[];
}
export interface ReceivingStageCancellation {
  id: string; arrival_line_id: string; reversal_receipt_id: string | null;
  quantity: number; entry_ids: string[]; reason: string; created_by: string; created_at: string;
}
export interface ReceivedSerialIdentity { entryId: string; inventorySerialId: string | null; serialNumber: string }
export type ReceivedStage = {
  kind: 'NORMAL' | 'REENTRY'; key: string; lineId: string; reversalReceiptId: string | null; reversalAt: string | null;
  quantity: number; requiresSerial: boolean; serials: ReceivedSerialIdentity[]; row: ActualRow;
};
export interface ReceivedGroup {
  key: string; itemId: string | null; pn: string; name: string; quantity: number; unit: string;
  at: string | null; projectLabels: string[]; states: ActualRow['state'][]; temporary: boolean; rows: ActualRow[];
  remainingByLine: Record<string, number>;
  stages: ReceivedStage[];
}
export interface ReceivingHistoryRow {
  id: string; at: string; actor: string; item: string; quantity: number; unit: string;
  type: string; state: string; projectLabel: string; transactionId: string | null;
  receiptId: string | null; arrivalLineId: string | null; itemId: string | null;
  requiresSerial: boolean; serials: ReceivedSerialIdentity[]; reversibleSerials: ReceivedSerialIdentity[];
  reversibleQuantity: number; returnToReceived: boolean;
}
const eventTime = (value: string | null) => value ? Date.parse(value) || 0 : 0;

/** The remaining quantity comes from the canonical Pending fulfilment RPC. */
export function receivingPendingList(data: ReceivingSnapshot): PendingRow[] {
  return pendingRows(data).filter(row => {
    const source = row.kind === 'PROJECT_MATERIAL' ? data.materials.find(m => m.id === row.id) : data.supplies.find(s => s.id === row.id);
    return row.fulfilment.active && Number(row.fulfilment.remaining) > 0 && !source?.receiving_deleted_at;
  });
}

/** Legacy lines own one ARRIVAL receipt; routed lines use original ARRIVAL_ROUTE receipts. */
export function arrivalPostingRemaining(row: ActualRow, data: ReceivingSnapshot): number {
  if (!row.line) return row.quantity;
  const canceled = (('cancellations' in data ? data.cancellations : []) as ReceivingStageCancellation[])
    .filter(event => event.arrival_line_id === row.line!.id && !event.reversal_receipt_id)
    .reduce((sum, event) => sum + Number(event.quantity), 0);
  if (row.state === 'UNRESOLVED') return row.quantity - canceled;
  const legacyReceipt = data.receipts.find(receipt => receipt.id === row.line!.receipt_id
    && receipt.source_type === 'ARRIVAL' && receipt.arrival_line_id === row.line!.id
    && receipt.event_type === 'RECEIVE' && !receipt.reentry_of_reversal_id);
  const routePosted = data.receipts.filter(receipt => receipt.source_type === 'ARRIVAL_ROUTE'
    && receipt.route_arrival_line_id === row.line!.id && receipt.event_type === 'RECEIVE'
    && !receipt.reentry_of_reversal_id).reduce((sum, receipt) => sum + Number(receipt.quantity_received), 0);
  if (legacyReceipt && routePosted) throw new Error('到貨已有兩種正式入庫收貨來源，請重新整理。');
  const posted = legacyReceipt ? Number(legacyReceipt.quantity_received) : routePosted;
  const remaining = row.quantity - posted - canceled;
  if (!Number.isFinite(remaining) || remaining < 0) throw new Error('到貨入庫數量不一致，請重新整理。');
  return remaining;
}

export function stageableSerialEntries(row: ActualRow) {
  return row.observations.filter(entry => !entry.retired_at && !entry.inventory_serial_id && !entry.active_receipt_id);
}

function receiptSerialIdentities(receiptId: string, data: ReceivingV6Snapshot): ReceivedSerialIdentity[] {
  return data.receiptSerials.filter(link => link.receipt_id === receiptId).map(link => {
    const entry = data.observations.find(value => value.id === link.entry_id);
    const serial = data.inventorySerials.find(value => value.id === link.inventory_serial_id);
    if (!entry || !serial || entry.inventory_serial_id !== serial.id) throw new Error('收據序號關聯不完整，請重新整理。');
    return { entryId: entry.id, inventorySerialId: serial.id, serialNumber: serial.serial_number };
  });
}

function transactionOwnsSerial(data: ReceivingV6Snapshot, transactionId: string, serialId: string) {
  return data.transactionSerials.some(link => link.transaction_id === transactionId && link.serial_id === serialId && !link.is_pending);
}

/** Group unposted physical arrivals by canonical item; unresolved lines keep their own identity. */
export function receivedItemGroups(data: ReceivingV6Snapshot): ReceivedGroup[] {
  const groups = new Map<string, ReceivedGroup>();
  for (const row of actualRows(data)) {
    const itemId = row.line?.inventory_item_id || null;
    const item = data.items.find(value => value.id === itemId);
    const stages: ReceivedStage[] = [];
    const normal = row.state === 'LEGACY' ? Math.max(0, row.quantity - row.reversed) : arrivalPostingRemaining(row, data);
    if (row.line && row.state !== 'UNRESOLVED' && normal > 0) {
      const entries = stageableSerialEntries(row);
      if (item?.requires_serial && entries.length !== normal) throw new Error('到貨序號與待入庫數量不一致，請重新整理。');
      stages.push({ kind: 'NORMAL', key: `normal:${row.line.id}`, lineId: row.line.id, reversalReceiptId: null, reversalAt: null,
        quantity: normal, requiresSerial: Boolean(item?.requires_serial),
        serials: item?.requires_serial ? entries.map(entry => ({ entryId: entry.id, inventorySerialId: null, serialNumber: entry.normalized_serial })) : [], row });
    }
    if (row.line && itemId) for (const reversal of data.receipts.filter(receipt => receipt.source_type === 'ARRIVAL_ROUTE'
      && receipt.route_arrival_line_id === row.line!.id && receipt.event_type === 'REVERSAL'
      && receipt.inventory_linked && receipt.inventory_transaction_id)) {
      const origin = data.receipts.find(receipt => receipt.id === reversal.reversal_of_id);
      const reversalTx = data.transactions.find(tx => tx.id === reversal.inventory_transaction_id);
      if (!origin || origin.source_type !== 'ARRIVAL_ROUTE' || origin.route_arrival_line_id !== row.line.id
        || !origin.inventory_transaction_id || !reversalTx || reversalTx.transaction_type !== 'IN_REVERSAL'
        || reversalTx.reverses_transaction_id !== origin.inventory_transaction_id || reversalTx.is_voided
        || reversalTx.excluded_by_initialization_id) throw new Error('入庫撤回關聯不完整，請重新整理。');
      const reentered = data.transactions.filter(tx => tx.reenters_reversal_id === reversalTx.id && !tx.is_voided
        && !tx.excluded_by_initialization_id).reduce((sum, tx) => sum + Number(tx.quantity), 0);
      const canceled = data.cancellations?.filter(event => event.reversal_receipt_id === reversal.id)
        .reduce((sum, event) => sum + Number(event.quantity), 0) || 0;
      const staged = Number(reversal.quantity_received) - reentered - canceled;
      if (!Number.isFinite(staged) || staged < 0) throw new Error('重新入庫數量不一致，請重新整理。');
      if (!staged) continue;
      const serials = item?.requires_serial ? receiptSerialIdentities(reversal.id, data).filter(identity => {
        const entry = data.observations.find(value => value.id === identity.entryId);
        const serial = data.inventorySerials.find(value => value.id === identity.inventorySerialId);
        return entry && !entry.retired_at && !entry.active_receipt_id && serial?.item_id === itemId
          && serial.status === '待入庫' && transactionOwnsSerial(data, reversalTx.id, serial.id);
      }) : [];
      if (item?.requires_serial && serials.length !== staged) throw new Error('重新入庫序號關聯不完整，請重新整理。');
      stages.push({ kind: 'REENTRY', key: `reentry:${reversal.id}`, lineId: row.line.id, reversalReceiptId: reversal.id,
        reversalAt: reversal.received_at,
        quantity: staged, requiresSerial: Boolean(item?.requires_serial), serials, row });
    }
    const remaining = stages.reduce((sum, stage) => sum + stage.quantity, 0)
      + (row.state === 'LEGACY' || row.state === 'UNRESOLVED' ? normal : 0);
    if (!remaining) continue;
    if (itemId && !item) throw new Error('到貨品項資料不完整，請重新整理。');
    const key = row.state === 'LEGACY' ? row.key : itemId ? `item:${itemId}` : row.key;
    const group = groups.get(key) || {
      key, itemId, pn: item?.code || (row.state === 'UNRESOLVED' ? '待補品項' : row.label),
      name: item?.name || (row.state === 'UNRESOLVED' ? '尚未確認品項' : row.label),
      quantity: 0, unit: row.unit, at: row.at, projectLabels: [], states: [], temporary: false, rows: [], remainingByLine: {}, stages: [],
    };
    group.quantity += remaining;
    group.remainingByLine[row.line?.id || row.key] = remaining;
    group.stages.push(...stages);
    if (eventTime(row.at) > eventTime(group.at)) group.at = row.at;
    if (row.projectLabel !== '未指定案件' && !group.projectLabels.includes(row.projectLabel)) group.projectLabels.push(row.projectLabel);
    if (!group.states.includes(row.state)) group.states.push(row.state);
    if (row.arrival && !row.matches.length) group.temporary = true;
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => eventTime(b.at) - eventTime(a.at) || a.key.localeCompare(b.key));
}

/** Read-only timeline from existing arrival, receipt, reversal, and transaction records. */
export function receivingHistory(data: ReceivingV6Snapshot): ReceivingHistoryRow[] {
  const actors = new Map(data.actors.map(actor => [actor.id, actor.name]));
  const transactions = new Map(data.transactions.map(tx => [tx.id, tx]));
  const linkedTransactions = new Set(data.receipts.map(receipt => receipt.inventory_transaction_id).filter(Boolean));
  const rows: ReceivingHistoryRow[] = [];
  for (const actual of actualRows(data).filter(row => row.arrival)) {
    rows.push({ id: actual.key, at: actual.at || actual.arrival!.created_at,
      actor: actors.get(actual.arrival!.created_by) || '未知經手人', item: actual.label,
      quantity: actual.quantity, unit: actual.unit, type: '實際到貨',
      state: '庫存效果 0',
      projectLabel: actual.projectLabel, transactionId: null, receiptId: null,
      arrivalLineId: actual.line?.id || null, itemId: actual.line?.inventory_item_id || null,
      requiresSerial: false, serials: [], reversibleSerials: [], reversibleQuantity: 0, returnToReceived: false });
  }
  for (const event of data.cancellations || []) {
    const line = data.lines.find(value => value.id === event.arrival_line_id);
    const item = data.items.find(value => value.id === line?.inventory_item_id);
    rows.push({ id: `cancel:${event.id}`, at: event.created_at,
      actor: actors.get(event.created_by) || '歷史人員', item: itemLabel(item),
      quantity: -Number(event.quantity), unit: line?.unit || item?.unit || '',
      type: '取消實際到貨', state: 'Physical Arrival 取消',
      projectLabel: projectLabel(data.projects, data.arrivals.find(value => value.id === line?.arrival_id)?.project_id || null),
      transactionId: null, receiptId: null, arrivalLineId: line?.id || null,
      itemId: line?.inventory_item_id || null, requiresSerial: Boolean(item?.requires_serial),
      serials: [], reversibleSerials: [], reversibleQuantity: 0, returnToReceived: false });
  }
  for (const receipt of data.receipts) {
    const tx = receipt.inventory_transaction_id ? transactions.get(receipt.inventory_transaction_id) : undefined;
    const lineId = receipt.route_arrival_line_id || receipt.arrival_line_id;
    const line = data.lines.find(value => value.id === lineId);
    const material = data.materials.find(value => value.id === receipt.project_material_id);
    const supply = data.supplies.find(value => value.id === receipt.se_supply_record_id);
    const itemId = tx?.item_id || line?.inventory_item_id || material?.inventory_item_id || supply?.inventory_item_id;
    const projectId = line ? data.arrivals.find(value => value.id === line.arrival_id)?.project_id : material?.project_id || supply?.project_id;
    const item = data.items.find(value => value.id === itemId);
    const serials = receiptSerialIdentities(receipt.id, data);
    const reversed = data.receipts.filter(value => value.event_type === 'REVERSAL' && value.reversal_of_id === receipt.id)
      .reduce((sum, value) => sum + Number(value.quantity_received), 0);
    const remaining = receipt.event_type === 'RECEIVE' && receipt.receipt_location === 'OFFICE'
      && receipt.inventory_linked && tx?.transaction_type === 'IN' && !tx.is_voided
      && !tx.excluded_by_initialization_id ? Number(receipt.quantity_received) - reversed : 0;
    if (!Number.isFinite(remaining) || remaining < 0) throw new Error('收據撤回數量不一致，請重新整理。');
    const reversibleSerials = item?.requires_serial && remaining > 0 ? serials.filter(identity => {
      const entry = data.observations.find(value => value.id === identity.entryId);
      const serial = data.inventorySerials.find(value => value.id === identity.inventorySerialId);
      const link = data.receiptSerials.find(value => value.receipt_id === receipt.id && value.entry_id === identity.entryId);
      return Boolean(link && !link.linked_existing && entry?.active_receipt_id === receipt.id && serial?.item_id === itemId
        && serial?.status === '在庫' && tx && transactionOwnsSerial(data, tx.id, serial.id));
    }) : [];
    const reversibleQuantity = item?.requires_serial ? Math.min(remaining, reversibleSerials.length) : remaining;
    const arrival = line ? data.arrivals.find(value => value.id === line.arrival_id) : undefined;
    const type = receipt.event_type === 'REVERSAL' ? (tx?.transaction_type === 'IN_REVERSAL' ? '入庫撤回' : '收貨更正')
      : receipt.reentry_of_reversal_id ? '重新入庫' : receipt.source_type === 'ARRIVAL_ROUTE' ? '正式入庫' : '收貨';
    rows.push({ id: `receipt:${receipt.id}`, at: receipt.received_at || receipt.created_at,
      actor: actors.get(receipt.received_by) || tx?.handler || '未知經手人',
      item: itemLabel(data.items.find(value => value.id === itemId)) === '待補品項'
        ? material?.item_name || supply?.new_model || '待補品項' : itemLabel(data.items.find(value => value.id === itemId)),
      quantity: Number(receipt.quantity_received) * (receipt.event_type === 'REVERSAL' ? -1 : 1),
      unit: data.items.find(value => value.id === itemId)?.unit || material?.unit || supply?.unit || line?.unit || '',
      type, state: tx ? `${tx.transaction_type} · ${tx.source || '庫存交易'}` : receipt.receipt_location === 'SITE' ? '案場收貨' : '收貨紀錄',
      projectLabel: data.projects.find(value => value.id === projectId)?.name || '未指定案件', transactionId: tx?.id || null,
      receiptId: receipt.id, arrivalLineId: lineId || null, itemId: itemId || null,
      requiresSerial: Boolean(item?.requires_serial), serials, reversibleSerials,
      reversibleQuantity, returnToReceived: receipt.source_type === 'ARRIVAL_ROUTE' && Boolean(line && arrival && !arrival.voided_at)
        && Boolean(item?.is_active) && reversibleQuantity > 0 });
  }
  for (const tx of data.transactions) {
    if (linkedTransactions.has(tx.id) || !tx.source || !/^(ARRIVAL_ROUTE|RECEIVING_)/.test(tx.source)) continue;
    rows.push({ id: `transaction:${tx.id}`, at: tx.created_at, actor: tx.handler || '未知經手人',
      item: itemLabel(data.items.find(value => value.id === tx.item_id)), quantity: Number(tx.quantity),
      unit: data.items.find(value => value.id === tx.item_id)?.unit || '', type: '庫存交易',
      state: `${tx.transaction_type} · ${tx.source}`, projectLabel: data.projects.find(value => value.id === tx.project_id)?.name || '未指定案件',
      transactionId: tx.id, receiptId: null, arrivalLineId: null, itemId: tx.item_id,
      requiresSerial: false, serials: [], reversibleSerials: [], reversibleQuantity: 0, returnToReceived: false });
  }
  return rows.sort((a, b) => eventTime(b.at) - eventTime(a.at) || b.id.localeCompare(a.id));
}

export function reverseReceiptPayload(row: ReceivingHistoryRow, requestId: string, quantity: number,
  entryIds: string[], reversedAt: string, reason: string) {
  if (!row.returnToReceived || !row.receiptId || !row.transactionId || !row.itemId || !reason.trim()
    || !Number.isFinite(Date.parse(reversedAt)) || !Number.isFinite(Date.parse(row.at))
    || !Number.isFinite(quantity) || quantity <= 0 || quantity > row.reversibleQuantity
    || (row.requiresSerial ? !Number.isInteger(quantity) || entryIds.length !== quantity
      || new Set(entryIds).size !== quantity
      || entryIds.some(id => !row.reversibleSerials.some(serial => serial.entryId === id)) : entryIds.length !== 0))
    throw new Error('收據撤回資料不完整或數量超過可撤回範圍。');
  return { p_request_id: requestId, p_receipt_id: row.receiptId, p_quantity: quantity,
    p_entry_ids: entryIds, p_reversed_at: Date.parse(reversedAt) < Date.parse(row.at) ? row.at : reversedAt,
    p_reason: reason.trim() };
}

export function receivedPostCommand(stage: ReceivedStage, requestId: string, quantity: number,
  entryIds: string[], receivedAt: string) {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > stage.quantity
    || (stage.requiresSerial ? !Number.isInteger(quantity) || entryIds.length !== quantity
      || new Set(entryIds).size !== quantity
      || entryIds.some(id => !stage.serials.some(serial => serial.entryId === id)) : entryIds.length !== 0))
    throw new Error('待入庫序號或數量不一致，請重新整理。');
  if (stage.kind === 'NORMAL') {
    if (!stage.lineId || stage.reversalReceiptId || entryIds.some(id => stage.serials.find(serial => serial.entryId === id)?.inventorySerialId))
      throw new Error('一般到貨入庫關聯不完整，請重新整理。');
    return { name: 'post_receiving_arrival_line' as const,
      args: { p_request_id: requestId, p_line_id: stage.lineId, p_quantity: quantity,
        p_entry_ids: entryIds, p_posting_date: null } };
  }
  if (!stage.reversalReceiptId || entryIds.some(id => !stage.serials.find(serial => serial.entryId === id)?.inventorySerialId))
    throw new Error('重新入庫收據關聯不完整，請重新整理。');
  if (!stage.reversalAt || !Number.isFinite(Date.parse(stage.reversalAt)) || !Number.isFinite(Date.parse(receivedAt)))
    throw new Error('重新入庫時間關聯不完整，請重新整理。');
  return { name: 'reenter_receiving_inventory' as const,
    args: { p_request_id: requestId, p_reversal_receipt_id: stage.reversalReceiptId, p_quantity: quantity,
      p_entry_ids: entryIds, p_received_at: new Date(Math.max(Date.parse(receivedAt), Date.parse(stage.reversalAt))).toISOString(), p_notes: null } };
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
    const canceled = (('cancellations' in data ? data.cancellations : []) as ReceivingStageCancellation[])
      .filter(event => event.arrival_line_id === actual.line?.id)
      .reduce((sum, event) => sum + Number(event.quantity), 0);
    const net = Math.max(0, actual.quantity - actual.reversed - canceled);
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
    if (net > assigned || (actual.state === 'UNRESOLVED' && net > 0)) result.set(actual.key, {
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
