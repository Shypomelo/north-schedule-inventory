import type { InventoryItem, InventorySerial } from './db/types';
import type { ReceivingSerialEntry } from './db/receiving-routing';
import { validateReceivingRawSerial } from './db/receiving-routing';
import { classifySerialFormat, deriveShortSerialKey, resolveInventorySerialLookupFromList } from './inventory-serial-normalization';

export interface SerialDraft { key: string; raw: string; canonical: string; entryId?: string; inventorySerialId?: string }
export interface SerialContext {
  item: Pick<InventoryItem, 'id' | 'requires_serial'>;
  serials: InventorySerial[];
  entries: ReceivingSerialEntry[];
  drafts: SerialDraft[];
  selected?: string[];
  capacity: number;
  receiving?: boolean;
}
export type SerialResult = { status: 'valid'; value: SerialDraft } | { status: 'duplicate' | 'invalid' | 'conflict' | 'cap'; message: string };
export const parseSerialBatch = (text: string): string[] => text.split(/[\r\n\t,]+/).map(s => s.trim()).filter(Boolean);
const sameSerial = (a: string, b: string) => a === b || Boolean(deriveShortSerialKey(a) && deriveShortSerialKey(a) === deriveShortSerialKey(b));

// Read-only resolver shared by camera, manual input and batch preview. Never changes canonical identities.
export function resolveReceivingSerial(raw: string, context: SerialContext): SerialResult {
  if (!context.item.requires_serial) return { status: 'invalid', message: '此品項不需要序號' };
  let canonical: string;
  try { canonical = validateReceivingRawSerial(raw); } catch { return { status: 'invalid', message: '序號格式無法辨識' }; }
  const lookup = resolveInventorySerialLookupFromList(raw, context.serials, { itemId: context.item.id, allowedStatuses: ['在庫'] });
  if (lookup.result_type === 'filtered_out') return { status: 'conflict', message: `序號屬於其他品項或狀態為 ${lookup.candidates[0]?.status}` };
  if (!['no_match', 'unique_match'].includes(lookup.result_type)) return { status: 'conflict', message: '序號身份衝突，請確認完整序號' };
  const identity = lookup.result_type === 'unique_match' ? lookup.candidates[0] : undefined;
  if (identity) canonical = identity.normalized_full || validateReceivingRawSerial(identity.serial_number);
  if (!identity && classifySerialFormat(canonical) === 'short') {
    const known = [...context.entries.filter(e => !e.retired_at).map(e => e.normalized_serial), ...context.drafts.map(d => d.canonical)]
      .filter(value => sameSerial(value, canonical));
    const identities = Array.from(new Set(known));
    if (identities.length > 1) return { status: 'conflict', message: '序號身份衝突，請確認完整序號' };
    if (identities.length === 1) canonical = identities[0];
  }
  const matching = context.entries.filter(e => !e.retired_at && sameSerial(e.normalized_serial, canonical));
  if (matching.length > 1) return { status: 'conflict', message: '待收序號身份衝突' };
  const entry = matching[0];
  if (entry && (entry.inventory_item_id !== context.item.id || entry.active_receipt_id)) return { status: 'conflict', message: '序號已收貨或品項不符' };
  if (entry && entry.normalized_serial !== canonical) return { status: 'conflict', message: '待收序號與完整身份不符，請先確認' };
  const draft = context.drafts.find(d => sameSerial(d.canonical, canonical));
  if (draft && draft.canonical !== canonical) return { status: 'conflict', message: '序號身份衝突，請確認完整序號' };
  const value: SerialDraft = draft || { key: entry?.id || canonical, raw, canonical, entryId: entry?.id, inventorySerialId: identity?.id };
  if (context.receiving ? context.selected?.includes(value.key) : Boolean(entry || draft)) return { status: 'duplicate', message: '已掃過此序號' };
  const count = context.receiving ? context.selected?.length || 0 : context.entries.length + context.drafts.length;
  if (!Number.isInteger(context.capacity) || context.capacity < 1 || count >= context.capacity) return { status: 'cap', message: `已達設定數量 ${context.capacity}` };
  // A newly discovered identity also consumes a pending slot, even when fewer entries are selected.
  if (context.receiving && !entry && !draft && context.entries.filter(e => !e.active_receipt_id).length + context.drafts.length >= context.capacity) return { status: 'cap', message: '已達待收序號數量，請先移除未到貨的預登序號' };
  return { status: 'valid', value };
}

export function previewSerialBatch(text: string, context: SerialContext) {
  const rows: { raw: string; result: SerialResult }[] = [];
  const next = { ...context, drafts: [...context.drafts], selected: [...context.selected || []] };
  for (const raw of parseSerialBatch(text)) {
    const result = resolveReceivingSerial(raw, next);
    rows.push({ raw, result });
    if (result.status === 'valid') {
      if (!result.value.entryId && !next.drafts.some(d => d.key === result.value.key)) next.drafts.push(result.value);
      if (next.receiving) next.selected.push(result.value.key);
    }
  }
  return rows;
}
