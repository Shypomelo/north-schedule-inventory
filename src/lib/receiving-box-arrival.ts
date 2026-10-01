import type { InventorySerialLookupResult } from './db/types';
import type { ScanBox } from './receiving-box-session';
import { finishSerialDraft, pendingSerialDraft } from './receiving-v6';
import { serialsAlias, type PendingRow, type ReceivingSnapshot } from './receiving-v5';
import { normalizeSerialInput } from './inventory-serial-normalization';

/** Read-only lookup. Model hints are scoped to the serial's box, never the batch. */
export async function resolveBoxArrival(boxes: ScanBox[], data: ReceivingSnapshot,
  lookupBatch: (serials: string[]) => Promise<InventorySerialLookupResult[]>, preferred?: PendingRow,
  activeArrivalSerials?: (serials: string[]) => Promise<string[]>) {
  const entries = boxes.flatMap(box => box.serials.map(serial => ({ serial, model: box.model })));
  if (entries.some((entry, index) => entries.slice(0, index).some(other => serialsAlias(entry.serial.normalized, other.serial.normalized)))) throw new Error('箱內有重複序號，請返回掃描確認。');
  const serials = entries.map(e => e.serial.normalized);
  const [lookups, active] = await Promise.all([lookupBatch(serials), activeArrivalSerials?.(serials) || Promise.resolve([])]);
  if (lookups.length !== entries.length) throw new Error('序號查詢結果不完整，請重試。');
  const activeKeys = new Set(active.map(normalizeSerialInput));
  return entries.map(({ serial, model }, index) => {
    const raw = serial.normalized;
    // A box model cannot inherit a different preferred item's automatic hint.
    const boxPreferred = !model || model.itemId === preferred?.itemId ? preferred : undefined;
    let draft = finishSerialDraft(pendingSerialDraft(raw, data, preferred?.projectId), lookups[index], data, boxPreferred);
    if (activeKeys.has(normalizeSerialInput(raw))) draft = { ...draft, itemId: null, state: 'conflict', pendingKey: null, choiceRequired: false };
    const item = data.items.find(i => i.id === model?.itemId && i.is_active && i.requires_serial);
    if (item && draft.itemId && draft.itemId !== item.id) return { ...draft, itemId: null, state: 'conflict' as const, pendingKey: null, choiceRequired: false };
    if (item && draft.state === 'unknown' && !draft.candidates.length) draft = { ...draft, itemId: item.id, state: 'known' };
    if (boxPreferred && !draft.candidates.length && draft.state === 'known' && draft.itemId === boxPreferred.itemId) draft = { ...draft, pendingKey: boxPreferred.key };
    return draft;
  });
}
