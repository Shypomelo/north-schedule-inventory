import type { TransactionType } from './types';

export const getInventoryTransactionQuantityDelta = (
  transactionType: TransactionType | string,
  quantity: number,
): number => {
  if (transactionType === 'IN' || transactionType === 'RETURN') return quantity;
  if (transactionType === 'TRANSFER_IN') return quantity;
  if (transactionType === 'TRANSFER_OUT') return -quantity;
  if (transactionType === 'OUT') return -quantity;
  if (transactionType === 'ADJUST') return quantity;
  return 0;
};

export const isInventoryInflowTransactionType = (
  transactionType: TransactionType | string,
): boolean => {
  return transactionType === 'IN' || transactionType === 'RETURN' || transactionType === 'TRANSFER_IN';
};

export const getInventoryInflowQuantity = (
  transactionType: TransactionType | string,
  quantity: number,
): number => {
  return isInventoryInflowTransactionType(transactionType) ? quantity : 0;
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
