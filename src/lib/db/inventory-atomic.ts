import type { InventoryTransaction, InventoryTransactionSerial } from './types';

export type InventoryCountInput = { counted_quantity?: number; expected_balance?: number; expected_updated_at?: string };
export function inventorySerialInputs(input: string) {
  return input.split(/[\n,]+/).map(value => value.trim()).filter(Boolean)
    .map(serial_no => ({ serial_no, serial_id: null, is_pending: false }));
}

export function inventoryWriteError(error: unknown): Error {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  if (message.includes('STALE_INVENTORY')) return new Error('庫存已在盤點期間發生異動，請重新載入後再確認。');
  if (message.includes('INSUFFICIENT_INVENTORY')) return new Error('庫存不足，此次異動未儲存，請重新載入後再確認。');
  return new Error(message);
}

export function createInventoryAtomicWriter(client: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{data: unknown; error: unknown}> }) {
  return async (action: 'CREATE' | 'EDIT' | 'VOID', data: Partial<InventoryTransaction> & InventoryCountInput = {},
    serials: Pick<InventoryTransactionSerial, 'serial_no'>[] = [], id: string | null = null, reason: string | null = null) => {
    const { expected_updated_at, ...payload } = data;
    const result = await client.rpc('write_inventory_transaction_atomic', {
      p_action: action, p_data: payload, p_serials: serials.map(serial => serial.serial_no),
      p_transaction_id: id, p_reason: reason, p_expected_updated_at: expected_updated_at || null,
    });
    if (result.error) throw inventoryWriteError(result.error);
    if (!result.data) throw new Error('Inventory write returned no result');
    return result.data;
  };
}
