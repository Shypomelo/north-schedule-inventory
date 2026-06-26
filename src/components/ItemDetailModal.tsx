"use client";

import React, { useState, useEffect, useRef } from 'react';
import { InventoryItem, InventoryTransaction, InventorySerial, Project, InventoryBatch } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { X, Box, History, List, ChevronDown, ChevronUp } from 'lucide-react';
import { format } from 'date-fns';

interface ItemDetailModalProps {
  itemId: string | null;
  onClose: () => void;
  onItemUpdated: () => void;
}

type TabKey = 'SUMMARY' | 'BATCHES' | 'HISTORY';

export function ItemDetailModal({ itemId, onClose, onItemUpdated }: ItemDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('SUMMARY');
  
  const [item, setItem] = useState<InventoryItem | null>(null);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [newSerialNo, setNewSerialNo] = useState('');
  const serialInputRef = useRef<HTMLInputElement>(null);
  const [serialContextMenu, setSerialContextMenu] = useState<{ visible: boolean, x: number, y: number, serialId: string | null }>({ visible: false, x: 0, y: 0, serialId: null });

  useEffect(() => {
    async function load() {
      if (!itemId) return;
      setIsLoading(true);
      const [itms, txs, srls, projs, allBatches] = await Promise.all([
        dbAdapter.getInventoryItems(),
        dbAdapter.getInventoryTransactions(),
        dbAdapter.getInventorySerials(),
        dbAdapter.getProjects(),
        // @ts-ignore
        dbAdapter.getInventoryBatches ? dbAdapter.getInventoryBatches() : Promise.resolve([])
      ]);
      const found = itms.find(i => i.id === itemId);
      setItem(found || null);
      
      setTransactions(txs.filter(t => t.item_id === itemId && !t.is_voided).sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      setSerials(srls.filter(s => s.item_id === itemId));
      setProjects(projs);
      setBatches(allBatches.filter((b: InventoryBatch) => b.item_id === itemId).sort((a: InventoryBatch, b: InventoryBatch) => new Date(b.in_date).getTime() - new Date(a.in_date).getTime()));
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

  if (!itemId) return null;

  let opening = item?.opening_quantity || 0;
  let currentBalance = opening;
  
  const now = new Date();
  const currentMonthPrefix = format(now, 'yyyy-MM');
  let monthIn = 0;
  let monthOut = 0;

  transactions.forEach(tx => {
    if (tx.transaction_type === 'IN') currentBalance += tx.quantity;
    if (tx.transaction_type === 'OUT') currentBalance -= tx.quantity;
    if (tx.transaction_type === 'RETURN') currentBalance += tx.quantity;
    if (tx.transaction_type === 'ADJUST') currentBalance += tx.quantity;

    if (tx.transaction_date.startsWith(currentMonthPrefix)) {
      if (tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN') {
        monthIn += tx.quantity;
      } else if (tx.transaction_type === 'OUT') {
        monthOut += tx.quantity;
      }
    }
  });

  const registered_serials = serials.filter(s => s.status === '在庫').length;
  const pending_serials = item?.requires_serial ? Math.max(0, currentBalance - registered_serials) : 0;

  const handleManualRegisterSerial = async (e: React.FormEvent, batchId: string) => {
    e.preventDefault();
    if (!newSerialNo.trim() || !item) return;
    
    const serialStr = newSerialNo.trim();
    const allSerials = await dbAdapter.getInventorySerials();
    if (allSerials.some(s => s.serial_number === serialStr)) {
      alert('此序號已存在系統中！');
      return;
    }

    const batch = batches.find(b => b.id === batchId);
    if (!batch) return;

    const batchSerialsCount = serials.filter(s => s.batch_id === batchId).length;
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
    if (!item) return;
    try {
      const updated = await dbAdapter.updateInventoryItem(item.id, { source_type: newSource });
      setItem(updated);
      onItemUpdated();
    } catch(e) {
      console.error(e);
      alert('更新失敗');
    }
  };

  const tabs = [
    { key: 'SUMMARY', label: '庫存摘要', icon: Box },
    { key: 'BATCHES', label: item?.requires_serial ? '入庫批次 / 序號' : '入庫批次', icon: List },
    { key: 'HISTORY', label: '流水紀錄', icon: History },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-slate-900 border border-slate-700 w-full max-w-5xl h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-slate-700/50 bg-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <Box size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100">{item?.name}</h2>
              <p className="text-sm text-slate-400">品項詳細資料與狀態</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition-colors">
            <X size={24} />
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">載入中...</div>
        ) : (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Sidebar Navigation */}
            <div className="w-full md:w-64 bg-slate-800/20 border-r border-slate-700/50 p-4 overflow-y-auto">
              <div className="flex flex-col gap-2">
                {tabs.map(t => (
                  <button
                    key={t.key}
                    onClick={() => setActiveTab(t.key as TabKey)}
                    className={`flex items-center gap-3 w-full p-3 rounded-lg text-sm font-medium transition-all ${
                      activeTab === t.key 
                        ? 'bg-indigo-600 text-white shadow-md' 
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <t.icon size={18} />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 p-6 overflow-y-auto bg-slate-900/50">
              
              {activeTab === 'SUMMARY' && (
                <div className="flex flex-col gap-5 max-w-2xl">
                  <h3 className="text-lg font-bold text-slate-200 border-b border-slate-700/50 pb-2">庫存摘要</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                      <div className="text-sm text-slate-400 mb-1">品名</div>
                      <div className="text-lg text-slate-200">{item?.name}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                      <div className="text-sm text-slate-400 mb-1">來源</div>
                      <select 
                        value={item?.source_type || ''}
                        onChange={(e) => handleUpdateSource(e.target.value)}
                        className="bg-transparent text-lg font-medium text-slate-200 outline-none w-full border-b border-dashed border-slate-600 focus:border-indigo-400 cursor-pointer"
                      >
                        <option value="陽光" className="bg-slate-800">陽光</option>
                        <option value="中部移轉" className="bg-slate-800">中部移轉</option>
                        <option value="南部移轉" className="bg-slate-800">南部移轉</option>
                        <option value="其他" className="bg-slate-800">其他</option>
                      </select>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                      <div className="text-sm text-slate-400 mb-1">類型</div>
                      <div className="text-lg text-slate-200">{item?.requires_serial ? '設備 (管序號)' : '維修用品 (僅數量)'}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                      <div className="text-sm text-slate-400 mb-1">目前狀態</div>
                      <div className="text-lg text-slate-200">
                         {currentBalance <= (item?.low_stock_threshold || 0) && currentBalance > 0 ? (
                            <span className="text-amber-400 font-bold">低庫存</span>
                          ) : currentBalance === 0 ? (
                            <span className="text-red-400 font-bold">已缺貨</span>
                          ) : (
                            <span className="text-emerald-400 font-bold">庫存充足</span>
                          )}
                      </div>
                    </div>
                  </div>

                  <h3 className="text-md font-bold text-slate-300 mt-4 border-b border-slate-700/50 pb-2">本月動態</h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="bg-indigo-900/20 p-4 rounded-xl border border-indigo-700/30 flex flex-col items-center">
                      <span className="text-sm text-indigo-300 mb-1">目前庫存</span>
                      <span className="text-3xl font-bold text-indigo-400">{currentBalance}</span>
                    </div>
                    <div className="bg-emerald-900/20 p-4 rounded-xl border border-emerald-700/30 flex flex-col items-center">
                      <span className="text-sm text-emerald-300 mb-1">本月入庫</span>
                      <span className="text-3xl font-bold text-emerald-400">+{monthIn}</span>
                    </div>
                    <div className="bg-red-900/20 p-4 rounded-xl border border-red-700/30 flex flex-col items-center">
                      <span className="text-sm text-red-300 mb-1">本月出庫</span>
                      <span className="text-3xl font-bold text-red-400">-{monthOut}</span>
                    </div>
                  </div>

                  {item?.requires_serial && (
                    <>
                      <h3 className="text-md font-bold text-slate-300 mt-4 border-b border-slate-700/50 pb-2">序號狀態</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-emerald-900/20 p-4 rounded-xl border border-emerald-700/30 flex flex-col items-center">
                          <span className="text-sm text-emerald-300 mb-1">已登序號 (庫存中)</span>
                          <span className="text-2xl font-bold text-emerald-400">{registered_serials}</span>
                        </div>
                        <div className="bg-amber-900/20 p-4 rounded-xl border border-amber-700/30 flex flex-col items-center">
                          <span className="text-sm text-amber-300 mb-1">待補序號</span>
                          <span className={`text-2xl font-bold ${pending_serials > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{pending_serials}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'BATCHES' && (
                <div className="flex flex-col gap-4 h-full">
                  <div className="flex justify-between items-center border-b border-slate-700/50 pb-2">
                    <h3 className="text-lg font-bold text-slate-200">{item?.requires_serial ? '入庫批次 / 序號明細' : '入庫批次列表'}</h3>
                  </div>

                  {batches.length === 0 ? (
                    <div className="text-slate-500 p-8 text-center bg-slate-800/30 rounded-xl border border-slate-700/50 border-dashed">
                      目前沒有任何入庫批次紀錄
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {batches.map(batch => {
                        // @ts-ignore
                        const batchSerials = serials.filter(s => s.batch_id === batch.id);
                        const registeredBatchSerials = batchSerials.filter(s => s.status === '在庫').length;
                        const pendingBatchSerials = Math.max(0, batch.quantity - batchSerials.length);
                        const isExpanded = expandedBatchId === batch.id;

                        return (
                          <div key={batch.id} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
                            <div 
                              className={`flex items-center justify-between p-4 cursor-pointer hover:bg-slate-700/50 transition ${isExpanded ? 'bg-slate-700/50' : ''}`}
                              onClick={() => setExpandedBatchId(isExpanded ? null : batch.id)}
                            >
                              <div className="flex items-center gap-6 flex-1">
                                <div>
                                  <div className="text-sm text-slate-400">批次號</div>
                                  <div className="font-mono text-indigo-400 font-semibold">{batch.batch_number}</div>
                                </div>
                                <div>
                                  <div className="text-sm text-slate-400">入庫日期</div>
                                  <div className="text-slate-200">{batch.in_date}</div>
                                </div>
                                <div>
                                  <div className="text-sm text-slate-400">來源</div>
                                  <div className="text-slate-200">{batch.source || '-'}</div>
                                </div>
                                <div>
                                  <div className="text-sm text-slate-400">數量</div>
                                  <div className="text-slate-200 font-bold text-lg">{batch.quantity}</div>
                                </div>
                                {item?.requires_serial && (
                                  <>
                                    <div>
                                      <div className="text-sm text-slate-400">已登(庫存中)</div>
                                      <div className="text-emerald-400 font-bold">{registeredBatchSerials}</div>
                                    </div>
                                    <div>
                                      <div className="text-sm text-slate-400">待補</div>
                                      <div className={`font-bold ${pendingBatchSerials > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{pendingBatchSerials}</div>
                                    </div>
                                  </>
                                )}
                              </div>
                              <div className="text-slate-400 flex items-center gap-2">
                                {item?.requires_serial && (
                                  <span className="text-sm bg-indigo-600/30 text-indigo-300 px-3 py-1 rounded-full">
                                    {isExpanded ? '收合序號' : '查看/補登序號'}
                                  </span>
                                )}
                                {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                              </div>
                            </div>
                            
                            {isExpanded && item?.requires_serial && (
                              <div className="p-4 border-t border-slate-700 bg-slate-900/50">
                                
                                <div className="mb-4">
                                  <form onSubmit={(e) => handleManualRegisterSerial(e, batch.id)} className="flex gap-2">
                                    <input 
                                      ref={serialInputRef}
                                      type="text" 
                                      placeholder="連續刷條碼補登序號 (按 Enter 加入)..." 
                                      className="flex-1 bg-slate-950 border border-indigo-500/50 rounded p-2 text-slate-100 outline-none focus:border-indigo-400"
                                      value={newSerialNo}
                                      onChange={e => setNewSerialNo(e.target.value)}
                                      disabled={pendingBatchSerials === 0}
                                    />
                                    <button 
                                      type="submit" 
                                      disabled={pendingBatchSerials === 0}
                                      className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded shadow whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      新增序號
                                    </button>
                                  </form>
                                  {pendingBatchSerials === 0 && (
                                    <div className="text-emerald-400 text-sm mt-2 flex items-center gap-1">
                                      ✓ 此批次序號已全數補齊
                                    </div>
                                  )}
                                </div>

                                {batchSerials.length === 0 ? (
                                  <div className="text-slate-500 py-6 text-center border border-slate-700/50 border-dashed rounded-lg">
                                    此批次尚未登錄任何序號
                                  </div>
                                ) : (
                                  <div className="overflow-auto max-h-[300px]">
                                    <table className="w-full text-left border-collapse text-sm">
                                      <thead className="bg-slate-800 text-slate-300 sticky top-0">
                                        <tr>
                                          <th className="p-2 font-semibold border-b border-slate-700">序號</th>
                                          <th className="p-2 font-semibold border-b border-slate-700">狀態</th>
                                          <th className="p-2 font-semibold border-b border-slate-700">所在案場</th>
                                          <th className="p-2 font-semibold border-b border-slate-700">備註</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-700/50">
                                        {batchSerials.map(s => {
                                          const proj = projects.find(p => p.id === s.project_id);
                                          return (
                                            <tr 
                                              key={s.id} 
                                              className="hover:bg-slate-800/50 cursor-context-menu"
                                              onContextMenu={(e) => { e.preventDefault(); setSerialContextMenu({ visible: true, x: e.clientX, y: e.clientY, serialId: s.id }); }}
                                            >
                                              <td className="p-2 font-mono text-emerald-400">{s.serial_number}</td>
                                              <td className="p-2">
                                                <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${
                                                  s.status === '在庫' ? 'bg-emerald-500/20 text-emerald-400' :
                                                  s.status === '已出庫' ? 'bg-red-500/20 text-red-400' :
                                                  s.status === '已退回' ? 'bg-indigo-500/20 text-indigo-400' :
                                                  'bg-slate-600/50 text-slate-400'
                                                }`}>
                                                  {s.status}
                                                </span>
                                              </td>
                                              <td className="p-2 text-slate-300">{proj?.name || '-'}</td>
                                              <td className="p-2 text-slate-400">{s.notes || '-'}</td>
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
                  <h3 className="text-lg font-bold text-slate-200 border-b border-slate-700/50 pb-2">品項異動流水 (最多 100 筆)</h3>
                  {transactions.length === 0 ? (
                    <div className="text-slate-500 p-8 text-center bg-slate-800/30 rounded-xl border border-slate-700/50 border-dashed">
                      目前沒有任何異動紀錄
                    </div>
                  ) : (
                    <div className="overflow-auto border border-slate-700 rounded-lg">
                      <table className="w-full text-left border-collapse text-sm">
                        <thead className="bg-slate-800 text-slate-300 sticky top-0">
                          <tr>
                            <th className="p-3 font-semibold">日期</th>
                            <th className="p-3 font-semibold">類型</th>
                            <th className="p-3 font-semibold text-right">數量</th>
                            <th className="p-3 font-semibold">來源/案場</th>
                            <th className="p-3 font-semibold">經手人</th>
                            <th className="p-3 font-semibold">備註</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/50">
                          {transactions.slice(0, 100).map(tx => (
                            <tr key={tx.id} className="hover:bg-slate-800/50">
                              <td className="p-3 text-slate-400">{tx.transaction_date}</td>
                              <td className="p-3">
                                <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${
                                  tx.transaction_type === 'IN' ? 'bg-emerald-900/50 text-emerald-400' :
                                  tx.transaction_type === 'OUT' ? 'bg-red-900/50 text-red-400' :
                                  tx.transaction_type === 'RETURN' ? 'bg-indigo-900/50 text-indigo-400' :
                                  'bg-amber-900/50 text-amber-400'
                                }`}>
                                  {tx.transaction_type === 'IN' ? '入庫' :
                                   tx.transaction_type === 'OUT' ? '出庫' :
                                   tx.transaction_type === 'RETURN' ? '退料' : '調整'}
                                </span>
                              </td>
                              <td className={`p-3 text-right font-bold ${
                                tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN' ? 'text-emerald-400' :
                                tx.transaction_type === 'OUT' ? 'text-red-400' :
                                tx.quantity < 0 ? 'text-red-400' : 'text-amber-400'
                              }`}>
                                {tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN' || (tx.transaction_type === 'ADJUST' && tx.quantity > 0) ? '+' : ''}{tx.quantity}
                              </td>
                              <td className="p-3 text-slate-300">{tx.transaction_type === 'IN' ? tx.source : tx.project_name || '-'}</td>
                              <td className="p-3 text-slate-400">{tx.handler || '-'}</td>
                              <td className="p-3 text-slate-400 max-w-[150px] truncate" title={tx.notes || ''}>{tx.notes || '-'}</td>
                            </tr>
                          ))}
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
            className="fixed z-[60] bg-slate-800 border border-slate-600 rounded-lg shadow-2xl py-1 w-48 text-sm text-slate-200 animate-in fade-in zoom-in-95 duration-100"
            style={{ top: serialContextMenu.y, left: serialContextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              className="w-full text-left px-4 py-2 hover:bg-red-600/20 hover:text-red-400 text-red-400 flex items-center gap-2"
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
