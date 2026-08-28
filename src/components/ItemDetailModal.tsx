"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { InventoryItem, InventoryTransaction, InventorySerial, Project, InventoryBatch, isActiveFormalTransaction, InventorySerialLookupCandidate } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { X, Box, History, List, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { format } from 'date-fns';
import { getInventoryInflowQuantity, getInventoryTransactionQuantityDelta } from '@/lib/db/inventory-stock';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import { ItemForm } from './ItemForm';
import { useUser } from './UserContext';
import { getInventoryBatchUsageSummary, isEffectiveInventorySerial } from '@/lib/db/inventory-batch-status';

interface ItemDetailModalProps {
  itemId: string | null;
  onClose: () => void;
  onItemUpdated: () => void;
}

type TabKey = 'SUMMARY' | 'EDIT' | 'BATCHES' | 'HISTORY';

export function ItemDetailModal({ itemId, onClose, onItemUpdated }: ItemDetailModalProps) {
  const { currentUser } = useUser();
  const [activeTab, setActiveTab] = useState<TabKey>('SUMMARY');
  
  const [item, setItem] = useState<InventoryItem | null>(null);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMonthlyClosing, setHasMonthlyClosing] = useState(false);
  const [isSavingItem, setIsSavingItem] = useState(false);

  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [newSerialNo, setNewSerialNo] = useState('');
  const serialInputRef = useRef<HTMLInputElement>(null);
  const [serialContextMenu, setSerialContextMenu] = useState<{ visible: boolean, x: number, y: number, serialId: string | null }>({ visible: false, x: 0, y: 0, serialId: null });

  useEffect(() => {
    async function load() {
      if (!itemId) return;
      setIsLoading(true);
      const [itms, txs, srls, projs, allBatches, itemHasMonthlyClosing] = await Promise.all([
        dbAdapter.getInventoryItems(),
        dbAdapter.getInventoryTransactions(),
        dbAdapter.getInventorySerials(),
        dbAdapter.getProjects(),
        // @ts-ignore
        dbAdapter.getInventoryBatches ? dbAdapter.getInventoryBatches() : Promise.resolve([]),
        dbAdapter.hasInventoryItemMonthlyClosing(itemId),
      ]);
      const found = itms.find(i => i.id === itemId);
      setItem(found || null);
      
      setTransactions(txs.filter(t => t.item_id === itemId).sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      setSerials(srls.filter(s => s.item_id === itemId));
      setProjects(projs);
      setBatches(allBatches.filter((b: InventoryBatch) => b.item_id === itemId).sort((a: InventoryBatch, b: InventoryBatch) => new Date(b.in_date).getTime() - new Date(a.in_date).getTime()));
      setHasMonthlyClosing(itemHasMonthlyClosing);
      setIsLoading(false);
    }
    load();
  }, [itemId]);

  // Focus input automatically when expanded
  useEffect(() => {
    if (expandedBatchId && serialInputRef.current) {
      serialInputRef.current.focus();
    }
  }, [expandedBatchId]);

  useEffect(() => {
    const handleClick = () => setSerialContextMenu({ visible: false, x: 0, y: 0, serialId: null });
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const serialsByBatchId = useMemo(() => {
    const grouped = new Map<string, InventorySerial[]>();
    serials.forEach(serial => {
      if (!serial.batch_id) return;
      const batchSerials = grouped.get(serial.batch_id) || [];
      batchSerials.push(serial);
      grouped.set(serial.batch_id, batchSerials);
    });
    return grouped;
  }, [serials]);

  const transactionsById = useMemo(
    () => new Map(transactions.map(transaction => [transaction.id, transaction])),
    [transactions],
  );

  if (!itemId) return null;

  let opening = item?.opening_quantity || 0;
  let currentBalance = opening;
  const activeTransactions = transactions.filter(tx => isActiveFormalTransaction(tx));
  
  const now = new Date();
  const currentMonthPrefix = format(now, 'yyyy-MM');
  let monthIn = 0;
  let monthOut = 0;

  activeTransactions.forEach(tx => {
    currentBalance += getInventoryTransactionQuantityDelta(tx.transaction_type, tx.quantity);

    if (tx.transaction_date.startsWith(currentMonthPrefix)) {
      monthIn += getInventoryInflowQuantity(tx.transaction_type, tx.quantity);
      if (tx.transaction_type === 'OUT') {
        monthOut += tx.quantity;
      }
    }
  });

  const registered_serials = serials.filter(s => s.status === '在庫').length;
  const pending_serials = item?.requires_serial ? Math.max(0, currentBalance - registered_serials) : 0;

  const getBatchSourceTransaction = (batch: InventoryBatch) => {
    if (!batch.source_transaction_id) return undefined;
    return transactionsById.get(batch.source_transaction_id);
  };

  const handleManualRegisterSerial = async (e: React.FormEvent, batchId: string) => {
    e.preventDefault();
    if (!newSerialNo.trim() || !item) return;
    
    const serialStr = newSerialNo.trim();
    const formatSerialCandidates = (candidates: InventorySerialLookupCandidate[]) => (
      candidates
        .map(candidate => `${candidate.serial_number}｜${candidate.status}`)
        .join('\n')
    );
    const lookup = await dbAdapter.lookupInventorySerial(serialStr);
    if (lookup.result_type !== 'no_match') {
      alert(lookup.result_type === 'ambiguous'
        ? `找到多個可能相同的序號，請確認完整序號：\n${formatSerialCandidates(lookup.candidates)}`
        : `此序號可能已存在，請勿重複補登：\n${lookup.candidates[0]?.serial_number || serialStr}`);
      return;
    }

    const batch = batches.find(b => b.id === batchId);
    if (!batch) return;
    const sourceTx = getBatchSourceTransaction(batch);
    if (sourceTx && !isActiveFormalTransaction(sourceTx)) {
      alert('此入庫批次已作廢或為初始化前歷史，不能再補登序號。');
      return;
    }

    const batchSerialsCount = (serialsByBatchId.get(batchId) || [])
      .filter(isEffectiveInventorySerial)
      .length;
    if (batchSerialsCount >= batch.quantity) {
      alert('該批次待補數量已滿，無法再新增序號！');
      return;
    }

    await dbAdapter.createInventorySerial({
      item_id: item.id,
      // @ts-ignore
      batch_id: batchId,
      serial_number: serialStr,
      status: '在庫',
      project_id: null,
      notes: '手動補登',
      created_at: new Date().toISOString()
    } as any);

    setNewSerialNo('');
    const srls = await dbAdapter.getInventorySerials();
    setSerials(srls.filter(s => s.item_id === itemId));
    
    if (serialInputRef.current) {
      serialInputRef.current.focus();
    }
    
    onItemUpdated();
  };

  const handleDeleteSerial = async (serialId: string) => {
    if (!confirm('確定要刪除此序號嗎？(此操作僅刪除序號資料，不會改變庫存數量)')) return;
    try {
      if (dbAdapter.deleteInventorySerial) {
        // @ts-ignore
        await dbAdapter.deleteInventorySerial(serialId);
      }
      setSerials(serials.filter(s => s.id !== serialId));
      onItemUpdated();
    } catch (e) {
      console.error(e);
      alert('刪除失敗');
    }
  };

  const handleUpdateSource = async (newSource: string) => {
    if (!item || currentUser?.role === 'VIEWER') return;
    try {
      const updated = await dbAdapter.updateInventoryItem(item.id, { source_type: newSource });
      setItem(updated);
      onItemUpdated();
    } catch(e) {
      console.error(e);
      alert(getDatabaseErrorMessage(e, '更新品項失敗'));
    }
  };

  const handleUpdateItem = async (
    updates: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>,
  ) => {
    if (!item || currentUser?.role === 'VIEWER') return;

    setIsSavingItem(true);
    try {
      const updated = await dbAdapter.updateInventoryItem(item.id, updates);
      setItem(updated);
      setActiveTab('SUMMARY');
      onItemUpdated();
    } catch (error) {
      console.error(error);
      alert(getDatabaseErrorMessage(error, '更新品項失敗'));
    } finally {
      setIsSavingItem(false);
    }
  };

  const tabs = [
    { key: 'SUMMARY', label: '庫存摘要', icon: Box },
    { key: 'EDIT', label: '品項編輯', icon: Pencil },
    { key: 'BATCHES', label: item?.requires_serial ? '入庫批次 / 序號' : '入庫批次', icon: List },
    { key: 'HISTORY', label: '流水紀錄', icon: History },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-page/80 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-card border border-theme-border w-full max-w-5xl h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-theme-border/50 bg-card/50">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent/20 text-accent flex items-center justify-center border border-accent/30">
              <Box size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-primary">{item?.name}</h2>
              <p className="text-sm text-secondary">品項詳細資料與狀態</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-secondary hover:text-primary hover:bg-theme-border/50 rounded-lg transition-colors">
            <X size={24} />
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-secondary">載入中...</div>
        ) : (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Sidebar Navigation */}
            <div className="w-full md:w-64 bg-card/20 border-r border-theme-border/50 p-4 overflow-y-auto">
              <div className="flex flex-col gap-2">
                {tabs.map(t => (
                  <button
                    key={t.key}
                    onClick={() => setActiveTab(t.key as TabKey)}
                    className={`flex items-center gap-3 w-full p-3 rounded-lg text-sm font-medium transition-all ${
                      activeTab === t.key 
                        ? 'bg-accent text-white shadow-md'
                        : 'text-secondary hover:bg-card hover:text-primary'
                    }`}
                  >
                    <t.icon size={18} />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 p-6 overflow-y-auto bg-card/50">
              
              {activeTab === 'SUMMARY' && (
                <div className="flex flex-col gap-5 max-w-2xl">
                  <h3 className="text-lg font-bold text-primary border-b border-theme-border/50 pb-2">庫存摘要</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-card p-4 rounded-xl border border-theme-border/50">
                      <div className="text-sm text-secondary mb-1">品名</div>
                      <div className="text-lg text-primary">{item?.name}</div>
                    </div>
                    <div className="bg-card p-4 rounded-xl border border-theme-border/50">
                      <div className="text-sm text-secondary mb-1">來源</div>
                      <select 
                        value={item?.source_type || ''}
                        onChange={(e) => handleUpdateSource(e.target.value)}
                        disabled={currentUser?.role === 'VIEWER'}
                        className="bg-transparent text-lg font-medium text-primary outline-none w-full border-b border-dashed border-theme-border focus:border-accent cursor-pointer disabled:cursor-not-allowed disabled:text-secondary/50"
                      >
                        <option value="陽光" className="bg-card">陽光</option>
                        <option value="中部移轉" className="bg-card">中部移轉</option>
                        <option value="南部移轉" className="bg-card">南部移轉</option>
                        <option value="其他" className="bg-card">其他</option>
                      </select>
                    </div>
                    <div className="bg-card p-4 rounded-xl border border-theme-border/50">
                      <div className="text-sm text-secondary mb-1">類型</div>
                      <div className="text-lg text-primary">{item?.requires_serial ? '設備 (管序號)' : '維修用品 (僅數量)'}</div>
                    </div>
                    <div className="bg-card p-4 rounded-xl border border-theme-border/50">
                      <div className="text-sm text-secondary mb-1">目前狀態</div>
                      <div className="text-lg text-primary">
                         {currentBalance <= (item?.low_stock_threshold || 0) && currentBalance > 0 ? (
                            <span className="text-warning font-bold">低庫存</span>
                          ) : currentBalance === 0 ? (
                            <span className="text-danger font-bold">已缺貨</span>
                          ) : (
                            <span className="text-success font-bold">庫存充足</span>
                          )}
                      </div>
                    </div>
                  </div>

                  <h3 className="text-md font-bold text-primary mt-4 border-b border-theme-border/50 pb-2">本月動態</h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="bg-accent/10 p-4 rounded-xl border border-accent/20 flex flex-col items-center">
                      <span className="text-sm text-accent mb-1">目前庫存</span>
                      <span className="text-3xl font-bold text-accent">{currentBalance}</span>
                    </div>
                    <div className="bg-success/10 p-4 rounded-xl border border-success/20 flex flex-col items-center">
                      <span className="text-sm text-success mb-1">本月入庫</span>
                      <span className="text-3xl font-bold text-success">+{monthIn}</span>
                    </div>
                    <div className="bg-danger/10 p-4 rounded-xl border border-danger/20 flex flex-col items-center">
                      <span className="text-sm text-danger mb-1">本月出庫</span>
                      <span className="text-3xl font-bold text-danger">-{monthOut}</span>
                    </div>
                  </div>

                  {item?.requires_serial && (
                    <>
                      <h3 className="text-md font-bold text-primary mt-4 border-b border-theme-border/50 pb-2">序號狀態</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-success/10 p-4 rounded-xl border border-success/20 flex flex-col items-center">
                          <span className="text-sm text-success mb-1">已登序號 (庫存中)</span>
                          <span className="text-2xl font-bold text-success">{registered_serials}</span>
                        </div>
                        <div className="bg-warning/10 p-4 rounded-xl border border-warning/20 flex flex-col items-center">
                          <span className="text-sm text-warning mb-1">待補序號</span>
                          <span className={`text-2xl font-bold ${pending_serials > 0 ? 'text-warning' : 'text-secondary'}`}>{pending_serials}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'EDIT' && item && (
                <div className="flex flex-col gap-5 max-w-2xl">
                  <h3 className="text-lg font-bold text-primary border-b border-theme-border/50 pb-2">品項編輯</h3>
                  <ItemForm
                    initialData={item}
                    onSubmit={handleUpdateItem}
                    onCancel={() => setActiveTab('SUMMARY')}
                    isSubmitting={isSavingItem}
                    isOpeningQuantityLocked={hasMonthlyClosing}
                  />
                </div>
              )}

              {activeTab === 'BATCHES' && (
                <div className="flex flex-col gap-4 h-full">
                  <div className="flex justify-between items-center border-b border-theme-border/50 pb-2">
                    <h3 className="text-lg font-bold text-primary">{item?.requires_serial ? '入庫批次 / 序號明細' : '入庫批次列表'}</h3>
                  </div>

                  {batches.length === 0 ? (
                    <div className="text-secondary/70 p-8 text-center bg-card/30 rounded-xl border border-theme-border/50 border-dashed">
                      目前沒有任何入庫批次紀錄
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {batches.map(batch => {
                        const batchSerials = serialsByBatchId.get(batch.id) || [];
                        const isExpanded = expandedBatchId === batch.id;
                        const sourceTransaction = getBatchSourceTransaction(batch);
                        const isBatchVoided = !!sourceTransaction && !isActiveFormalTransaction(sourceTransaction);
                        const usage = getInventoryBatchUsageSummary({
                          batchQuantity: batch.quantity,
                          requiresSerial: !!item?.requires_serial,
                          isVoided: isBatchVoided,
                          serials: batchSerials,
                        });
                        const statusClass = {
                          '未使用': 'bg-success/20 text-success',
                          '使用中': 'bg-warning/20 text-warning',
                          '已用完': 'bg-danger/20 text-danger',
                          '已作廢': 'bg-theme-border text-secondary',
                          '待補序號': 'bg-warning/30 text-warning',
                          '非序號品': 'bg-accent/20 text-accent',
                        }[usage.status];

                        return (
                          <div key={batch.id} className={`bg-card border rounded-lg overflow-hidden ${isBatchVoided ? 'border-theme-border/50 opacity-60' : 'border-theme-border'}`}>
                            <div 
                              className={`flex items-center justify-between p-4 cursor-pointer transition ${isBatchVoided ? 'bg-page/40 hover:bg-card/60' : 'hover:bg-theme-border/30'} ${isExpanded ? 'bg-theme-border/30' : ''}`}
                              onClick={() => setExpandedBatchId(isExpanded ? null : batch.id)}
                            >
                              <div className="flex items-center gap-x-6 gap-y-3 flex-wrap flex-1">
                                <div>
                                  <div className="text-sm text-secondary">批次號</div>
                                  <div className={`font-mono font-semibold ${isBatchVoided ? 'text-secondary/50 line-through' : 'text-accent'}`}>{batch.batch_number}</div>
                                </div>
                                <div>
                                  <div className="text-sm text-secondary">入庫日期</div>
                                  <div className={isBatchVoided ? 'text-secondary/50 line-through' : 'text-primary'}>{batch.in_date}</div>
                                </div>
                                <div>
                                  <div className="text-sm text-secondary">來源</div>
                                  <div className={isBatchVoided ? 'text-secondary/50 line-through' : 'text-primary'}>{batch.source || '-'}</div>
                                </div>
                                <div>
                                  <div className="text-sm text-secondary">入庫</div>
                                  <div className={`font-bold text-lg ${isBatchVoided ? 'text-secondary/50 line-through' : 'text-primary'}`}>{batch.quantity}</div>
                                </div>
                                {item?.requires_serial && (
                                  <>
                                    <div>
                                      <div className="text-sm text-secondary">序號</div>
                                      <div className="text-primary font-bold">{usage.serialQuantity}</div>
                                    </div>
                                    <div>
                                      <div className="text-sm text-secondary">已使用</div>
                                      <div className={usage.usedQuantity > 0 ? 'text-warning font-bold' : 'text-secondary font-bold'}>{usage.usedQuantity}</div>
                                    </div>
                                    <div>
                                      <div className="text-sm text-secondary">剩餘</div>
                                      <div className={usage.remainingQuantity > 0 ? 'text-success font-bold' : 'text-secondary font-bold'}>{usage.remainingQuantity}</div>
                                    </div>
                                    <div>
                                      <div className="text-sm text-secondary">待補</div>
                                      <div className={usage.pendingQuantity > 0 ? 'text-warning font-bold' : 'text-secondary font-bold'}>{usage.pendingQuantity}</div>
                                    </div>
                                  </>
                                )}
                              </div>
                              <div className="text-secondary flex items-center gap-2">
                                <span className={`text-sm px-3 py-1 rounded-full font-semibold ${statusClass}`}>
                                  {usage.status}
                                </span>
                                {item?.requires_serial && (
                                  <span className="text-sm bg-accent/30 text-accent px-3 py-1 rounded-full">
                                    {isExpanded ? '收合序號' : '查看/補登序號'}
                                  </span>
                                )}
                                {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                              </div>
                            </div>
                            
                            {isExpanded && item?.requires_serial && (
                              <div className="p-4 border-t border-theme-border bg-page/50">
                                
                                <div className="mb-4">
                                  <form onSubmit={(e) => handleManualRegisterSerial(e, batch.id)} className="flex gap-2">
                                    <input 
                                      ref={serialInputRef}
                                      type="text" 
                                      placeholder="連續刷條碼補登序號 (按 Enter 加入)..." 
                                      className="flex-1 bg-page border border-accent/50 rounded p-2 text-primary outline-none focus:border-accent"
                                      value={newSerialNo}
                                      onChange={e => setNewSerialNo(e.target.value)}
                                      disabled={isBatchVoided || usage.pendingQuantity === 0}
                                    />
                                    <button 
                                      type="submit" 
                                      disabled={isBatchVoided || usage.pendingQuantity === 0}
                                      className="bg-accent hover:bg-accent-hover text-white px-6 py-2 rounded shadow whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      新增序號
                                    </button>
                                  </form>
                                  {!isBatchVoided && usage.pendingQuantity === 0 && (
                                    <div className="text-success text-sm mt-2 flex items-center gap-1">
                                      ✓ 此批次序號已全數補齊
                                    </div>
                                  )}
                                </div>

                                {batchSerials.length === 0 ? (
                                  <div className="text-secondary/70 py-6 text-center border border-theme-border/50 border-dashed rounded-lg">
                                    此批次尚未登錄任何序號
                                  </div>
                                ) : (
                                  <div className="overflow-auto max-h-[300px]">
                                    <table className="w-full text-left border-collapse text-sm">
                                      <thead className="bg-card text-secondary sticky top-0">
                                        <tr>
                                          <th className="p-2 font-semibold border-b border-theme-border">序號</th>
                                          <th className="p-2 font-semibold border-b border-theme-border">狀態</th>
                                          <th className="p-2 font-semibold border-b border-theme-border">所在案場</th>
                                          <th className="p-2 font-semibold border-b border-theme-border">備註</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-theme-border/50">
                                        {batchSerials.map(s => {
                                          const proj = projects.find(p => p.id === s.project_id);
                                          return (
                                            <tr 
                                              key={s.id} 
                                              className="hover:bg-card/60 cursor-context-menu"
                                              onContextMenu={(e) => { e.preventDefault(); setSerialContextMenu({ visible: true, x: e.clientX, y: e.clientY, serialId: s.id }); }}
                                            >
                                              <td className="p-2 font-mono text-success">{s.serial_number}</td>
                                              <td className="p-2">
                                                <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${
                                                  s.status === '在庫' ? 'bg-success/20 text-success' :
                                                  s.status === '已出庫' ? 'bg-danger/20 text-danger' :
                                                  s.status === '已退回' ? 'bg-accent/20 text-accent' :
                                                  s.status === '作廢' ? 'bg-theme-border text-secondary/50 line-through' :
                                                  'bg-theme-border/50 text-secondary'
                                                }`}>
                                                  {s.status}
                                                </span>
                                              </td>
                                              <td className="p-2 text-secondary/90">{proj?.name || '-'}</td>
                                              <td className="p-2 text-secondary">{s.notes || '-'}</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'HISTORY' && (
                <div className="flex flex-col gap-4 h-full">
                  <h3 className="text-lg font-bold text-primary border-b border-theme-border/50 pb-2">品項異動流水 (最多 100 筆)</h3>
                  {transactions.length === 0 ? (
                    <div className="text-secondary/70 p-8 text-center bg-card/30 rounded-xl border border-theme-border/50 border-dashed">
                      目前沒有任何異動紀錄
                    </div>
                  ) : (
                    <div className="overflow-auto border border-theme-border rounded-lg">
                      <table className="w-full text-left border-collapse text-sm">
                        <thead className="bg-card text-secondary sticky top-0">
                          <tr>
                            <th className="p-3 font-semibold">日期</th>
                            <th className="p-3 font-semibold">類型</th>
                            <th className="p-3 font-semibold text-right">數量</th>
                            <th className="p-3 font-semibold">來源/案場</th>
                            <th className="p-3 font-semibold">經手人</th>
                            <th className="p-3 font-semibold">備註</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-theme-border/50">
                          {transactions.slice(0, 100).map(tx => {
                            const isInactive = !isActiveFormalTransaction(tx);
                            return (
                            <tr key={tx.id} className={`hover:bg-card/60 ${isInactive ? 'bg-page/50 opacity-60' : ''}`}>
                              <td className={`p-3 text-secondary ${isInactive ? 'line-through' : ''}`}>{tx.transaction_date}</td>
                              <td className="p-3">
                                <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${
                                  isInactive ? 'bg-theme-border text-secondary/50' :
                                  tx.transaction_type === 'IN' ? 'bg-success/20 text-success' :
                                  tx.transaction_type === 'OUT' ? 'bg-danger/20 text-danger' :
                                  tx.transaction_type === 'RETURN' ? 'bg-accent/20 text-accent' :
                                  'bg-warning/20 text-warning'
                                }`}>
                                  {tx.transaction_type === 'IN' ? '入庫' :
                                   tx.transaction_type === 'OUT' ? '出庫' :
                                   tx.transaction_type === 'RETURN' ? '退料' : '調整'}
                                  {tx.is_voided ? ' (已作廢)' : (isInactive ? ' (歷史)' : '')}
                                </span>
                              </td>
                              <td className={`p-3 text-right font-bold ${isInactive ? 'text-secondary/50 line-through' :
                                tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN' ? 'text-success' :
                                tx.transaction_type === 'OUT' ? 'text-danger' :
                                tx.quantity < 0 ? 'text-danger' : 'text-warning'
                              }`}>
                                {tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN' || (tx.transaction_type === 'ADJUST' && tx.quantity > 0) ? '+' : ''}{tx.quantity}
                              </td>
                              <td className={`p-3 ${isInactive ? 'text-secondary/50 line-through' : 'text-secondary/90'}`}>{tx.transaction_type === 'IN' ? tx.source : tx.project_name || '-'}</td>
                              <td className={`p-3 ${isInactive ? 'text-secondary/50 line-through' : 'text-secondary'}`}>{tx.handler || '-'}</td>
                              <td className={`p-3 max-w-[150px] truncate ${isInactive ? 'text-secondary/50 line-through' : 'text-secondary'}`} title={tx.notes || ''}>{tx.notes || '-'}</td>
                            </tr>
                          );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        )}

        {/* Serial Context Menu */}
        {serialContextMenu.visible && (
          <div 
            className="fixed z-[60] bg-card border border-theme-border rounded-lg shadow-2xl py-1 w-48 text-sm text-primary animate-in fade-in zoom-in-95 duration-100"
            style={{ top: serialContextMenu.y, left: serialContextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              className="w-full text-left px-4 py-2 hover:bg-danger/20 hover:text-danger text-danger flex items-center gap-2"
              onClick={() => {
                if (serialContextMenu.serialId) handleDeleteSerial(serialContextMenu.serialId);
                setSerialContextMenu({ visible: false, x: 0, y: 0, serialId: null });
              }}
            >
              <X size={16} />
              刪除此序號
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
