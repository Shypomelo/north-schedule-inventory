import * as XLSX from 'xlsx';
import type {
  InventoryItem,
  InventoryMonthlyClosingItem,
  InventorySerial,
  InventoryTransaction,
  InventoryTransactionSerial,
} from '../db/types';

export type MonthlyClosingExportStatus = 'CLOSED' | 'OPEN';

const MONTHLY_REPORT_FILE_PREFIX = '庫存月結';

const toExcelDate = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
};

export function buildMonthlyReportWorkbook(
  year: string,
  month: string,
  closingStatus: MonthlyClosingExportStatus,
  items: InventoryMonthlyClosingItem[],
  transactions: InventoryTransaction[],
  transactionSerials: InventoryTransactionSerial[] = [],
  serials: InventorySerial[] = [],
  inventoryItems: InventoryItem[] = [],
) {
  const workbook = XLSX.utils.book_new();
  const yearMonth = `${year}-${month}`;
  const monthlyTransactions = transactions
    .filter(transaction => transaction.transaction_date.substring(0, 7) === yearMonth)
    .sort((a, b) => (
      a.transaction_date.localeCompare(b.transaction_date)
      || a.created_at.localeCompare(b.created_at)
    ));

  const itemNameById = new Map(inventoryItems.map(item => [item.id, item.name]));
  items.forEach(item => itemNameById.set(item.inventory_item_id, item.item_name));
  const serialById = new Map(serials.map(serial => [serial.id, serial.serial_number]));
  const serialsByTransaction = new Map<string, string[]>();

  transactionSerials.forEach(link => {
    const serialNumber = link.serial_no
      || (link.serial_id ? serialById.get(link.serial_id) : null)
      || (link.is_pending ? '待補序號' : '');
    if (!serialNumber) return;

    const values = serialsByTransaction.get(link.transaction_id) || [];
    values.push(serialNumber);
    serialsByTransaction.set(link.transaction_id, values);
  });

  const rows: unknown[][] = [
    ['報表年月', yearMonth],
    ['月結狀態', closingStatus === 'CLOSED' ? '已封存' : '未封存'],
    [],
    ['月結／庫存統計'],
    ['品項', '分類', '單位', '期初', '入庫', '退料', '出庫', '調整', '期末', '來源', '品項狀態', '備註'],
    ...items.map(item => [
      item.item_name,
      item.stock_category,
      item.unit,
      item.opening_quantity,
      item.monthly_in,
      item.monthly_return,
      item.monthly_out,
      item.monthly_adjust,
      item.closing_quantity,
      item.source,
      item.status,
      item.notes || '',
    ]),
    [],
    ['當月異動明細'],
    ['日期', '異動類型', '品項', '數量', '案場', '序號', '備註', '是否作廢'],
    ...monthlyTransactions.map(transaction => {
      return [
        toExcelDate(transaction.transaction_date),
        transaction.transaction_type,
        itemNameById.get(transaction.item_id) || '未知品項',
        transaction.quantity,
        transaction.project_name || '',
        (serialsByTransaction.get(transaction.id) || []).join('、'),
        transaction.notes || '',
        transaction.is_voided ? '是' : '否',
      ];
    }),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  worksheet['!cols'] = [
    { wch: 24 },
    { wch: 14 },
    { wch: 24 },
    { wch: 12 },
    { wch: 24 },
    { wch: 34 },
    { wch: 36 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 28 },
  ];

  const transactionHeaderRow = 5 + items.length + 3;
  monthlyTransactions.forEach((_, index) => {
    const dateCell = worksheet[`A${transactionHeaderRow + index + 1}`];
    if (dateCell) dateCell.z = 'yyyy-mm-dd';
  });

  if (monthlyTransactions.length > 0) {
    worksheet['!autofilter'] = {
      ref: `A${transactionHeaderRow}:H${transactionHeaderRow + monthlyTransactions.length}`,
    };
  }

  XLSX.utils.book_append_sheet(workbook, worksheet, '月結與異動');

  return {
    workbook,
    fileName: `${MONTHLY_REPORT_FILE_PREFIX}_${yearMonth}.xlsx`,
  };
}

export function exportMonthlyReport(
  year: string,
  month: string,
  closingStatus: MonthlyClosingExportStatus,
  items: InventoryMonthlyClosingItem[],
  transactions: InventoryTransaction[],
  transactionSerials: InventoryTransactionSerial[],
  serials: InventorySerial[],
  inventoryItems: InventoryItem[],
) {
  const { workbook, fileName } = buildMonthlyReportWorkbook(
    year,
    month,
    closingStatus,
    items,
    transactions,
    transactionSerials,
    serials,
    inventoryItems,
  );

  XLSX.writeFile(workbook, fileName, { cellDates: true });
}
