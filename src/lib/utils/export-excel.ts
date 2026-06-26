import * as XLSX from 'xlsx';
import { InventoryMonthlyClosingItem, InventoryTransaction } from '../db/types';

export function exportMonthlyReport(
  year: string,
  month: string,
  items: InventoryMonthlyClosingItem[],
  transactions: InventoryTransaction[]
) {
  const wb = XLSX.utils.book_new();
  const yearMonth = `${year}-${month}`;

  // Sheet A: 月結總表
  const sheetAData = items.map(item => ({
    '分類': item.stock_category,
    '來源': item.source,
    '品名': item.item_name,
    '月初庫存': item.opening_quantity,
    '本月入庫': item.monthly_in,
    '本月出庫': item.monthly_out,
    '本月退料': item.monthly_return,
    '本月調整': item.monthly_adjust,
    '月末庫存': item.closing_quantity,
    '單位': item.unit,
    '狀態': item.status,
    '備註': item.notes || ''
  }));
  const wsA = XLSX.utils.json_to_sheet(sheetAData);
  XLSX.utils.book_append_sheet(wb, wsA, '月結總表');

  // Sheet B: 使用量統計
  // Group by item_name + source
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
          unit: item.unit
        };
      }
      usageMap[key].qty += item.monthly_out;
    }
  });
  const sheetBData = Object.values(usageMap)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(item => ({
      '品名': item.name,
      '來源': item.source,
      '本月出庫數量': item.qty,
      '單位': item.unit
    }));
  const wsB = XLSX.utils.json_to_sheet(sheetBData);
  XLSX.utils.book_append_sheet(wb, wsB, '使用量統計');

  // Sheet C: 案場用料統計
  const projectUsageMap: Record<string, { project: string; name: string; qty: number; unit: string; handler: string; notes: string }> = {};
  transactions.filter(tx => tx.transaction_type === 'OUT' && !tx.is_voided).forEach(tx => {
    const projName = tx.project_name || '未指定案場';
    const itemInfo = items.find(i => i.inventory_item_id === tx.item_id);
    const itemName = itemInfo?.item_name || '未知品項';
    const unit = itemInfo?.unit || tx.unit || '';
    
    const key = `${projName}_${itemName}`;
    if (!projectUsageMap[key]) {
      projectUsageMap[key] = {
        project: projName,
        name: itemName,
        qty: 0,
        unit: unit,
        handler: tx.handler || '',
        notes: tx.notes || ''
      };
    }
    projectUsageMap[key].qty += tx.quantity;
    
    // Concatenate unique notes/handlers
    if (tx.handler && !projectUsageMap[key].handler.includes(tx.handler)) {
      projectUsageMap[key].handler += (projectUsageMap[key].handler ? ', ' : '') + tx.handler;
    }
    if (tx.notes && !projectUsageMap[key].notes.includes(tx.notes)) {
      projectUsageMap[key].notes += (projectUsageMap[key].notes ? '; ' : '') + tx.notes;
    }
  });
  const sheetCData = Object.values(projectUsageMap)
    .sort((a, b) => a.project.localeCompare(b.project))
    .map(item => ({
      '案場': item.project,
      '品名': item.name,
      '出庫數量': item.qty,
      '單位': item.unit,
      '領料人': item.handler,
      '備註': item.notes
    }));
  const wsC = XLSX.utils.json_to_sheet(sheetCData);
  XLSX.utils.book_append_sheet(wb, wsC, '案場用料統計');

  // Sheet D: 流水明細
  const sheetDData = transactions
    .filter(tx => !tx.is_voided)
    .sort((a, b) => new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime())
    .map(tx => {
      const itemInfo = items.find(i => i.inventory_item_id === tx.item_id);
      let typeLabel = '';
      if (tx.transaction_type === 'IN') typeLabel = '入庫';
      if (tx.transaction_type === 'OUT') typeLabel = '出庫';
      if (tx.transaction_type === 'RETURN') typeLabel = '退料';
      if (tx.transaction_type === 'ADJUST') typeLabel = '調整';

      return {
        '日期': tx.transaction_date,
        '類型': typeLabel,
        '分類': itemInfo?.stock_category || '',
        '來源': itemInfo?.source || tx.source || '',
        '品名': itemInfo?.item_name || '未知品項',
        '數量': tx.quantity,
        '單位': itemInfo?.unit || tx.unit || '',
        '案場': tx.project_name || '',
        '經手人': tx.handler || '',
        '備註': tx.notes || ''
      };
    });
  const wsD = XLSX.utils.json_to_sheet(sheetDData);
  XLSX.utils.book_append_sheet(wb, wsD, '流水明細');

  // Generate file and trigger download
  XLSX.writeFile(wb, `庫存月結報表_${yearMonth}.xlsx`);
}
