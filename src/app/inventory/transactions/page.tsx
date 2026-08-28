"use client";

import { useState, useEffect } from 'react';
import { InventoryTransaction, InventoryItem, Project, TransactionType, InventorySerial, isActiveFormalTransaction, InventorySerialLookupCandidate } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { TransactionForm } from '@/components/TransactionForm';
import { TransactionHistoryModal } from '@/components/TransactionHistoryModal';
import { useUser } from '@/components/UserContext';
import { Plus } from 'lucide-react';
import { format } from 'date-fns';
import { normalizeSerialInput } from '@/lib/inventory-serial-normalization';

const unwrapSettled = <T,>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
};

export default function TransactionsPage() {
  const { currentUser } = useUser();
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [balances, setBalances] = useState<{item_id:string, balance:number}[]>([]);
  const [allSerials, setAllSerials] = useState<InventorySerial[]>([]);
  const [txSerialsMapping, setTxSerialsMapping] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  
  const [hideVoided, setHideVoided] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<InventoryTransaction | null>(null);
  const [editingTxSerials, setEditingTxSerials] = useState<string[]>([]);
  const [historyTxId, setHistoryTxId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);

  const fetchData = async () => {
    setIsLoading(true);
    setLoadError(null);
    setLoadWarning(null);

    try {
      const results = await Promise.allSettled([
        dbAdapter.getInventoryTransactions(),
        dbAdapter.getInventoryItems(),
        dbAdapter.getProjects(),
        dbAdapter.getInventoryBalances(),
        dbAdapter.getInventorySerials(),
        dbAdapter.getInventoryTransactionSerials(),
        // @ts-ignore
        dbAdapter.getInventoryBatches ? dbAdapter.getInventoryBatches() : Promise.resolve([])
      ]);

      const [txsResult, itmsResult, projsResult, balsResult, srlsResult, txSrlsResult, bthsResult] = results;

      if (txsResult.status === 'rejected') throw txsResult.reason;

      const txs = unwrapSettled(txsResult) as InventoryTransaction[];
      const relatedResults = [
        ['getInventoryItems', itmsResult],
        ['getProjects', projsResult],
        ['getInventoryBalances', balsResult],
        ['getInventorySerials', srlsResult],
        ['getInventoryTransactionSerials', txSrlsResult],
        ['getInventoryBatches', bthsResult],
      ] as const;
      const relatedFailures = relatedResults
        .filter(([, result]) => result.status === 'rejected')
        .map(([name, result]) => {
          const reason = result.status === 'rejected' ? result.reason : null;
          return `${name}: ${reason?.message || String(reason || 'unknown error')}`;
        });

      const itms = itmsResult.status === 'fulfilled' ? itmsResult.value as InventoryItem[] : [];
      const projs = projsResult.status === 'fulfilled' ? projsResult.value as Project[] : [];
      const bals = balsResult.status === 'fulfilled' ? balsResult.value as { item_id: string; balance: number }[] : [];
      const srls = srlsResult.status === 'fulfilled' ? srlsResult.value as InventorySerial[] : [];
      const txSrls = txSrlsResult.status === 'fulfilled' ? txSrlsResult.value as any[] : [];
      const bths = bthsResult.status === 'fulfilled' ? bthsResult.value as any[] : [];

      if (relatedFailures.length > 0) {
        const warningMessage = relatedFailures.join(' | ');
        setLoadWarning(warningMessage);
      }

      setTransactions(txs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      setItems(itms);
      setProjects(projs);
      setBalances(bals);
      setAllSerials(srls);
      setTxSerialsMapping(txSrls);
      setBatches(bths);
    } catch (error: any) {
      console.error('Error loading inventory transactions:', error);
      const errorMessage = error?.message || 'Failed to load inventory transactions.';
      setTransactions([]);
      setLoadError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const formatSerialCandidates = (candidates: InventorySerialLookupCandidate[]) => (
    candidates
      .map(candidate => {
        const itemName = items.find(i => i.id === candidate.item_id)?.name || `未知品項 (${candidate.item_id.slice(0, 8)})`;
        return `${candidate.serial_number}｜${candidate.status}｜${itemName}`;
      })
      .join('\n')
  );

  const resolveTransactionSerialLinks = async (
    data: Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'> & { category?: string },
    serialsList: string[],
    allowedExistingSerialIds = new Set<string>(),
  ) => {
    const normalizedInputs = serialsList.map(normalizeSerialInput);
    if (new Set(normalizedInputs).size !== serialsList.length) {
      throw new Error('輸入的序號有重複，請檢查！');
    }

    const resolvedSerials: InventorySerial[] = [];
    for (const serialInput of serialsList) {
      const isOutLike = data.transaction_type === 'OUT' || data.transaction_type === 'RETURN';
      const lookup = await dbAdapter.lookupInventorySerial(serialInput, isOutLike
        ? { itemId: data.item_id, allowedStatuses: ['在庫'] }
        : {});

      if (lookup.result_type === 'ambiguous') {
        throw new Error(`找到多個可能相同的序號，請輸入完整序號或先確認資料：\n${formatSerialCandidates(lookup.candidates)}`);
      }

      const candidate = lookup.candidates[0];
      const isExistingLinkedSerial = !!candidate && allowedExistingSerialIds.has(candidate.id);

      if (isOutLike) {
        if (lookup.result_type === 'no_match') {
          throw new Error(`找不到此序號，無法出庫：\n${serialInput}`);
        }
        if (!candidate || (!candidate.is_allowed_candidate && !isExistingLinkedSerial)) {
          throw new Error(candidate
            ? `此序號目前狀態為 ${candidate.status}，不可再次出庫：\n${candidate.serial_number}`
            : `此序號不符合本次品項或狀態條件：\n${serialInput}`);
        }

        const existing = allSerials.find(x => x.id === candidate.id) || {
          ...candidate,
          batch_id: null,
          project_id: null,
          notes: null,
          created_at: '',
          updated_at: '',
        };
        resolvedSerials.push(existing);
        await dbAdapter.updateInventorySerial(candidate.id, {
          status: data.transaction_type === 'OUT' ? '已出庫' : '已退回',
          project_id: data.transaction_type === 'OUT' ? data.project_id : existing.project_id
        });
        continue;
      }

      if (lookup.result_type !== 'no_match') {
        if (candidate && isExistingLinkedSerial) {
          const existing = allSerials.find(x => x.id === candidate.id) || {
            ...candidate,
            batch_id: null,
            project_id: null,
            notes: null,
            created_at: '',
            updated_at: '',
          };
          resolvedSerials.push(existing);
          await dbAdapter.updateInventorySerial(candidate.id, {
            status: '在庫',
            project_id: existing.project_id
          });
          continue;
        }

        throw new Error(`此序號可能已存在，請勿重複新增：\n${candidate?.serial_number || serialInput}`);
      }

      const created = await dbAdapter.createInventorySerial({
        item_id: data.item_id,
        batch_id: null,
        serial_number: serialInput,
        status: '在庫',
        project_id: data.project_id,
        notes: '入庫時建立'
      });
      resolvedSerials.push(created);
    }

    return resolvedSerials.map(serial => ({
      serial_no: serial.serial_number,
      serial_id: serial.id,
      is_pending: false
    }));
  };

  const handleCreateTx = async (data: Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'> & { category?: string }, serialsInput: string, isPendingSerial: boolean = false) => {
    setIsSubmitting(true);
    try {
      const serialsList = serialsInput.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      const txSerials = await resolveTransactionSerialLinks(data, serialsList);

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
      const allowedExistingSerialIds = new Set(
        txSerialsMapping
          .filter(ts => ts.transaction_id === editingTx.id && ts.serial_id)
          .map(ts => ts.serial_id as string)
      );
      const txSerials = await resolveTransactionSerialLinks(data, serialsList, allowedExistingSerialIds);

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
    const transaction = transactions.find(tx => tx.id === id);
    if (transaction?.transaction_type === 'IN' && currentUser?.role !== 'ADMIN') {
      alert('僅限管理員作廢入庫紀錄。');
      return;
    }

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

  const visibleTransactions = hideVoided ? transactions.filter(tx => isActiveFormalTransaction(tx)) : transactions;

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-full">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold text-primary">庫存流水帳 (異動紀錄)</h2>
        <button 
          onClick={() => {
            setEditingTx(null);
            setEditingTxSerials([]);
            setIsModalOpen(true);
          }}
          disabled={currentUser?.role === 'VIEWER'}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} />
          新增異動 (IN/OUT/RETURN/ADJUST)
        </button>
      </div>

      <div className="mb-6 flex items-center justify-end">
        <label className="flex items-center gap-2 text-sm font-semibold text-secondary cursor-pointer hover:text-accent transition-colors">
          <input
            type="checkbox"
            checked={hideVoided}
            onChange={e => setHideVoided(e.target.checked)}
            className="rounded bg-card border-theme-border text-accent focus:ring-accent/50"
          />
          隱藏作廢
        </label>
      </div>
      {loadWarning && !loadError && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
          <div className="font-semibold text-amber-200">部分關聯資料讀取失敗，已先顯示交易主資料。</div>
          <div className="mt-1 break-words text-xs text-amber-100/80">{loadWarning}</div>
        </div>
      )}

      <div className="flex-1 overflow-auto bg-card/30 border border-theme-border rounded-xl relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-secondary">載入中...</div>
        ) : loadError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-danger text-center px-6">
            <div className="font-semibold mb-2">Inventory transactions failed to load.</div>
            <div className="text-sm text-danger/80 max-w-2xl break-words">{loadError}</div>
          </div>
        ) : visibleTransactions.length === 0 ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-secondary/70">
             目前無異動紀錄
           </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-card text-secondary text-sm sticky top-0 z-10 border-b border-theme-border">
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
            <tbody className="divide-y divide-theme-border/50 text-sm">
              {visibleTransactions.map(tx => {
                const item = items.find(i => i.id === tx.item_id);
                const proj = projects.find(p => p.id === tx.project_id);
                const isPositive = tx.transaction_type === 'IN' || tx.transaction_type === 'RETURN' || (tx.transaction_type === 'ADJUST' && tx.quantity > 0);
                const itemLabel = item?.name || `未知品項 (${tx.item_id})`;
                
                return (
                  <tr key={tx.id} className={`transition-colors ${tx.is_voided ? 'bg-card opacity-60' : 'hover:bg-card/60'}`}>
                    <td className={`p-4 text-secondary/80 ${tx.is_voided ? 'line-through' : ''}`}>{format(new Date(tx.transaction_date || tx.created_at), 'yyyy/MM/dd')}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                        tx.is_voided ? 'bg-theme-border text-secondary/70' :
                        tx.transaction_type === 'IN' ? 'bg-success/20 text-success' :
                        tx.transaction_type === 'OUT' ? 'bg-danger/20 text-danger' :
                        tx.transaction_type === 'RETURN' ? 'bg-accent/20 text-accent' :
                        'bg-warning/20 text-warning'
                      }`}>
                        {tx.transaction_type === 'IN' ? '入庫' :
                         tx.transaction_type === 'OUT' ? '出庫' :
                         tx.transaction_type === 'RETURN' ? '退料' : '調整'}
                         {tx.is_voided && ' (已作廢)'}
                      </span>
                    </td>
                    <td className={`p-4 font-medium ${tx.is_voided ? 'text-secondary/50 line-through' : 'text-primary'}`} title={item ? item.name : tx.item_id}>{itemLabel}</td>
                    <td className={`p-4 text-right font-bold text-lg ${tx.is_voided ? 'text-secondary/50 line-through' : isPositive ? 'text-success' : 'text-danger'}`}>
                      {isPositive ? '+' : tx.transaction_type === 'ADJUST' ? '' : '-'}{Math.abs(tx.quantity)}
                    </td>
                    <td className={`p-4 ${tx.is_voided ? 'text-secondary/50 line-through' : 'text-secondary'}`}>{tx.unit || item?.unit || '-'}</td>
                    <td className={`p-4 ${tx.is_voided ? 'text-secondary/50 line-through' : 'text-secondary/90'}`}>{tx.project_name || proj?.name || '-'}</td>
                    <td className={`p-4 ${tx.is_voided ? 'text-secondary/50 line-through' : 'text-secondary/90'}`}>{tx.handler || '-'}</td>
                    <td className={`p-4 max-w-[200px] truncate ${tx.is_voided ? 'text-secondary/50 line-through' : 'text-secondary'}`} title={tx.notes || ''}>{tx.notes || '-'}</td>
                    <td className="p-4 text-secondary/60 text-xs">{format(new Date(tx.created_at), 'yyyy/MM/dd HH:mm')}</td>
                    <td className="p-4 text-center space-x-2">
                      {!tx.is_voided && (
                        <>
                          <button onClick={() => openEditModal(tx)} disabled={currentUser?.role === 'VIEWER'} className="text-accent hover:text-accent-hover text-xs bg-accent/20 px-2 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed">編輯</button>
                          <button
                            onClick={() => handleVoidTx(tx.id)}
                            disabled={currentUser?.role === 'VIEWER' || (tx.transaction_type === 'IN' && currentUser?.role !== 'ADMIN')}
                            title={tx.transaction_type === 'IN' && currentUser?.role !== 'ADMIN' ? '僅限管理員作廢入庫紀錄' : undefined}
                            className="text-warning hover:text-warning/80 text-xs bg-warning/20 px-2 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            作廢
                          </button>
                        </>
                      )}
                      <button onClick={() => setHistoryTxId(tx.id)} className="text-secondary hover:text-primary text-xs bg-card border border-theme-border px-2 py-1 rounded">紀錄</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-page/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-theme-border p-6 rounded-2xl w-full max-w-3xl shadow-2xl overflow-auto max-h-[90vh]">
            <h2 className="text-2xl font-bold text-primary mb-6">{editingTx ? '修改異動紀錄' : '新增庫存異動'}</h2>
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
