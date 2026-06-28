"use client";

import React, { useState, useEffect } from 'react';
import { InventoryItem, InventoryTransaction, Project, InventorySerial, TransactionType } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { useUser } from '@/components/UserContext';
import { Package, AlertTriangle, ArrowRightLeft, Plus, MousePointerClick, MoreVertical } from 'lucide-react';
import Link from 'next/link';
import { ItemDetailModal } from '@/components/ItemDetailModal';
import { TransactionForm } from '@/components/TransactionForm';
import { format } from 'date-fns';

interface BalanceDisplay {
  item_id: string;
  category: string;
  source: string;
  item_name: string;
  opening: number;
  mtd_in: number;
  mtd_out: number;
  mtd_return: number;
  mtd_adjust: number;
  balance: number;
  registered_serials: number;
  pending_serials: number;
  requires_serial: boolean;
  low_stock_threshold: number;
}

export default function InventoryBalancePage() {
  const { currentUser } = useUser();
  const [balances, setBalances] = useState<BalanceDisplay[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allSerials, setAllSerials] = useState<InventorySerial[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ visible: boolean, x: number, y: number, itemId: string | null }>({ visible: false, x: 0, y: 0, itemId: null });

  // Modals
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [txModal, setTxModal] = useState<{ visible: boolean, type: TransactionType, itemId: string | null }>({ visible: false, type: 'IN', itemId: null });
  const [isSubmittingTx, setIsSubmittingTx] = useState(false);
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>('設備維修');

  const MAIN_CATEGORIES = ['設備維修', '建置 / 維修'];

  const loadData = async () => {
    setIsLoading(true);
    const [itms, txs, projs, srls, batches] = await Promise.all([
      dbAdapter.getInventoryItems(),
      dbAdapter.getInventoryTransactions(),
      dbAdapter.getProjects(),
      dbAdapter.getInventorySerials(),
      // @ts-ignore
      dbAdapter.getInventoryBatches ? dbAdapter.getInventoryBatches() : Promise.resolve([])
    ]);
    
    setItems(itms);
    setProjects(projs);
    setAllSerials(srls);
    setBatches(batches);

    const currentMonth = format(new Date(), 'yyyy-MM');

    const displayData = itms.map(item => {
      let balance = item.opening_quantity || 0;
      let mtd_in = 0, mtd_out = 0, mtd_return = 0, mtd_adjust = 0;

      const itemTxs = txs.filter(t => t.item_id === item.id);
      
      itemTxs.forEach(tx => {
        const txMonth = tx.transaction_date.substring(0, 7);
        
        if (tx.transaction_type === 'IN') balance += tx.quantity;
        if (tx.transaction_type === 'OUT') balance -= tx.quantity;
        if (tx.transaction_type === 'RETURN') balance += tx.quantity;
        if (tx.transaction_type === 'ADJUST') balance += tx.quantity;

        if (txMonth === currentMonth) {
          if (tx.transaction_type === 'IN') mtd_in += tx.quantity;
          if (tx.transaction_type === 'OUT') mtd_out += tx.quantity;
          if (tx.transaction_type === 'RETURN') mtd_return += tx.quantity;
          if (tx.transaction_type === 'ADJUST') mtd_adjust += tx.quantity;
        }
      });

      let registered_serials = 0;
      
      if (item.requires_serial) {
        registered_serials = srls.filter(s => s.item_id === item.id && s.status === '在庫').length;
      }

      return {
        item_id: item.id,
        category: item.category || '設備維修',
        source: item.source_type || '其他',
        item_name: item.name,
        opening: item.opening_quantity || 0,
        mtd_in,
        mtd_out,
        mtd_return,
        mtd_adjust,
        balance,
        registered_serials,
        pending_serials: item.requires_serial ? Math.max(0, balance - registered_serials) : 0,
        requires_serial: item.requires_serial,
        low_stock_threshold: item.low_stock_threshold || 0
      };
    }).sort((a, b) => {
      if (a.source !== b.source) {
        return a.source.localeCompare(b.source);
      }
      return a.item_name.localeCompare(b.item_name);
    });

    setBalances(displayData);
    setIsLoading(false);
  };

  useEffect(() => {
    loadData();
    
    // Close context menu on global click
    const handleClick = () => setContextMenu({ visible: false, x: 0, y: 0, itemId: null });
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, itemId: string) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, itemId });
  };

  const handleCreateTx = async (data: Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'> & { category?: string }, serialsInput: string, isPendingSerial: boolean = false) => {
    setIsSubmittingTx(true);
    try {
      const serialsList = serialsInput.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      let item = items.find(i => i.id === data.item_id);
      
      // 動態分列邏輯 (IN)
      if (data.transaction_type === 'IN' && item) {
         if (item.source_type !== data.source || item.category !== data.category) {
            let existingItem = items.find(i => i.name === item!.name && i.source_type === data.source && i.category === data.category);
            if (!existingItem) {
               // Create a new item to separate the source/category row
               const newItem = await dbAdapter.createInventoryItem({
                  ...item,
                  opening_quantity: 0,
                  source_type: data.source,
                  category: data.category,
               } as Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>);
               data.item_id = newItem.id;
               item = newItem;
            } else {
               data.item_id = existingItem.id;
               item = existingItem;
            }
         }
      }

      if (item?.requires_serial && (data.transaction_type === 'OUT' || data.transaction_type === 'RETURN') && !isPendingSerial) {
        const unknownOrUnavailable = serialsList.filter(s => {
          const found = allSerials.find(x => x.serial_number === s);
          return !found || found.status !== '在庫';
        });
        
        if (unknownOrUnavailable.length > 0) {
          alert(`出庫/退回失敗！以下序號系統找不到，或其狀態並非「在庫」：\n${unknownOrUnavailable.join(', ')}`);
          setIsSubmittingTx(false);
          return;
        }
      }

      for (const s of serialsList) {
        if (!allSerials.find(x => x.serial_number === s)) {
           await dbAdapter.createInventorySerial({
             item_id: data.item_id,
             batch_id: null,
             serial_number: s,
             status: data.transaction_type === 'OUT' ? '已出庫' : '在庫',
             project_id: data.project_id,
             notes: data.transaction_type === 'OUT' ? '出庫時補登' : '入庫時建立'
           });
        } else {
           const existing = allSerials.find(x => x.serial_number === s)!;
           await dbAdapter.updateInventorySerial(existing.id, {
             status: data.transaction_type === 'OUT' ? '已出庫' : data.transaction_type === 'RETURN' ? '已退回' : '在庫',
             project_id: data.transaction_type === 'OUT' ? data.project_id : existing.project_id
           });
        }
      }

      const txSerials: any[] = serialsList.map(s => ({
        serial_no: s,
        serial_id: allSerials.find(x => x.serial_number === s)?.id || null,
        is_pending: false
      }));

      let pendingCount = 0;
      if (item?.requires_serial && data.transaction_type === 'IN') {
        const missingCount = data.quantity - serialsList.length;
        if (missingCount > 0) {
          pendingCount = missingCount;
        }
      }

      await dbAdapter.createInventoryTransaction({
        ...data,
        pending_serial_count: pendingCount > 0 ? pendingCount : 0
      }, txSerials as any);
      setTxModal({ visible: false, type: 'IN', itemId: null });
      await loadData();
    } catch (e) {
      console.error(e);
      alert('儲存失敗');
    } finally {
      setIsSubmittingTx(false);
    }
  };

  const simpleBalances = balances.map(b => ({ item_id: b.item_id, balance: b.balance }));

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-full relative">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-slate-200">庫存總覽</h2>
          <p className="text-slate-400 text-sm mt-1">
            本月 ({format(new Date(), 'yyyy-MM')}) 即時庫存統計。
            <span className="text-amber-400 ml-2">提示：對品項按右鍵可以快速異動庫存！</span>
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer mr-2 hover:text-emerald-400 transition-colors">
            <input 
              type="checkbox" 
              className="rounded bg-slate-800 border-slate-600 text-emerald-500 focus:ring-emerald-500/50"
              checked={showZeroStock}
              onChange={(e) => setShowZeroStock(e.target.checked)}
            />
            顯示 0 庫存品項
          </label>
          <Link 
            href="/inventory/transactions"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded shadow transition border border-slate-700"
          >
            <ArrowRightLeft size={18} />
            查看所有流水帳
          </Link>
          <button 
            onClick={() => setDetailItemId('NEW')}
            disabled={currentUser?.role === 'VIEWER'}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={18} />
            新增品項
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-6 border-b border-slate-700/50 pb-px">
        {MAIN_CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-6 py-3 font-semibold text-sm rounded-t-lg transition-colors border-b-2 ${
              activeCategory === cat 
                ? 'bg-slate-800/80 text-emerald-400 border-emerald-400' 
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border-transparent'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto bg-slate-800/30 border border-slate-700 rounded-xl relative shadow-xl">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400">載入中...</div>
        ) : balances.filter(b => b.category === activeCategory).length === 0 ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
             <Package size={48} className="mb-4 opacity-50" />
             <p>此分類目前無任何品項資料</p>
             <button onClick={() => setDetailItemId('NEW')} disabled={currentUser?.role === 'VIEWER'} className="text-emerald-400 hover:underline mt-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline">
               點此新增品項
             </button>
           </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800/80 backdrop-blur-sm text-slate-300 text-sm sticky top-0 z-10 border-b border-slate-700">
              <tr>
                <th className="p-4 font-semibold">來源</th>
                <th className="p-4 font-semibold">品名</th>
                <th className="p-4 font-semibold text-right text-slate-400">本月初庫</th>
                <th className="p-4 font-semibold text-right text-emerald-400">本月入庫</th>
                <th className="p-4 font-semibold text-right text-red-400">本月出庫</th>
                <th className="p-4 font-semibold text-right text-indigo-400">目前庫存</th>
                <th className="p-4 font-semibold">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50 text-sm">
              {balances.filter(b => b.category === activeCategory && (showZeroStock || b.balance > 0)).map((b, i) => {
                const isLowStock = b.balance <= b.low_stock_threshold;
                return (
                  <tr 
                    key={i} 
                    className="hover:bg-slate-700/40 transition-colors cursor-pointer group"
                    onClick={() => setDetailItemId(b.item_id)}
                    onContextMenu={(e) => handleContextMenu(e, b.item_id)}
                  >
                    <td className="p-4 text-slate-300">{b.source}</td>
                    <td className="p-4 text-slate-100 font-medium group-hover:text-emerald-400 transition-colors">
                      {b.item_name}
                    </td>
                    <td className="p-4 text-right font-semibold text-slate-400/80">{b.opening}</td>
                    <td className="p-4 text-right font-semibold text-emerald-400/80">{b.mtd_in > 0 ? `+${b.mtd_in}` : '-'}</td>
                    <td className="p-4 text-right font-semibold text-red-400/80">{b.mtd_out > 0 ? `-${b.mtd_out}` : '-'}</td>
                    <td className="p-4 text-right text-xl font-bold text-slate-100">
                      {b.balance}
                    </td>
                    <td className="p-4">
                      {(() => {
                        if (b.balance === 0) return <span className="inline-flex items-center bg-red-500/20 text-red-400 px-2 py-1 rounded text-xs font-semibold">無庫存</span>;
                        if (b.requires_serial && b.pending_serials > 0) return <span className="inline-flex items-center bg-amber-500/20 text-amber-400 px-2 py-1 rounded text-xs font-semibold">待補序號</span>;
                        if (b.low_stock_threshold > 0 && b.balance <= b.low_stock_threshold) return <span className="inline-flex items-center bg-orange-500/20 text-orange-400 px-2 py-1 rounded text-xs font-semibold">低庫存</span>;
                        return <span className="inline-flex items-center bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded text-xs font-semibold">正常</span>;
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div 
          className="fixed z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl py-1 w-48 text-sm text-slate-200 animate-in fade-in zoom-in-95 duration-100"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-emerald-600/20 hover:text-emerald-400"
            onClick={() => { setTxModal({ visible: true, type: 'IN', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >📥 入庫 (IN)</button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-red-600/20 hover:text-red-400"
            onClick={() => { setTxModal({ visible: true, type: 'OUT', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >📤 出庫 (OUT)</button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-indigo-600/20 hover:text-indigo-400"
            onClick={() => { setTxModal({ visible: true, type: 'RETURN', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >↩️ 退料 (RETURN)</button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-amber-600/20 hover:text-amber-400"
            onClick={() => { setTxModal({ visible: true, type: 'ADJUST', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >⚖️ 調整 (ADJUST)</button>
          <div className="h-px bg-slate-700 my-1"></div>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 hover:text-white"
            onClick={() => { setDetailItemId(contextMenu.itemId); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >🔍 查看詳細資料</button>
          <div className="h-px bg-slate-700 my-1"></div>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-emerald-600/20 hover:text-emerald-400"
            onClick={() => { setDetailItemId('NEW'); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >➕ 新增品項</button>
        </div>
      )}

      {/* Item Detail Modal */}
      {detailItemId && (
        <ItemDetailModal 
          itemId={detailItemId === 'NEW' ? null : detailItemId} 
          onClose={() => setDetailItemId(null)}
          onItemUpdated={loadData}
        />
      )}
      
      {/* Transaction Modal Wrapper */}
      {txModal.visible && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setTxModal({ visible: false, type: 'IN', itemId: null })} />
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto relative shadow-2xl">
            <button 
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
              onClick={() => setTxModal({ visible: false, type: 'IN', itemId: null })}
            >
              ✕
            </button>
            <h3 className="text-xl font-bold text-slate-100 mb-6 flex items-center gap-2">
              <ArrowRightLeft className="text-emerald-500" />
              新增庫存異動
            </h3>
            <TransactionForm
              items={items}
              projects={projects}
              balances={simpleBalances}
              allSerials={allSerials}
              batches={batches}
              onSubmit={handleCreateTx}
              onCancel={() => setTxModal({ visible: false, type: 'IN', itemId: null })}
              isSubmitting={isSubmittingTx}
              initialData={{ transaction_type: txModal.type, item_id: txModal.itemId || '' }}
              onAddNewItem={() => {
                setTxModal({ visible: false, type: 'IN', itemId: null });
                setDetailItemId('NEW');
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
