import { normalizeSerialInput } from './inventory-serial-normalization';
import { classifyScannerCode } from './receiving-scanner-session';
import { receivingPendingList, type ReceivingV6Snapshot } from './receiving-v6';
import { linkedPendingKeys, type SEOrderView } from './se-partner-view';

export type ReceivingScanLocation =
  | { kind: 'PENDING'; keys: string[]; exact: boolean; raw: string }
  | { kind: 'HISTORY'; lineIds: string[]; raw: string }
  | { kind: 'SE_ORDER'; orderNos: string[]; pendingKeys: string[]; exact: boolean; raw: string }
  | { kind: 'UNMATCHED'; raw: string };

/** Locates records only. This function never creates an arrival or posts Inventory. */
export function locateReceivingScan(raw: string, data: ReceivingV6Snapshot, orders: SEOrderView[]): ReceivingScanLocation {
  const normalized = normalizeSerialInput(raw);
  if (!normalized) return { kind: 'UNMATCHED', raw };
  const arrived = data.observations.filter(value => value.arrival_line_id && normalizeSerialInput(value.normalized_serial) === normalized);
  if (arrived.length) return { kind: 'HISTORY', lineIds: Array.from(new Set(arrived.map(value => value.arrival_line_id!))), raw };
  const pending = receivingPendingList(data);
  const bySerial = pending.filter(row => row.observations.some(value => normalizeSerialInput(value.normalized_serial) === normalized));
  if (bySerial.length) return { kind: 'PENDING', keys: bySerial.map(row => row.key), exact: bySerial.length === 1, raw };
  const tracking = orders.filter(view => view.order?.trackingNos.some(no => normalizeSerialInput(no) === normalized));
  if (tracking.length) {
    const pendingKeys = Array.from(new Set(tracking.flatMap(view => linkedPendingKeys(view, pending))));
    return { kind: 'SE_ORDER', orderNos: tracking.map(view => view.orderNo), pendingKeys,
      exact: tracking.length === 1 && pendingKeys.length === 1, raw };
  }
  const classification = classifyScannerCode(raw, data.items);
  if (classification.kind === 'MODEL' || classification.kind === 'MODEL_CANDIDATE') {
    const items = data.items.filter(item => normalizeSerialInput(item.code) === normalized);
    const keys = pending.filter(row => row.itemId && items.some(item => item.id === row.itemId)).map(row => row.key);
    if (keys.length) return { kind: 'PENDING', keys, exact: false, raw };
  }
  return { kind: 'UNMATCHED', raw };
}
