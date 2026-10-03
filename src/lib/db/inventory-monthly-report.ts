import type {
  InventoryItem,
  InventoryMonthlyClosing,
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

export interface InventoryMonthlyInitializationBaseline {
  inventory_item_id: string;
  baseline_date: string;
  initialized_at: string;
}

// PostgreSQL date boundaries, independent of the browser's timezone.
const monthEnd = (year: string, month: string): string => (
  new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10)
);

interface CalculateMonthlyReportOptions extends InventoryYearMonth {
  items: readonly InventoryItem[];
  transactions: readonly InventoryTransaction[];
  previousClosingItems?: readonly InventoryMonthlyClosingItem[] | null;
  previousClosing?: InventoryMonthlyClosing | null;
  initializationBaselines?: readonly InventoryMonthlyInitializationBaseline[];
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
  previousClosing = null,
  initializationBaselines = [],
}: CalculateMonthlyReportOptions): InventoryMonthlyClosingItem[] => {
  const targetMonth = `${year}-${month}`;
  const targetMonthEnd = monthEnd(year, month);
  const previousMonth = previousClosing || getPreviousInventoryYearMonth(year, month);
  const previousMonthEnd = monthEnd(previousMonth.year, previousMonth.month);
  const baselineByItemId = new Map<string, InventoryMonthlyInitializationBaseline>();
  initializationBaselines.forEach(baseline => {
    if (baseline.baseline_date > targetMonthEnd) return;
    const existing = baselineByItemId.get(baseline.inventory_item_id);
    if (!existing || baseline.baseline_date > existing.baseline_date
      || (baseline.baseline_date === existing.baseline_date
        && Date.parse(baseline.initialized_at) > Date.parse(existing.initialized_at))) {
      baselineByItemId.set(baseline.inventory_item_id, baseline);
    }
  });
  const previousClosingQuantityByItemId = new Map(
    (previousClosingItems || [])
      .filter(item => Boolean(item.inventory_item_id))
      .filter(item => {
        const baseline = baselineByItemId.get(item.inventory_item_id);
        if (!baseline) return true;
        // A preserved snapshot at/before the reset boundary belongs to the old
        // baseline even when it was sealed later. A later month's snapshot can
        // resume the chain, provided it was actually sealed after initialization.
        return previousMonthEnd > baseline.baseline_date
          && (!previousClosing || Date.parse(previousClosing.closed_at) >= Date.parse(baseline.initialized_at));
      })
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
      monthly_in_reversal: 0,
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
    const baseline = baselineByItemId.get(transaction.item_id);
    // Match enforce_inventory_cutoff_guard: the baseline date is inclusive.
    // Do not filter on created_at: a valid post-reset row may be backdated.
    if (baseline && transaction.transaction_date <= baseline.baseline_date) return;

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

    if (transaction.transaction_type === 'IN_REVERSAL') {
      row.monthly_in_reversal += transaction.quantity;
    }

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
        inReversalQuantity: row.monthly_in_reversal,
        outQuantity: row.monthly_out,
        adjustQuantity: row.monthly_adjust,
      }),
    }))
    .filter(row => (
      row.opening_quantity !== 0
      || row.monthly_in !== 0
      || row.monthly_in_reversal !== 0
      || row.monthly_out !== 0
      || row.monthly_return !== 0
      || row.monthly_adjust !== 0
      || row.closing_quantity !== 0
    ))
    .sort((a, b) => a.item_name.localeCompare(b.item_name));
};
