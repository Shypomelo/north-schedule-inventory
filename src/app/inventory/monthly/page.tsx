"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useUser } from '@/components/UserContext';
import {
  InventoryItem,
  InventoryMonthlyClosing,
  InventoryMonthlyClosingItem,
  InventorySerial,
  InventoryTransaction,
  InventoryTransactionSerial,
  isActiveFormalTransaction,
} from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { format, subMonths } from 'date-fns';
import { FileSpreadsheet, Lock, Unlock, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { exportMonthlyReport } from '@/lib/utils/export-excel';
import { getInventoryTransactionQuantityDelta } from '@/lib/db/inventory-stock';
import {
  calculateInventoryMonthlyReport,
  getPreviousInventoryYearMonth,
} from '@/lib/db/inventory-monthly-report';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';

export default function MonthlyReportPage() {
  const [viewMode, setViewMode] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const { currentUser } = useUser();
  const [selectedYear, setSelectedYear] = useState(format(new Date(), 'yyyy'));
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'MM'));
  
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [transactionSerials, setTransactionSerials] = useState<InventoryTransactionSerial[]>([]);
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [closings, setClosings] = useState<InventoryMonthlyClosing[]>([]);
  const [closingItems, setClosingItems] = useState<InventoryMonthlyClosingItem[]>([]);
  const [previousClosingItems, setPreviousClosingItems] = useState<InventoryMonthlyClosingItem[]>([]);
  const [isMonthlyItemsLoading, setIsMonthlyItemsLoading] = useState(false);
  const [monthlyItemsError, setMonthlyItemsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    const [i, t, ts, s, c] = await Promise.all([
      dbAdapter.getInventoryItems(),
      dbAdapter.getInventoryTransactions(),
      dbAdapter.getInventoryTransactionSerials(),
      dbAdapter.getInventorySerials(),
      dbAdapter.getMonthlyClosings()
    ]);
    setItems(i);
    setTransactions(t);
    setTransactionSerials(ts);
    setSerials(s);
    setClosings(c);
    setIsLoading(false);
  }

  const selectedClosing = useMemo(() => {
    return closings.find(c => (
      c.year === selectedYear
      && c.month === selectedMonth
    ));
  }, [closings, selectedYear, selectedMonth]);

  // CLOSED months always display their stored snapshot. OPEN/missing months stay dynamic.
  const currentClosing = selectedClosing?.status === 'CLOSED' ? selectedClosing : undefined;
  const previousYearMonth = useMemo(
    () => getPreviousInventoryYearMonth(selectedYear, selectedMonth),
    [selectedYear, selectedMonth],
  );
  const previousClosing = useMemo(() => closings.find(closing => (
    closing.year === previousYearMonth.year
    && closing.month === previousYearMonth.month
    && closing.status === 'CLOSED'
  )), [closings, previousYearMonth]);
  const currentClosingId = currentClosing?.id;
  const previousClosingId = previousClosing?.id;

  const selectableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = new Set([
      ...Array.from({ length: 5 }, (_, index) => String(currentYear - 2 + index)),
      ...closings.map(closing => closing.year),
      selectedYear,
    ]);

    return Array.from(years).sort((a, b) => Number(a) - Number(b));
  }, [closings, selectedYear]);

  // Fetch only the one snapshot needed by the selected month.
  useEffect(() => {
    let cancelled = false;
    const snapshotClosingId = currentClosingId || previousClosingId;

    setClosingItems([]);
    setPreviousClosingItems([]);
    setMonthlyItemsError(null);

    if (!snapshotClosingId) {
      setIsMonthlyItemsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setIsMonthlyItemsLoading(true);
    dbAdapter.getMonthlyClosingItems(snapshotClosingId)
      .then(snapshotItems => {
        if (cancelled) return;
        if (currentClosingId) {
          setClosingItems(snapshotItems);
        } else {
          setPreviousClosingItems(snapshotItems);
        }
      })
      .catch(error => {
        if (cancelled) return;
        console.error('Error loading inventory monthly snapshot:', error);
        setMonthlyItemsError('月結 snapshot 載入失敗，請稍後重試');
      })
      .finally(() => {
        if (!cancelled) setIsMonthlyItemsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentClosingId, previousClosingId]);

  // Dynamically calculate for unclosed month
  const dynamicReportData = useMemo(() => {
    if (currentClosing) return []; // skip if closed

    return calculateInventoryMonthlyReport({
      year: selectedYear,
      month: selectedMonth,
      items,
      transactions,
      previousClosingItems: previousClosing ? previousClosingItems : null,
    });
  }, [
    currentClosing,
    selectedYear,
    selectedMonth,
    items,
    transactions,
    previousClosing,
    previousClosingItems,
  ]);

  const displayData = currentClosing ? closingItems : dynamicReportData;
  const isMonthlyDataLoading = isLoading || isMonthlyItemsLoading;

  const handleCloseMonth = async () => {
    if (currentClosing || currentUser?.role === 'VIEWER' || isMonthlyItemsLoading || monthlyItemsError) return;

    setIsLoading(true);
    try {
      await dbAdapter.createMonthlyClosing(
        {
          year: selectedYear,
          month: selectedMonth,
          closed_at: new Date().toISOString(),
          closed_by: currentUser?.name || '未知使用者',
          status: 'CLOSED',
          notes: null
        },
        dynamicReportData
      );
      await loadData();
      alert('封存完成');
    } catch (error) {
      console.error(error);
      alert(getDatabaseErrorMessage(error, '封存失敗'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnsealMonth = async () => {
    if (!currentClosing || currentUser?.role !== 'ADMIN') return;

    const confirmed = window.confirm(
      '解除封存後，該月份庫存紀錄將可重新修改，重新封存後才會產生新的正式月結資料。確定解除？'
    );
    if (!confirmed) return;

    setIsLoading(true);
    try {
      await dbAdapter.unsealInventoryMonth(selectedYear, selectedMonth);
      await loadData();
      alert('解除封存完成');
    } catch (error) {
      console.error(error);
      alert(getDatabaseErrorMessage(error, '解除封存失敗'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = () => {
    const targetMonth = `${selectedYear}-${selectedMonth}`;
    const txsInMonth = transactions.filter(tx => tx.transaction_date.substring(0, 7) === targetMonth);
    exportMonthlyReport(
      selectedYear,
      selectedMonth,
      currentClosing ? 'CLOSED' : 'OPEN',
      displayData,
      txsInMonth,
      transactionSerials,
      serials,
      items,
    );
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
      if (!isActiveFormalTransaction(tx)) return;
      const r = rows[tx.item_id];
      if (!r) return;

      r.currentStock += getInventoryTransactionQuantityDelta(tx.transaction_type, tx.quantity);

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
      if (!isActiveFormalTransaction(tx) || tx.transaction_type !== 'OUT') return;
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
      <div className="flex justify-between items-center bg-card p-4 rounded-xl shadow border border-theme-border">
        <div className="flex gap-4">
          <button 
            className={`px-4 py-2 rounded-lg font-medium transition ${viewMode === 'MONTHLY' ? 'bg-accent text-white' : 'bg-card/80 text-secondary hover:bg-card hover:text-primary border border-transparent'}`}
            onClick={() => setViewMode('MONTHLY')}
          >
            月結報表
          </button>
          <button 
            className={`px-4 py-2 rounded-lg font-medium transition ${viewMode === 'ANNUAL' ? 'bg-accent text-white' : 'bg-card/80 text-secondary hover:bg-card hover:text-primary border border-transparent'}`}
            onClick={() => setViewMode('ANNUAL')}
          >
            年度報表 (預判)
          </button>
        </div>
      </div>

      {viewMode === 'MONTHLY' && (
        <div className="flex-1 flex flex-col gap-4 overflow-hidden">
          <div className="flex justify-between items-center bg-card p-4 rounded-xl border border-theme-border">
             <div className="flex items-center gap-4">
               <select 
                 value={selectedYear}
                 onChange={e => setSelectedYear(e.target.value)}
                 className="bg-page border border-theme-border rounded p-2 text-primary outline-none"
               >
                 {selectableYears.map(year => (
                   <option key={year} value={year}>{year} 年</option>
                 ))}
               </select>
               <select 
                 value={selectedMonth}
                 onChange={e => setSelectedMonth(e.target.value)}
                 className="bg-page border border-theme-border rounded p-2 text-primary outline-none"
               >
                 {Array.from({length: 12}).map((_, i) => {
                   const m = (i + 1).toString().padStart(2, '0');
                   return <option key={m} value={m}>{m} 月</option>;
                 })}
               </select>

               {currentClosing ? (
                 <span className="flex items-center gap-1 text-success bg-success/10 px-3 py-1 rounded-full text-sm font-medium">
                   <Lock size={16} /> 已封存 · Snapshot ({format(new Date(currentClosing.closed_at), 'MM/dd HH:mm')})
                 </span>
               ) : (
                 <span className="flex items-center gap-1 text-warning bg-warning/10 px-3 py-1 rounded-full text-sm font-medium">
                   <Unlock size={16} /> {selectedClosing?.status === 'OPEN' ? '已解除封存' : '未封存'} · 即時計算
                 </span>
               )}
               {!currentClosing && (
                 <span className="text-xs text-secondary">
                   {previousClosing
                     ? `期初承接 ${previousYearMonth.year}-${previousYearMonth.month} 封存期末`
                     : '期初依原始庫存與歷史異動計算'}
                 </span>
               )}
             </div>
             
             <div className="flex items-center gap-3">
               {currentClosing ? (
                 currentUser?.role === 'ADMIN' && (
                   <button
                     onClick={handleUnsealMonth}
                     disabled={isLoading}
                     className="flex items-center gap-2 px-4 py-2 rounded shadow transition bg-warning hover:bg-warning/80 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                   >
                     <Unlock size={18} />
                     解除封存
                   </button>
                 )
               ) : (
                 <button
                   onClick={handleCloseMonth}
                   disabled={currentUser?.role === 'VIEWER' || isMonthlyDataLoading || Boolean(monthlyItemsError)}
                   className="flex items-center gap-2 px-4 py-2 rounded shadow transition bg-success hover:bg-success/80 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                 >
                   <CheckCircle size={18} />
                   封存本月
                 </button>
               )}
               <button 
                 onClick={handleExport}
                 disabled={isMonthlyDataLoading || Boolean(monthlyItemsError) || displayData.length === 0}
                 className="flex items-center gap-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded shadow transition"
               >
                 <FileSpreadsheet size={18} />
                 匯出 Excel
               </button>
             </div>
          </div>

          <div className="flex-1 overflow-auto bg-card/50 border border-theme-border rounded-xl relative">
            {isMonthlyDataLoading ? (
              <div className="absolute inset-0 flex items-center justify-center text-secondary">計算中...</div>
            ) : monthlyItemsError ? (
              <div className="absolute inset-0 flex items-center justify-center text-danger">{monthlyItemsError}</div>
            ) : displayData.length === 0 ? (
               <div className="absolute inset-0 flex items-center justify-center text-secondary/70">
                 這個月份沒有任何庫存記錄與異動
               </div>
            ) : (
              <table className="w-full text-left border-collapse whitespace-nowrap">
                <thead className="bg-card text-secondary text-sm sticky top-0 z-10 border-b border-theme-border shadow-sm">
                  <tr>
                    <th className="p-3 font-semibold">分類</th>
                    <th className="p-3 font-semibold">來源</th>
                    <th className="p-3 font-semibold">品名</th>
                    <th className="p-3 font-semibold text-right text-secondary">期初</th>
                    <th className="p-3 font-semibold text-right text-success">入庫</th>
                    <th className="p-3 font-semibold text-right text-accent">退料</th>
                    <th className="p-3 font-semibold text-right text-danger">出庫</th>
                    <th className="p-3 font-semibold text-right text-warning">調整</th>
                    <th className="p-3 font-semibold text-right text-success text-base border-l border-theme-border/50">期末</th>
                    <th className="p-3 font-semibold text-center text-secondary border-l border-theme-border/50">單位</th>
                    <th className="p-3 font-semibold">備註</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/50 text-sm">
                  {displayData.map((r, i) => (
                    <tr key={i} className="hover:bg-card/60 transition-colors">
                      <td className="p-3 text-secondary">{r.stock_category}</td>
                      <td className="p-3 text-secondary">{r.source}</td>
                      <td className="p-3 text-primary font-medium">{r.item_name}</td>
                      <td className="p-3 text-right text-secondary/80">{r.opening_quantity}</td>
                      <td className="p-3 text-right text-success">{r.monthly_in}</td>
                      <td className="p-3 text-right text-accent">{r.monthly_return}</td>
                      <td className="p-3 text-right text-danger">{r.monthly_out}</td>
                      <td className="p-3 text-right text-warning">{r.monthly_adjust}</td>
                      <td className="p-3 text-right font-bold text-base text-success border-l border-theme-border/50 bg-card/20">{r.closing_quantity}</td>
                      <td className="p-3 text-center text-secondary/70 border-l border-theme-border/50">{r.unit}</td>
                      <td className="p-3 text-secondary max-w-[150px] truncate" title={r.notes || ''}>{r.notes}</td>
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
           <div className="flex justify-between items-center bg-card p-4 rounded-xl border border-theme-border">
             <div className="flex items-center gap-4">
               <select 
                 value={selectedYear}
                 onChange={e => setSelectedYear(e.target.value)}
                 className="bg-page border border-theme-border rounded p-2 text-primary outline-none"
               >
                 {selectableYears.map(year => (
                   <option key={year} value={year}>{year} 年</option>
                 ))}
               </select>
               <span className="text-secondary text-sm flex items-center gap-2">
                 <Info size={16} />
                 年度使用量統計與未來備料預判
               </span>
             </div>
           </div>

           <div className="flex-1 overflow-auto bg-card/50 border border-theme-border rounded-xl relative">
             <table className="w-full text-left border-collapse whitespace-nowrap">
                <thead className="bg-card text-secondary text-xs sticky top-0 z-10 border-b border-theme-border shadow-sm">
                  <tr>
                    <th className="p-3 font-semibold w-[200px] sticky left-0 bg-card z-20">品名</th>
                    <th className="p-3 font-semibold text-secondary">來源</th>
                    {Array.from({length: 12}).map((_, i) => (
                      <th key={i} className="p-3 font-semibold text-center text-secondary">{i+1}月</th>
                    ))}
                    <th className="p-3 font-semibold text-center text-accent border-l border-theme-border">總計</th>
                    <th className="p-3 font-semibold text-center text-success border-l border-theme-border">目前庫存</th>
                    <th className="p-3 font-semibold text-center text-warning">近3月平均</th>
                    <th className="p-3 font-semibold text-center text-primary">狀態預判</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/50 text-sm">
                  {annualData.map((r, i) => (
                    <tr key={i} className="hover:bg-card/60 transition-colors">
                      <td className="p-3 text-primary font-medium sticky left-0 bg-card/90 z-10 w-[200px] truncate" title={r.item.name}>{r.item.name}</td>
                      <td className="p-3 text-secondary/70 text-xs">{r.item.source_type}</td>
                      {r.usage.map((u: number, mIdx: number) => (
                        <td key={mIdx} className={`p-3 text-center ${u > 0 ? 'text-danger font-medium' : 'text-secondary/50'}`}>
                          {u || '-'}
                        </td>
                      ))}
                      <td className="p-3 text-center font-bold text-accent border-l border-theme-border/50 bg-card/20">{r.total}</td>
                      <td className="p-3 text-center font-bold text-success border-l border-theme-border/50 bg-card/20">{r.currentStock}</td>
                      <td className="p-3 text-center font-medium text-warning bg-card/20">{r.avg3m.toFixed(1)}</td>
                      <td className="p-3 text-center bg-card/20">
                        {r.supportStatus === '正常' && <span className="text-success bg-success/10 px-2 py-1 rounded text-xs">正常</span>}
                        {r.supportStatus === '需注意' && <span className="text-warning bg-warning/10 px-2 py-1 rounded text-xs">需注意</span>}
                        {r.supportStatus === '備料不足' && <span className="flex items-center justify-center gap-1 text-danger bg-danger/10 px-2 py-1 rounded text-xs font-bold"><AlertTriangle size={12}/> 備料不足</span>}
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
