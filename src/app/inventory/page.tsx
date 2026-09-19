"use client";
import { inventorySerialInputs, inventoryWriteError } from '@/lib/db/inventory-atomic';


import React, { useState, useEffect, useMemo } from 'react';
import { InventoryItem, InventoryTransaction, Project, InventorySerial, TransactionType, isActiveFormalTransaction } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { useUser } from '@/components/UserContext';
import { Package, AlertTriangle, ArrowRightLeft, Plus, MousePointerClick, MoreVertical } from 'lucide-react';
import Link from 'next/link';
import { ItemDetailModal } from '@/components/ItemDetailModal';
import { TransactionForm } from '@/components/TransactionForm';
import { InventoryInitializationModal } from '@/components/InventoryInitializationModal';
import { AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { getInventoryInflowQuantity, getInventoryTransactionQuantityDelta } from '@/lib/db/inventory-stock';

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

      const itemTxs = txs.filter(t => t.item_id === item.id && isActiveFormalTransaction(t));
      
      itemTxs.forEach(tx => {
        const txMonth = tx.transaction_date.substring(0, 7);
        
        balance += getInventoryTransactionQuantityDelta(tx.transaction_type, tx.quantity);

        if (txMonth === currentMonth) {
          mtd_in += getInventoryInflowQuantity(tx.transaction_type, tx.quantity);
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

  const [isInitModalOpen, setIsInitModalOpen] = useState(false);

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
      const isExistingItemContext = !!txModal.itemId;
      let item = items.find(i => i.id === (isExistingItemContext ? txModal.itemId : data.item_id));
      if (isExistingItemContext) {
        data.item_id = txModal.itemId!;
      }
      
      // 動態分列邏輯 (IN)
      if (!isExistingItemContext && data.transaction_type === 'IN' && item) {
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

      const txSerials = inventorySerialInputs(serialsInput);

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
      alert(inventoryWriteError(e).message);
    } finally {
      setIsSubmittingTx(false);
    }
  };
  const simpleBalances = balances.map(b => ({ item_id: b.item_id, balance: b.balance }));
  const txModalItem = txModal.itemId ? items.find(item => item.id === txModal.itemId) : undefined;

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-full relative">
      <div className="mb-5 flex flex-col items-stretch justify-between gap-3 sm:mb-8 lg:flex-row lg:items-center">
        <div>
          <h2 className="text-2xl font-bold text-primary">庫存總覽</h2>
          <p className="text-secondary text-sm mt-1">
            本月 ({format(new Date(), 'yyyy-MM')}) 即時庫存統計。
            <span className="text-warning ml-2">提示：對品項按右鍵可以快速異動庫存！</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-secondary text-sm cursor-pointer mr-2 hover:text-accent transition-colors">
            <input 

              type="checkbox" 
              className="rounded bg-card border-theme-border text-accent focus:ring-accent/50"
              checked={showZeroStock}
              onChange={(e) => setShowZeroStock(e.target.checked)}
            />
            顯示 0 庫存品項
          </label>
          {currentUser?.role === 'ADMIN' && (
            <button
              onClick={() => setIsInitModalOpen(true)}
              className="flex items-center gap-2 bg-warning hover:bg-warning/80 text-white px-4 py-2 rounded shadow transition"
            >
              <AlertTriangle size={18} />
              初始化庫存
            </button>
          )}
          <Link 
            href="/inventory/transactions"
            className="flex items-center gap-2 bg-card hover:bg-card/80 text-primary px-4 py-2 rounded shadow transition border border-theme-border"
          >
            <ArrowRightLeft size={18} />
            查看所有流水帳
          </Link>
          <button 
            onClick={() => setDetailItemId('NEW')}
            disabled={currentUser?.role === 'VIEWER'}
            className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={18} />
            新增品項
          </button>
        </div>
      </div>

      <div className="mb-6 flex gap-2 overflow-x-auto border-b border-theme-border/50 pb-px">
        {MAIN_CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-6 py-3 font-semibold text-sm rounded-t-lg transition-colors border-b-2 ${
              activeCategory === cat
                ? 'bg-card/80 text-accent border-accent'
                : 'text-secondary hover:text-primary hover:bg-card/40 border-transparent'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto bg-card/30 border border-theme-border rounded-xl relative shadow-xl">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-secondary">載入中...</div>
        ) : balances.filter(b => b.category === activeCategory).length === 0 ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-secondary/70">
             <Package size={48} className="mb-4 opacity-50" />
             <p>此分類目前無任何品項資料</p>
             <button onClick={() => setDetailItemId('NEW')} disabled={currentUser?.role === 'VIEWER'} className="text-accent hover:underline mt-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline">
               點此新增品項
             </button>
           </div>
        ) : (
          <table className="min-w-[64rem] w-full text-left border-collapse">
            <thead className="bg-[var(--surface-secondary)] backdrop-blur-sm text-secondary text-sm sticky top-0 z-10 border-b border-theme-border">
              <tr>
                <th className="p-4 font-semibold">來源</th>
                <th className="p-4 font-semibold">品名</th>
                <th className="p-4 font-semibold text-right text-secondary">本月初庫</th>
                <th className="p-4 font-semibold text-right text-success">本月入庫</th>
                <th className="p-4 font-semibold text-right text-danger">本月出庫</th>
                <th className="p-4 font-semibold text-right text-primary">目前庫存</th>
                <th className="p-4 font-semibold">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50 text-sm">
              {balances.filter(b => b.category === activeCategory && (showZeroStock || b.balance > 0)).map((b, i) => {
                const isLowStock = b.balance <= b.low_stock_threshold;
                return (
                  <tr 
                    key={i} 
                    className="hover:bg-[var(--surface-secondary)] transition-colors cursor-pointer group"
                    onClick={() => setDetailItemId(b.item_id)}
                    onContextMenu={(e) => handleContextMenu(e, b.item_id)}
                  >
                    <td className="p-4 text-secondary">{b.source}</td>
                    <td className="p-4 text-primary font-medium group-hover:text-accent transition-colors">
                      {b.item_name}
                    </td>
                    <td className="p-4 text-right font-semibold text-secondary/80">{b.opening}</td>
                    <td className="p-4 text-right font-semibold text-success/80">{b.mtd_in > 0 ? `+${b.mtd_in}` : '-'}</td>
                    <td className="p-4 text-right font-semibold text-danger/80">{b.mtd_out > 0 ? `-${b.mtd_out}` : '-'}</td>
                    <td className="p-4 text-right text-xl font-bold text-primary">
                      {b.balance}
                    </td>
                    <td className="p-4">
                      {(() => {
                        if (b.balance === 0) return <span className="inline-flex items-center bg-danger/20 text-danger px-2 py-1 rounded text-xs font-semibold">無庫存</span>;
                        if (b.requires_serial && b.pending_serials > 0) return <span className="inline-flex items-center bg-warning/20 text-warning px-2 py-1 rounded text-xs font-semibold">待補序號</span>;
                        if (b.low_stock_threshold > 0 && b.balance <= b.low_stock_threshold) return <span className="inline-flex items-center bg-warning/20 text-warning px-2 py-1 rounded text-xs font-semibold">低庫存</span>;
                        return <span className="inline-flex items-center bg-success/20 text-success px-2 py-1 rounded text-xs font-semibold">正常</span>;
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
          className="fixed z-50 bg-card border border-theme-border rounded-lg shadow-2xl py-1 w-48 text-sm text-primary animate-in fade-in zoom-in-95 duration-100"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-success/20 hover:text-success"
            onClick={() => { setTxModal({ visible: true, type: 'IN', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >📥 入庫 (IN)</button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-danger/20 hover:text-danger"
            onClick={() => { setTxModal({ visible: true, type: 'OUT', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >📤 出庫 (OUT)</button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-accent/20 hover:text-accent"
            onClick={() => { setTxModal({ visible: true, type: 'RETURN', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >↩️ 退料 (RETURN)</button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-warning/20 hover:text-warning"
            onClick={() => { setTxModal({ visible: true, type: 'ADJUST', itemId: contextMenu.itemId }); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >⚖️ 調整 (ADJUST)</button>
          <div className="h-px bg-theme-border my-1"></div>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-card/80 hover:text-primary"
            onClick={() => { setDetailItemId(contextMenu.itemId); setContextMenu({ visible: false, x: 0, y: 0, itemId: null }); }}
          >🔍 查看詳細資料</button>
          <div className="h-px bg-theme-border my-1"></div>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-success/20 hover:text-success"
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4">
          <div className="absolute inset-0 bg-page/80 backdrop-blur-sm" onClick={() => setTxModal({ visible: false, type: 'IN', itemId: null })} />
          <div className="relative max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-y-auto rounded-xl border border-theme-border bg-card p-4 shadow-2xl sm:max-h-[90vh] sm:p-6">
            <button 
              className="absolute top-4 right-4 text-secondary hover:text-primary"
              onClick={() => setTxModal({ visible: false, type: 'IN', itemId: null })}
            >
              ✕
            </button>
            <h3 className="text-xl font-bold text-primary mb-6 flex items-center gap-2">
              <ArrowRightLeft className="text-accent" />
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
              initialData={{
                transaction_type: txModal.type,
                item_id: txModal.itemId || '',
                unit: txModalItem?.unit || '',
                category: txModalItem?.category || '',
                source: txModalItem?.source_type || '',
              }}
              onAddNewItem={() => {
                setTxModal({ visible: false, type: 'IN', itemId: null });
                setDetailItemId('NEW');
              }}
            />
          </div>
        </div>
      )}
      {/* Initialization Modal */}
      {isInitModalOpen && (
        <InventoryInitializationModal
          isOpen={isInitModalOpen}
          onClose={() => setIsInitModalOpen(false)}
          items={items}
          onSuccess={loadData}
        />
      )}

    </div>
  );
}
