"use client";

import React, { useState, useEffect } from 'react';
import { InventoryTransaction, InventoryItem, Project, InventorySerial } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { TransactionForm } from '@/components/TransactionForm';
import { TransactionHistoryModal } from '@/components/TransactionHistoryModal';
import { useUser } from '@/components/UserContext';
import { Plus, Search } from 'lucide-react';
import { format } from 'date-fns';

export default function TransactionsPage() {
  const { currentUser } = useUser();
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [balances, setBalances] = useState<{item_id:string, balance:number}[]>([]);
  const [allSerials, setAllSerials] = useState<InventorySerial[]>([]);
  const [txSerialsMapping, setTxSerialsMapping] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<InventoryTransaction | null>(null);
  const [editingTxSerials, setEditingTxSerials] = useState<string[]>([]);
  const [historyTxId, setHistoryTxId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    setIsLoading(true);
    const [txs, itms, projs, bals, srls, txSrls, bths] = await Promise.all([
      dbAdapter.getInventoryTransactions(),
      dbAdapter.getInventoryItems(),
      dbAdapter.getProjects(),
      dbAdapter.getInventoryBalances(),
      dbAdapter.getInventorySerials(),
      dbAdapter.getInventoryTransactionSerials(),
      // @ts-ignore
      dbAdapter.getInventoryBatches ? dbAdapter.getInventoryBatches() : Promise.resolve([])
    ]);
    setTransactions(txs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
    setItems(itms);
    setProjects(projs);
    setBalances(bals);
    setAllSerials(srls);
    setTxSerialsMapping(txSrls);
    setBatches(bths);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreateTx = async (data: Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'> & { category?: string }, serialsInput: string, isPendingSerial: boolean = false) => {
    setIsSubmitting(true);
    try {
      const serialsList = serialsInput.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      
      // Step 8: Serial check warning
      if (data.transaction_type === 'OUT' && serialsList.length > 0) {
        const unknownSerials = serialsList.filter(s => !allSerials.find(x => x.serial_number === s));
        if (unknownSerials.length > 0) {
          if (!confirm(`警告：系統找不到以下序號的入庫紀錄：\n${unknownSerials.join(', ')}\n\n是否確定要自動建立並標記為「補登序號」(is_auto_created: true)？`)) {
            setIsSubmitting(false);
            return;
          }
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
      const item = items.find(i => i.id === data.item_id);
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
      setIsModalOpen(false);
      setEditingTx(null);
      await fetchData();
    } catch (e) {
      console.error(e);
      alert('儲存失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateTx = async (data: any, serialsInput: string, isPendingSerial: boolean = false, editReason?: string) => {
    if (!editingTx) return;
    if (!editReason) return alert('缺少修改原因');
    setIsSubmitting(true);
    try {
      const serialsList = serialsInput.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      
      if (data.transaction_type === 'OUT' && serialsList.length > 0) {
        const unknownSerials = serialsList.filter(s => !allSerials.find(x => x.serial_number === s));
        if (unknownSerials.length > 0) {
          if (!confirm(`警告：系統找不到以下序號的入庫紀錄：\n${unknownSerials.join(', ')}\n\n是否確定要自動建立並標記為「補登序號」？`)) {
            setIsSubmitting(false);
            return;
          }
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
      const item = items.find(i => i.id === data.item_id);
      if (item?.requires_serial && data.transaction_type === 'IN') {
        const missingCount = data.quantity - serialsList.length;
        if (missingCount > 0) {
          pendingCount = missingCount;
        }
      }

      await dbAdapter.updateInventoryTransaction(editingTx.id, {
        ...data,
        pending_serial_count: pendingCount > 0 ? pendingCount : 0
      }, txSerials as any, editReason, currentUser?.name || '未知使用者');
      
      setIsModalOpen(false);
      setEditingTx(null);
      await fetchData();
    } catch (e) {
      console.error(e);
      alert('修改失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVoidTx = async (id: string) => {
    const reason = prompt('確定要作廢這筆紀錄嗎？請填寫作廢原因：');
    if (reason === null) return;
    if (reason.trim() === '') {
      alert('作廢失敗：必須填寫作廢原因！');
      return;
    }
    try {
      await dbAdapter.voidInventoryTransaction(id, reason.trim(), currentUser?.name || '未知使用者');
      await fetchData();
    } catch (e: any) {
      console.error(e);
      alert(e.message || '作廢失敗');
    }
  };

  const openEditModal = (tx: InventoryTransaction) => {
    const relatedTxSerials = txSerialsMapping.filter(ts => ts.transaction_id === tx.id);
    const relatedSerialNumbers = relatedTxSerials
      .map(ts => allSerials.find(s => s.id === ts.serial_id)?.serial_number)
      .filter(Boolean) as string[];

    setEditingTx(tx);
    setEditingTxSerials(relatedSerialNumbers);
    setIsModalOpen(true);
  };

  const filteredTx = transactions.filter(t => {
    const item = items.find(i => i.id === t.item_id);
    const search = searchTerm.toLowerCase();
    return item?.name.toLowerCase().includes(search) || item?.code.toLowerCase().includes(search) || t.transaction_type.toLowerCase().includes(search);
  });

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-full">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold text-slate-200">庫存流水帳 (異動紀錄)</h2>
        <button 
          onClick={() => {
            setEditingTx(null);
            setEditingTxSerials([]);
            setIsModalOpen(true);
          }}
          disabled={currentUser?.role === 'VIEWER'}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} />
          新增異動 (IN/OUT/RETURN/ADJUST)
        </button>
      </div>

      <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-xl mb-6 flex items-center gap-3">
        <Search className="text-slate-400" size={20} />
        <input 
          type="text" 
          placeholder="搜尋品項、類型..." 
          className="bg-transparent border-none outline-none text-slate-200 w-full placeholder:text-slate-500"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-auto bg-slate-800/30 border border-slate-700 rounded-xl relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400">載入中...</div>
        ) : filteredTx.length === 0 ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
             目前無異動紀錄
           </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800 text-slate-300 text-sm sticky top-0 z-10 border-b border-slate-700">
              <tr>
                <th className="p-4 font-semibold">日期</th>
                <th className="p-4 font-semibold">類型</th>
                <th className="p-4 font-semibold">品項</th>
                <th className="p-4 font-semibold text-right">數量</th>
                <th className="p-4 font-semibold">單位</th>
                <th className="p-4 font-semibold">案場</th>
                <th className="p-4 font-semibold">經手人</th>
                <th className="p-4 font-semibold">備註</th>
                <th className="p-4 font-semibold">建立時間</th>
                <th className="p-4 font-semibold text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50 text-sm">
              {filteredTx.map(tx => {
                const item = items.find(i => i.id === tx.item_id);
                const proj = projects.find(p => p.id === tx.project_id);
                const isPositive = tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN' || (tx.transaction_type === 'ADJUST' && tx.quantity > 0);
                
                return (
                  <tr key={tx.id} className={`transition-colors ${tx.is_voided ? 'bg-slate-900/50 opacity-60' : 'hover:bg-slate-700/30'}`}>
                    <td className={`p-4 text-slate-400 ${tx.is_voided ? 'line-through' : ''}`}>{format(new Date(tx.transaction_date || tx.created_at), 'yyyy/MM/dd')}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                        tx.is_voided ? 'bg-slate-800 text-slate-500' :
                        tx.transaction_type === 'IN' ? 'bg-emerald-900/50 text-emerald-400' :
                        tx.transaction_type === 'OUT' ? 'bg-red-900/50 text-red-400' :
                        tx.transaction_type === 'RETURN' ? 'bg-indigo-900/50 text-indigo-400' :
                        'bg-amber-900/50 text-amber-400'
                      }`}>
                        {tx.transaction_type === 'IN' ? '入庫' :
                         tx.transaction_type === 'OUT' ? '出庫' :
                         tx.transaction_type === 'RETURN' ? '退料' : '調整'}
                         {tx.is_voided && ' (已作廢)'}
                      </span>
                    </td>
                    <td className={`p-4 font-medium ${tx.is_voided ? 'text-slate-500 line-through' : 'text-slate-100'}`}>{item?.name}</td>
                    <td className={`p-4 text-right font-bold text-lg ${tx.is_voided ? 'text-slate-500 line-through' : isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                      {isPositive ? '+' : tx.transaction_type === 'ADJUST' ? '' : '-'}{Math.abs(tx.quantity)}
                    </td>
                    <td className={`p-4 ${tx.is_voided ? 'text-slate-600 line-through' : 'text-slate-400'}`}>{tx.unit || item?.unit || '-'}</td>
                    <td className={`p-4 ${tx.is_voided ? 'text-slate-600 line-through' : 'text-slate-300'}`}>{tx.project_name || proj?.name || '-'}</td>
                    <td className={`p-4 ${tx.is_voided ? 'text-slate-600 line-through' : 'text-slate-300'}`}>{tx.handler || '-'}</td>
                    <td className={`p-4 max-w-[200px] truncate ${tx.is_voided ? 'text-slate-600 line-through' : 'text-slate-400'}`} title={tx.notes || ''}>{tx.notes || '-'}</td>
                    <td className="p-4 text-slate-500 text-xs">{format(new Date(tx.created_at), 'yyyy/MM/dd HH:mm')}</td>
                    <td className="p-4 text-center space-x-2">
                      {!tx.is_voided && (
                        <>
                          <button onClick={() => openEditModal(tx)} disabled={currentUser?.role === 'VIEWER'} className="text-indigo-400 hover:text-indigo-300 text-xs bg-indigo-900/30 px-2 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed">編輯</button>
                          <button onClick={() => handleVoidTx(tx.id)} disabled={currentUser?.role === 'VIEWER'} className="text-amber-400 hover:text-amber-300 text-xs bg-amber-900/30 px-2 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed">作廢</button>
                        </>
                      )}
                      <button onClick={() => setHistoryTxId(tx.id)} className="text-slate-400 hover:text-slate-300 text-xs bg-slate-800 px-2 py-1 rounded">紀錄</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-6 rounded-2xl w-full max-w-3xl shadow-2xl overflow-auto max-h-[90vh]">
            <h2 className="text-2xl font-bold text-slate-100 mb-6">{editingTx ? '修改異動紀錄' : '新增庫存異動'}</h2>
            <TransactionForm 
              items={items.filter(i => i.is_active)}
              projects={projects.filter(p => p.is_active)}
              balances={balances}
              allSerials={allSerials}
              batches={batches}
              initialData={editingTx || undefined}
              initialSerials={editingTxSerials}
              onSubmit={editingTx ? handleUpdateTx : handleCreateTx as any}
              onCancel={() => {
                setIsModalOpen(false);
                setEditingTx(null);
              }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}

      {historyTxId && (
        <TransactionHistoryModal 
          transactionId={historyTxId} 
          onClose={() => setHistoryTxId(null)} 
        />
      )}
    </div>
  );
}
