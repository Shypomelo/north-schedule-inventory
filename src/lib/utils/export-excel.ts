import * as XLSX from 'xlsx';
import { InventoryMonthlyClosingItem, InventoryTransaction } from '../db/types';

export type MonthlyClosingExportStatus = 'CLOSED' | 'OPEN';

const MONTHLY_REPORT_FILE_PREFIX = '庫存月結';

const createReportWorksheet = (
  yearMonth: string,
  closingStatus: MonthlyClosingExportStatus,
  rows: Record<string, unknown>[],
  columnWidths: number[],
): XLSX.WorkSheet => {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['報表年月', yearMonth],
    ['月結狀態', closingStatus === 'CLOSED' ? '已封存' : '未封存'],
    [],
  ]);

  XLSX.utils.sheet_add_json(worksheet, rows, { origin: 'A4' });
  worksheet['!cols'] = columnWidths.map(width => ({ wch: width }));

  if (rows.length > 0 && columnWidths.length > 0) {
    worksheet['!autofilter'] = {
      ref: `A4:${XLSX.utils.encode_col(columnWidths.length - 1)}${rows.length + 4}`,
    };
  }

  return worksheet;
};

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
) {
  const workbook = XLSX.utils.book_new();
  const yearMonth = `${year}-${month}`;
  const monthlyTransactions = transactions.filter(
    transaction => transaction.transaction_date.substring(0, 7) === yearMonth,
  );

  // Sheet A: 月結總表。items 就是畫面使用的 displayData：
  // CLOSED 為 snapshot，OPEN/未封存為即時計算結果。
  const sheetAData = items.map(item => ({
    '品項': item.item_name,
    '分類': item.stock_category,
    '單位': item.unit,
    '期初': item.opening_quantity,
    '入庫': item.monthly_in,
    '退料': item.monthly_return,
    '出庫': item.monthly_out,
    '調整': item.monthly_adjust,
    '期末': item.closing_quantity,
    '來源': item.source,
    '品項狀態': item.status,
    '備註': item.notes || '',
  }));
  const worksheetA = createReportWorksheet(
    yearMonth,
    closingStatus,
    sheetAData,
    [24, 14, 10, 12, 12, 12, 12, 12, 12, 14, 12, 28],
  );
  XLSX.utils.book_append_sheet(workbook, worksheetA, '月結總表');

  // Sheet B: 使用量統計
  const usageMap: Record<string, { category: string; source: string; name: string; qty: number; unit: string }> = {};
  items.forEach(item => {
    if (item.monthly_out > 0) {
      const key = `${item.source}_${item.item_name}`;
      if (!usageMap[key]) {
        usageMap[key] = {
          category: item.stock_category,
          source: item.source,
          name: item.item_name,
          qty: 0,
          unit: item.unit,
        };
      }
      usageMap[key].qty += item.monthly_out;
    }
  });
  const sheetBData = Object.values(usageMap)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(item => ({
      '品項': item.name,
      '來源': item.source,
      '本月出庫數量': item.qty,
      '單位': item.unit,
    }));
  const worksheetB = createReportWorksheet(
    yearMonth,
    closingStatus,
    sheetBData,
    [24, 14, 16, 10],
  );
  XLSX.utils.book_append_sheet(workbook, worksheetB, '使用量統計');

  // Sheet C: 案場用料統計。作廢 OUT 不計入。
  const projectUsageMap: Record<string, { project: string; name: string; qty: number; unit: string; handler: string; notes: string }> = {};
  monthlyTransactions
    .filter(transaction => transaction.transaction_type === 'OUT' && !transaction.is_voided)
    .forEach(transaction => {
      const projectName = transaction.project_name || '未指定案場';
      const itemInfo = items.find(item => item.inventory_item_id === transaction.item_id);
      const itemName = itemInfo?.item_name || '未知品項';
      const unit = itemInfo?.unit || transaction.unit || '';
      const key = `${projectName}_${itemName}`;

      if (!projectUsageMap[key]) {
        projectUsageMap[key] = {
          project: projectName,
          name: itemName,
          qty: 0,
          unit,
          handler: transaction.handler || '',
          notes: transaction.notes || '',
        };
      }
      projectUsageMap[key].qty += transaction.quantity;

      if (transaction.handler && !projectUsageMap[key].handler.includes(transaction.handler)) {
        projectUsageMap[key].handler += `${projectUsageMap[key].handler ? ', ' : ''}${transaction.handler}`;
      }
      if (transaction.notes && !projectUsageMap[key].notes.includes(transaction.notes)) {
        projectUsageMap[key].notes += `${projectUsageMap[key].notes ? '; ' : ''}${transaction.notes}`;
      }
    });
  const sheetCData = Object.values(projectUsageMap)
    .sort((a, b) => a.project.localeCompare(b.project))
    .map(item => ({
      '案場': item.project,
      '品項': item.name,
      '出庫數量': item.qty,
      '單位': item.unit,
      '領料人': item.handler,
      '備註': item.notes,
    }));
  const worksheetC = createReportWorksheet(
    yearMonth,
    closingStatus,
    sheetCData,
    [24, 24, 14, 10, 14, 30],
  );
  XLSX.utils.book_append_sheet(workbook, worksheetC, '案場用料統計');

  // Sheet D: 流水明細。沿用既有最小規則：作廢紀錄不匯出。
  const sheetDData = monthlyTransactions
    .filter(transaction => !transaction.is_voided)
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))
    .map(transaction => {
      const itemInfo = items.find(item => item.inventory_item_id === transaction.item_id);
      let typeLabel = '';
      if (transaction.transaction_type === 'IN') typeLabel = '入庫';
      if (transaction.transaction_type === 'OUT') typeLabel = '出庫';
      if (transaction.transaction_type === 'RETURN') typeLabel = '退料';
      if (transaction.transaction_type === 'ADJUST') typeLabel = '調整';

      return {
        '日期': toExcelDate(transaction.transaction_date),
        '類型': typeLabel,
        '分類': itemInfo?.stock_category || '',
        '來源': itemInfo?.source || transaction.source || '',
        '品項': itemInfo?.item_name || '未知品項',
        '數量': transaction.quantity,
        '單位': itemInfo?.unit || transaction.unit || '',
        '案場': transaction.project_name || '',
        '經手人': transaction.handler || '',
        '備註': transaction.notes || '',
      };
    });
  const worksheetD = createReportWorksheet(
    yearMonth,
    closingStatus,
    sheetDData,
    [12, 10, 14, 14, 24, 12, 10, 24, 14, 30],
  );
  sheetDData.forEach((_, index) => {
    const dateCell = worksheetD[`A${index + 5}`];
    if (dateCell) dateCell.z = 'yyyy-mm-dd';
  });
  XLSX.utils.book_append_sheet(workbook, worksheetD, '流水明細');

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
) {
  const { workbook, fileName } = buildMonthlyReportWorkbook(
    year,
    month,
    closingStatus,
    items,
    transactions,
  );

  XLSX.writeFile(workbook, fileName, { cellDates: true });
}
