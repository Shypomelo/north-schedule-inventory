import type { TransactionType } from './types';

export const getInventoryTransactionQuantityDelta = (
  transactionType: TransactionType,
  quantity: number,
): number => {
  if (transactionType === 'IN' || transactionType === 'RETURN') return quantity;
  if (transactionType === 'OUT') return -quantity;
  if (transactionType === 'ADJUST') return quantity;
  return 0;
};

export const calculateInventoryStockQuantity = ({
  opening = 0,
  inQuantity = 0,
  outQuantity = 0,
  returnQuantity = 0,
  adjustQuantity = 0,
}: {
  opening?: number;
  inQuantity?: number;
  outQuantity?: number;
  returnQuantity?: number;
  adjustQuantity?: number;
}): number => {
  return opening + inQuantity - outQuantity + returnQuantity + adjustQuantity;
};
