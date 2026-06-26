"use client";

import React, { useState, useEffect } from 'react';
import { InventoryTransaction, InventoryItem, Project, InventorySerial, InventoryTransactionSerial } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';

export default function SerialsPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [allSerials, setAllSerials] = useState<InventorySerial[]>([]);
  const [txSerials, setTxSerials] = useState<InventoryTransactionSerial[]>([]);
  
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    setIsLoading(true);
    const [itms, projs, txs, srls, txSrls] = await Promise.all([
      dbAdapter.getInventoryItems(),
      dbAdapter.getProjects(),
      dbAdapter.getInventoryTransactions(),
      dbAdapter.getInventorySerials(),
      dbAdapter.getInventoryTransactionSerials()
    ]);
    setItems(itms);
    setProjects(projs);
    setTransactions(txs);
    setAllSerials(srls);
    setTxSerials(txSrls);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const pendingList = txSerials.filter(s => s.is_pending);

  const handleFillPending = async (txSerialId: string, txId: string, inputSerial: string) => {
    if (!inputSerial.trim()) return alert("請輸入序號");
    const serialStr = inputSerial.trim();
    const tx = transactions.find(t => t.id === txId);
    if (!tx) return;

    let targetSerial = allSerials.find(s => s.serial_number === serialStr);
    
    // Step 7: Warning for auto-create during OUT pending fill
    if (tx.transaction_type === 'OUT' && !targetSerial) {
       if (!confirm(`警告：系統找不到序號「${serialStr}」的入庫紀錄！\n是否確定要補登？`)) {
         return;
       }
    }

    try {
      if (!targetSerial) {
        targetSerial = await dbAdapter.createInventorySerial({
          item_id: tx.item_id,
          batch_id: null,
          serial_number: serialStr,
          status: tx.transaction_type === 'OUT' ? '已出庫' : '在庫',
          project_id: tx.project_id,
          notes: tx.transaction_type === 'OUT' ? '出庫時待補登' : '入庫時待補登'
        });
      } else {
        await dbAdapter.updateInventorySerial(targetSerial.id, {
          status: tx.transaction_type === 'OUT' ? '已出庫' : '在庫',
          project_id: tx.transaction_type === 'OUT' ? tx.project_id : targetSerial.project_id
        });
      }

      await dbAdapter.updateInventoryTransactionSerial(txSerialId, {
        serial_id: targetSerial.id,
        serial_no: serialStr,
        is_pending: false
      });

      await fetchData();
    } catch(e) {
      console.error(e);
      alert('儲存失敗');
    }
  };

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-full gap-8">
      
      {/* 待補清單 */}
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold text-amber-400 flex items-center gap-2">
          <AlertCircle />
          待補序號清單 ({pendingList.length})
        </h2>
        
        {pendingList.length === 0 ? (
          <div className="bg-slate-800/30 border border-slate-700 p-8 rounded-xl text-center text-slate-400 flex flex-col items-center gap-2">
            <CheckCircle2 className="text-emerald-500 mb-2" size={40} />
            目前沒有需要補登的序號！
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingList.map(ps => {
              const tx = transactions.find(t => t.id === ps.transaction_id);
              const item = items.find(i => i.id === tx?.item_id);
              const proj = projects.find(p => p.id === tx?.project_id);
              const isOut = tx?.transaction_type === 'OUT';
              
              return (
                <div key={ps.id} className="bg-slate-800 border border-amber-500/30 p-4 rounded-xl flex flex-col gap-3 shadow-lg relative overflow-hidden">
                  <div className={`absolute top-0 left-0 w-1 h-full ${isOut ? 'bg-red-500' : 'bg-emerald-500'}`}></div>
                  <div className="flex justify-between items-start">
                    <div className="flex flex-col">
                      <span className="text-sm text-slate-400">{tx?.transaction_date} ({tx?.transaction_type})</span>
                      <span className="font-bold text-slate-200 mt-1">{item?.name}</span>
                    </div>
                    {isOut && <span className="bg-red-900/50 text-red-400 text-xs px-2 py-1 rounded font-semibold">出庫缺號</span>}
                    {!isOut && <span className="bg-emerald-900/50 text-emerald-400 text-xs px-2 py-1 rounded font-semibold">入庫缺號</span>}
                  </div>
                  
                  {proj && (
                    <div className="text-sm text-slate-300">
                      關聯案場：<span className="font-semibold text-amber-300">{proj.name}</span>
                    </div>
                  )}

                  <div className="mt-auto pt-2">
                    <form 
                      onSubmit={(e) => {
                        e.preventDefault();
                        const val = new FormData(e.currentTarget).get('serial') as string;
                        handleFillPending(ps.id, ps.transaction_id, val);
                      }}
                      className="flex gap-2"
                    >
                      <input 
                        type="text" name="serial" required
                        placeholder="請輸入或掃描序號..." 
                        className="bg-slate-900 border border-slate-600 rounded px-3 py-2 w-full outline-none focus:border-amber-500 text-sm"
                      />
                      <button type="submit" className="bg-amber-600 hover:bg-amber-500 text-white px-3 py-2 rounded text-sm font-semibold whitespace-nowrap transition">
                        補登
                      </button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 已註冊序號 */}
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold text-slate-200">所有序號總覽</h2>
        
        <div className="flex-1 overflow-auto bg-slate-800/30 border border-slate-700 rounded-xl max-h-[500px]">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800 text-slate-300 text-sm sticky top-0 z-10 border-b border-slate-700">
              <tr>
                <th className="p-4 font-semibold">序號</th>
                <th className="p-4 font-semibold">品項</th>
                <th className="p-4 font-semibold">狀態</th>
                <th className="p-4 font-semibold">目前案場</th>
                <th className="p-4 font-semibold">是否補登</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50 text-sm">
              {allSerials.map(s => {
                const item = items.find(i => i.id === s.item_id);
                const proj = projects.find(p => p.id === s.project_id);
                return (
                  <tr key={s.id} className="hover:bg-slate-700/30 transition-colors">
                    <td className="p-4 font-mono text-emerald-400 font-bold">{s.serial_number}</td>
                    <td className="p-4 text-slate-300">{item?.name}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                        s.status === '在庫' ? 'bg-emerald-500/20 text-emerald-400' :
                        s.status === '已出庫' ? 'bg-indigo-500/20 text-indigo-400' :
                        'bg-slate-600/50 text-slate-400'
                      }`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="p-4 text-amber-300">{proj?.name || '-'}</td>
                    <td className="p-4">
                      <span className="text-slate-500">-</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
