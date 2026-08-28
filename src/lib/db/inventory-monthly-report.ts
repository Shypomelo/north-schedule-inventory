import type {
  InventoryItem,
  InventoryMonthlyClosingItem,
  InventoryTransaction,
} from './types';
import {
  calculateInventoryStockQuantity,
  getInventoryInflowQuantity,
  getInventoryTransactionQuantityDelta,
} from './inventory-stock';
import { isActiveFormalTransaction } from './types';

export interface InventoryYearMonth {
  year: string;
  month: string;
}

interface CalculateMonthlyReportOptions extends InventoryYearMonth {
  items: readonly InventoryItem[];
  transactions: readonly InventoryTransaction[];
  previousClosingItems?: readonly InventoryMonthlyClosingItem[] | null;
}

export const getPreviousInventoryYearMonth = (
  year: string,
  month: string,
): InventoryYearMonth => {
  const numericYear = Number.parseInt(year, 10);
  const numericMonth = Number.parseInt(month, 10);

  if (numericMonth === 1) {
    return { year: String(numericYear - 1), month: '12' };
  }

  return {
    year: String(numericYear),
    month: String(numericMonth - 1).padStart(2, '0'),
  };
};

export const calculateInventoryMonthlyReport = ({
  year,
  month,
  items,
  transactions,
  previousClosingItems = null,
}: CalculateMonthlyReportOptions): InventoryMonthlyClosingItem[] => {
  const targetMonth = `${year}-${month}`;
  const previousClosingQuantityByItemId = new Map(
    (previousClosingItems || [])
      .filter(item => Boolean(item.inventory_item_id))
      .map(item => [item.inventory_item_id, item.closing_quantity]),
  );
  const rows: Record<string, InventoryMonthlyClosingItem> = {};

  items.forEach(item => {
    const hasPreviousSnapshot = previousClosingQuantityByItemId.has(item.id);

    rows[item.id] = {
      id: '',
      closing_id: '',
      inventory_item_id: item.id,
      stock_category: item.category || '',
      source: item.source_type || '',
      item_name: item.name,
      item_type: item.item_category || '',
      unit: item.unit,
      opening_quantity: hasPreviousSnapshot
        ? previousClosingQuantityByItemId.get(item.id) ?? 0
        : item.opening_quantity || 0,
      monthly_in: 0,
      monthly_out: 0,
      monthly_return: 0,
      monthly_adjust: 0,
      closing_quantity: 0,
      usage_quantity: 0,
      status: item.is_active ? '啟用' : '停用',
      notes: item.notes || '',
    };
  });

  transactions.forEach(transaction => {
    if (!isActiveFormalTransaction(transaction)) return;

    // transaction_date is a PostgreSQL date serialized as YYYY-MM-DD.
    // Comparing its YYYY-MM prefix avoids timezone conversion at month boundaries.
    const transactionMonth = transaction.transaction_date.substring(0, 7);
    const isBeforeTargetMonth = transactionMonth < targetMonth;
    const isTargetMonth = transactionMonth === targetMonth;

    if (!isBeforeTargetMonth && !isTargetMonth) return;

    const row = rows[transaction.item_id];
    if (!row) return;

    if (isBeforeTargetMonth) {
      if (!previousClosingQuantityByItemId.has(transaction.item_id)) {
        row.opening_quantity += getInventoryTransactionQuantityDelta(
          transaction.transaction_type,
          transaction.quantity,
        );
      }
      return;
    }

    row.monthly_in += getInventoryInflowQuantity(
      transaction.transaction_type,
      transaction.quantity,
    );

    if (transaction.transaction_type === 'OUT') {
      row.monthly_out += transaction.quantity;
      row.usage_quantity += transaction.quantity;
    }
    if (transaction.transaction_type === 'RETURN') {
      row.monthly_return += transaction.quantity;
    }
    if (transaction.transaction_type === 'ADJUST') {
      row.monthly_adjust += transaction.quantity;
    }
  });

  return Object.values(rows)
    .map(row => ({
      ...row,
      closing_quantity: calculateInventoryStockQuantity({
        opening: row.opening_quantity,
        inQuantity: row.monthly_in,
        outQuantity: row.monthly_out,
        adjustQuantity: row.monthly_adjust,
      }),
    }))
    .filter(row => (
      row.opening_quantity !== 0
      || row.monthly_in !== 0
      || row.monthly_out !== 0
      || row.monthly_return !== 0
      || row.monthly_adjust !== 0
      || row.closing_quantity !== 0
    ))
    .sort((a, b) => a.item_name.localeCompare(b.item_name));
};
