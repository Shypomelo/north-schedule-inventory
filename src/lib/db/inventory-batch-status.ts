import type { InventorySerial, SerialStatus } from './types';

export type InventoryBatchUsageStatus =
  | '未使用'
  | '使用中'
  | '已用完'
  | '已作廢'
  | '待補序號'
  | '非序號品';

export interface InventoryBatchUsageSummary {
  status: InventoryBatchUsageStatus;
  serialQuantity: number;
  usedQuantity: number;
  remainingQuantity: number;
  pendingQuantity: number;
}

const EXCLUDED_SERIAL_STATUSES = new Set<SerialStatus>(['作廢', '待補']);

export function isEffectiveInventorySerial(serial: Pick<InventorySerial, 'status'>): boolean {
  return !EXCLUDED_SERIAL_STATUSES.has(serial.status);
}

export function getInventoryBatchUsageSummary({
  batchQuantity,
  requiresSerial,
  isVoided,
  serials,
}: {
  batchQuantity: number;
  requiresSerial: boolean;
  isVoided: boolean;
  serials: Array<Pick<InventorySerial, 'status'>>;
}): InventoryBatchUsageSummary {
  if (!requiresSerial) {
    return {
      status: '非序號品',
      serialQuantity: 0,
      usedQuantity: 0,
      remainingQuantity: 0,
      pendingQuantity: 0,
    };
  }

  const effectiveSerials = serials.filter(isEffectiveInventorySerial);
  const serialQuantity = effectiveSerials.length;
  const inStockQuantity = effectiveSerials.filter(serial => serial.status === '在庫').length;
  const usedQuantity = serialQuantity - inStockQuantity;

  if (isVoided) {
    return {
      status: '已作廢',
      serialQuantity,
      usedQuantity,
      remainingQuantity: 0,
      pendingQuantity: 0,
    };
  }

  const pendingQuantity = Math.max(0, batchQuantity - serialQuantity);

  if (serialQuantity === 0) {
    return {
      status: '待補序號',
      serialQuantity,
      usedQuantity,
      remainingQuantity: 0,
      pendingQuantity,
    };
  }

  const status: InventoryBatchUsageStatus = inStockQuantity === serialQuantity
    ? '未使用'
    : inStockQuantity === 0
      ? '已用完'
      : '使用中';

  return {
    status,
    serialQuantity,
    usedQuantity,
    remainingQuantity: inStockQuantity,
    pendingQuantity,
  };
}
