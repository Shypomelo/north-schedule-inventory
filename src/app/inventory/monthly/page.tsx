"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { InventoryTransaction, InventoryItem, InventoryMonthlyClosing, InventoryMonthlyClosingItem } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { format, subMonths } from 'date-fns';
import { FileSpreadsheet, Lock, Unlock, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { exportMonthlyReport } from '@/lib/utils/export-excel';

export default function MonthlyReportPage() {
  const [viewMode, setViewMode] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const [selectedYear, setSelectedYear] = useState(format(new Date(), 'yyyy'));
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'MM'));
  
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [closings, setClosings] = useState<InventoryMonthlyClosing[]>([]);
  const [closingItems, setClosingItems] = useState<InventoryMonthlyClosingItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    const [i, t, c] = await Promise.all([
      dbAdapter.getInventoryItems(),
      dbAdapter.getInventoryTransactions(),
      dbAdapter.getMonthlyClosings()
    ]);
    setItems(i);
    setTransactions(t);
    setClosings(c);
    setIsLoading(false);
  }

  // Find if current selected month is closed
  const currentClosing = useMemo(() => {
    return closings.find(c => c.year === selectedYear && c.month === selectedMonth);
  }, [closings, selectedYear, selectedMonth]);

  // Load closing items if closed
  useEffect(() => {
    if (currentClosing) {
      dbAdapter.getMonthlyClosingItems(currentClosing.id).then(setClosingItems);
    } else {
      setClosingItems([]);
    }
  }, [currentClosing]);

  // Dynamically calculate for unclosed month
  const dynamicReportData = useMemo(() => {
    if (currentClosing) return []; // skip if closed
    
    const targetMonth = `${selectedYear}-${selectedMonth}`;
    const rows: Record<string, InventoryMonthlyClosingItem> = {};

    items.forEach(item => {
      rows[item.id] = {
        id: '',
        closing_id: '',
        inventory_item_id: item.id,
        stock_category: item.category || '',
        source: item.source_type || '',
        item_name: item.name,
        item_type: item.item_category || '',
        unit: item.unit,
        opening_quantity: item.opening_quantity || 0,
        monthly_in: 0,
        monthly_out: 0,
        monthly_return: 0,
        monthly_adjust: 0,
        closing_quantity: 0,
        usage_quantity: 0,
        status: item.is_active ? '啟用' : '停用',
        notes: item.notes || ''
      };
    });

    transactions.forEach(tx => {
      if (tx.is_voided) return;
      const txMonth = tx.transaction_date.substring(0, 7);
      const isBefore = txMonth < targetMonth;
      const isCurrent = txMonth === targetMonth;
      
      if (!isBefore && !isCurrent) return;

      const r = rows[tx.item_id];
      if (!r) return; // Item deleted? skip

      if (isBefore) {
        if (tx.transaction_type === 'IN') r.opening_quantity += tx.quantity;
        if (tx.transaction_type === 'OUT') r.opening_quantity -= tx.quantity;
        if (tx.transaction_type === 'RETURN') r.opening_quantity += tx.quantity;
        if (tx.transaction_type === 'ADJUST') r.opening_quantity += tx.quantity;
      } else if (isCurrent) {
        if (tx.transaction_type === 'IN') r.monthly_in += tx.quantity;
        if (tx.transaction_type === 'OUT') {
           r.monthly_out += tx.quantity;
           r.usage_quantity += tx.quantity;
        }
        if (tx.transaction_type === 'RETURN') r.monthly_return += tx.quantity;
        if (tx.transaction_type === 'ADJUST') r.monthly_adjust += tx.quantity;
      }
    });

    return Object.values(rows).map(r => {
      r.closing_quantity = r.opening_quantity + r.monthly_in - r.monthly_out + r.monthly_return + r.monthly_adjust;
      return r;
    }).filter(r => r.opening_quantity !== 0 || r.monthly_in !== 0 || r.monthly_out !== 0 || r.monthly_return !== 0 || r.monthly_adjust !== 0 || r.closing_quantity !== 0)
      .sort((a, b) => a.item_name.localeCompare(b.item_name));

  }, [currentClosing, selectedYear, selectedMonth, items, transactions]);

  const displayData = currentClosing ? closingItems : dynamicReportData;

  const handleCloseMonth = async () => {
    if (currentClosing) {
      const confirmReclose = window.confirm("此月份已封存，是否重新封存？這將覆蓋現有的封存紀錄。");
      if (!confirmReclose) return;
    }
    
    setIsLoading(true);
    await dbAdapter.createMonthlyClosing(
      {
        year: selectedYear,
        month: selectedMonth,
        closed_at: new Date().toISOString(),
        closed_by: '系統管理員', // Mock
        status: 'CLOSED',
        notes: null
      },
      dynamicReportData
    );
    await loadData();
    alert("封存完成");
  };

  const handleExport = () => {
    const targetMonth = `${selectedYear}-${selectedMonth}`;
    const txsInMonth = transactions.filter(tx => tx.transaction_date.substring(0, 7) === targetMonth);
    exportMonthlyReport(selectedYear, selectedMonth, displayData, txsInMonth);
  };

  // --- Annual Report Logic ---
  const annualData = useMemo(() => {
    if (viewMode !== 'ANNUAL') return [];
    
    // For each item, compute 1-12 month usage, total, and averages
    const rows: Record<string, any> = {};
    items.forEach(item => {
      rows[item.id] = {
        item,
        usage: Array(12).fill(0),
        total: 0,
        avg: 0,
        avg3m: 0,
        avg6m: 0,
        currentStock: item.opening_quantity || 0,
      };
    });

    transactions.forEach(tx => {
      if (tx.is_voided) return;
      const r = rows[tx.item_id];
      if (!r) return;

      if (tx.transaction_type === 'IN') r.currentStock += tx.quantity;
      if (tx.transaction_type === 'OUT') r.currentStock -= tx.quantity;
      if (tx.transaction_type === 'RETURN') r.currentStock += tx.quantity;
      if (tx.transaction_type === 'ADJUST') r.currentStock += tx.quantity;

      const txYear = tx.transaction_date.substring(0, 4);
      const txMonth = parseInt(tx.transaction_date.substring(5, 7), 10);
      
      if (txYear === selectedYear && tx.transaction_type === 'OUT') {
        r.usage[txMonth - 1] += tx.quantity;
        r.total += tx.quantity;
      }
    });

    const now = new Date();
    const threeMonthsAgoStr = format(subMonths(now, 3), 'yyyy-MM');
    const sixMonthsAgoStr = format(subMonths(now, 6), 'yyyy-MM');
    
    Object.values(rows).forEach(r => {
      r.sum3m = 0;
      r.sum6m = 0;
    });

    transactions.forEach(tx => {
      if (tx.is_voided || tx.transaction_type !== 'OUT') return;
      const r = rows[tx.item_id];
      if (!r) return;
      const ym = tx.transaction_date.substring(0, 7);
      if (ym >= threeMonthsAgoStr) r.sum3m += tx.quantity;
      if (ym >= sixMonthsAgoStr) r.sum6m += tx.quantity;
    });

    return Object.values(rows).map(r => {
      r.avg = r.total / 12;
      r.avg3m = r.sum3m / 3;
      r.avg6m = r.sum6m / 6;
      
      let monthsSupport = r.avg3m > 0 ? r.currentStock / r.avg3m : 999;
      if (r.currentStock <= 0 && r.avg3m > 0) monthsSupport = 0;
      
      let status = '正常';
      if (monthsSupport < 1) status = '備料不足';
      else if (monthsSupport <= 2) status = '需注意';

      r.supportStatus = status;
      r.monthsSupport = monthsSupport;
      return r;
    }).filter(r => r.total > 0 || r.currentStock > 0).sort((a,b) => a.item.name.localeCompare(b.item.name));
    
  }, [viewMode, selectedYear, transactions, items]);

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-full gap-4">
      <div className="flex justify-between items-center bg-slate-800 p-4 rounded-xl shadow border border-slate-700">
        <div className="flex gap-4">
          <button 
            className={`px-4 py-2 rounded-lg font-medium transition ${viewMode === 'MONTHLY' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
            onClick={() => setViewMode('MONTHLY')}
          >
            月結報表
          </button>
          <button 
            className={`px-4 py-2 rounded-lg font-medium transition ${viewMode === 'ANNUAL' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
            onClick={() => setViewMode('ANNUAL')}
          >
            年度報表 (預判)
          </button>
        </div>
      </div>

      {viewMode === 'MONTHLY' && (
        <div className="flex-1 flex flex-col gap-4 overflow-hidden">
          <div className="flex justify-between items-center bg-slate-800 p-4 rounded-xl border border-slate-700">
             <div className="flex items-center gap-4">
               <select 
                 value={selectedYear}
                 onChange={e => setSelectedYear(e.target.value)}
                 className="bg-slate-900 border border-slate-600 rounded p-2 text-slate-200 outline-none"
               >
                 {Array.from({length: 5}).map((_, i) => {
                   const y = (new Date().getFullYear() - 2 + i).toString();
                   return <option key={y} value={y}>{y} 年</option>;
                 })}
               </select>
               <select 
                 value={selectedMonth}
                 onChange={e => setSelectedMonth(e.target.value)}
                 className="bg-slate-900 border border-slate-600 rounded p-2 text-slate-200 outline-none"
               >
                 {Array.from({length: 12}).map((_, i) => {
                   const m = (i + 1).toString().padStart(2, '0');
                   return <option key={m} value={m}>{m} 月</option>;
                 })}
               </select>

               {currentClosing ? (
                 <span className="flex items-center gap-1 text-emerald-400 bg-emerald-400/10 px-3 py-1 rounded-full text-sm font-medium">
                   <Lock size={16} /> 已封存 ({format(new Date(currentClosing.closed_at), 'MM/dd HH:mm')})
                 </span>
               ) : (
                 <span className="flex items-center gap-1 text-amber-400 bg-amber-400/10 px-3 py-1 rounded-full text-sm font-medium">
                   <Unlock size={16} /> 未封存 (動態計算)
                 </span>
               )}
             </div>
             
             <div className="flex items-center gap-3">
               <button 
                 onClick={handleCloseMonth}
                 className={`flex items-center gap-2 px-4 py-2 rounded shadow transition ${currentClosing ? 'bg-slate-600 hover:bg-slate-500 text-slate-200' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}
               >
                 {currentClosing ? <Lock size={18} /> : <CheckCircle size={18} />}
                 {currentClosing ? '重新封存本月' : '封存本月'}
               </button>
               <button 
                 onClick={handleExport}
                 disabled={displayData.length === 0}
                 className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded shadow transition"
               >
                 <FileSpreadsheet size={18} />
                 匯出 Excel
               </button>
             </div>
          </div>

          <div className="flex-1 overflow-auto bg-slate-800/50 border border-slate-700 rounded-xl relative">
            {isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400">計算中...</div>
            ) : displayData.length === 0 ? (
               <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                 這個月份沒有任何庫存記錄與異動
               </div>
            ) : (
              <table className="w-full text-left border-collapse whitespace-nowrap">
                <thead className="bg-slate-800 text-slate-300 text-sm sticky top-0 z-10 border-b border-slate-700 shadow-sm">
                  <tr>
                    <th className="p-3 font-semibold">分類</th>
                    <th className="p-3 font-semibold">來源</th>
                    <th className="p-3 font-semibold">品名</th>
                    <th className="p-3 font-semibold text-right text-slate-400">月初</th>
                    <th className="p-3 font-semibold text-right text-emerald-400">入庫</th>
                    <th className="p-3 font-semibold text-right text-red-400">出庫</th>
                    <th className="p-3 font-semibold text-right text-indigo-400">退料</th>
                    <th className="p-3 font-semibold text-right text-amber-400">調整</th>
                    <th className="p-3 font-semibold text-right text-emerald-300 text-base border-l border-slate-600">月末</th>
                    <th className="p-3 font-semibold text-center text-slate-400 border-l border-slate-600">單位</th>
                    <th className="p-3 font-semibold">備註</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50 text-sm">
                  {displayData.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-700/30 transition-colors">
                      <td className="p-3 text-slate-400">{r.stock_category}</td>
                      <td className="p-3 text-slate-400">{r.source}</td>
                      <td className="p-3 text-slate-100 font-medium">{r.item_name}</td>
                      <td className="p-3 text-right text-slate-400">{r.opening_quantity}</td>
                      <td className="p-3 text-right text-emerald-400">{r.monthly_in}</td>
                      <td className="p-3 text-right text-red-400">{r.monthly_out}</td>
                      <td className="p-3 text-right text-indigo-400">{r.monthly_return}</td>
                      <td className="p-3 text-right text-amber-400">{r.monthly_adjust}</td>
                      <td className="p-3 text-right font-bold text-base text-emerald-300 border-l border-slate-700/50 bg-slate-800/20">{r.closing_quantity}</td>
                      <td className="p-3 text-center text-slate-500 border-l border-slate-700/50">{r.unit}</td>
                      <td className="p-3 text-slate-400 max-w-[150px] truncate" title={r.notes || ''}>{r.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {viewMode === 'ANNUAL' && (
         <div className="flex-1 flex flex-col gap-4 overflow-hidden">
           <div className="flex justify-between items-center bg-slate-800 p-4 rounded-xl border border-slate-700">
             <div className="flex items-center gap-4">
               <select 
                 value={selectedYear}
                 onChange={e => setSelectedYear(e.target.value)}
                 className="bg-slate-900 border border-slate-600 rounded p-2 text-slate-200 outline-none"
               >
                 {Array.from({length: 5}).map((_, i) => {
                   const y = (new Date().getFullYear() - 2 + i).toString();
                   return <option key={y} value={y}>{y} 年</option>;
                 })}
               </select>
               <span className="text-slate-400 text-sm flex items-center gap-2">
                 <Info size={16} />
                 年度使用量統計與未來備料預判
               </span>
             </div>
           </div>

           <div className="flex-1 overflow-auto bg-slate-800/50 border border-slate-700 rounded-xl relative">
             <table className="w-full text-left border-collapse whitespace-nowrap">
                <thead className="bg-slate-800 text-slate-300 text-xs sticky top-0 z-10 border-b border-slate-700 shadow-sm">
                  <tr>
                    <th className="p-3 font-semibold w-[200px] sticky left-0 bg-slate-800 z-20">品名</th>
                    <th className="p-3 font-semibold text-slate-400">來源</th>
                    {Array.from({length: 12}).map((_, i) => (
                      <th key={i} className="p-3 font-semibold text-center text-slate-400">{i+1}月</th>
                    ))}
                    <th className="p-3 font-semibold text-center text-indigo-300 border-l border-slate-600">總計</th>
                    <th className="p-3 font-semibold text-center text-emerald-400 border-l border-slate-600">目前庫存</th>
                    <th className="p-3 font-semibold text-center text-amber-300">近3月平均</th>
                    <th className="p-3 font-semibold text-center text-slate-300">狀態預判</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50 text-sm">
                  {annualData.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-700/30 transition-colors">
                      <td className="p-3 text-slate-100 font-medium sticky left-0 bg-slate-800/90 z-10 w-[200px] truncate" title={r.item.name}>{r.item.name}</td>
                      <td className="p-3 text-slate-400 text-xs">{r.item.source_type}</td>
                      {r.usage.map((u: number, mIdx: number) => (
                        <td key={mIdx} className={`p-3 text-center ${u > 0 ? 'text-red-300 font-medium' : 'text-slate-600'}`}>
                          {u || '-'}
                        </td>
                      ))}
                      <td className="p-3 text-center font-bold text-indigo-300 border-l border-slate-700/50 bg-slate-800/20">{r.total}</td>
                      <td className="p-3 text-center font-bold text-emerald-400 border-l border-slate-700/50 bg-slate-800/20">{r.currentStock}</td>
                      <td className="p-3 text-center font-medium text-amber-300 bg-slate-800/20">{r.avg3m.toFixed(1)}</td>
                      <td className="p-3 text-center bg-slate-800/20">
                        {r.supportStatus === '正常' && <span className="text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded text-xs">正常</span>}
                        {r.supportStatus === '需注意' && <span className="text-amber-400 bg-amber-400/10 px-2 py-1 rounded text-xs">需注意</span>}
                        {r.supportStatus === '備料不足' && <span className="flex items-center justify-center gap-1 text-red-400 bg-red-400/10 px-2 py-1 rounded text-xs font-bold"><AlertTriangle size={12}/> 備料不足</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
             </table>
           </div>
         </div>
      )}

    </div>
  );
}
