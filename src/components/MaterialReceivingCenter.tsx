"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUser } from './UserContext';
import { MaterialReceiptHistoryDialog } from './MaterialReceiptHistoryDialog';
import { PendingListRow, ActualListRow } from './ReceivingV5Rows';
import { ActualArrivalComposer, PendingForm, ActionError, v5Button, v5Field, v5Primary } from './ReceivingV5Forms';
import { createReceivingV5Api, type CreateArrivalResult } from '@/lib/db/receiving-v5';
import { supabase } from '@/lib/db/supabaseClient';
import { actualRows, pendingRows, pendingKey, matchSourceKey, searchActual, searchPending, receivingError, type PendingRow, type ReceivingSnapshot, type ActualRow, type PendingKind } from '@/lib/receiving-v5';

const api = createReceivingV5Api(supabase);
export { ReceivingV6Center as MaterialReceivingCenter } from './ReceivingV6Center';
type HistoryTarget = { type: 'pending' | 'actual'; key: string };
export function MaterialReceivingCenterV5() {
  const { currentUser } = useUser();
  const canEdit = Boolean(currentUser && currentUser.role !== 'VIEWER');
  const [tab, setTab] = useState<'pending' | 'actual'>('pending');
  const [data, setData] = useState<ReceivingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [composer, setComposer] = useState<'pending' | 'actual' | null>(null);
  const [preferred, setPreferred] = useState<PendingRow>();
  const [history, setHistory] = useState<HistoryTarget | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});
  const generation = useRef({ value: 0 });
  const composerRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const ticket = ++generation.current.value;
    setError(''); setLoading(true);
    try {
      const next = await api.load();
      const states: Record<string, boolean> = {};
      const unresolved = next.lines.filter(l => l.resolution_state === 'UNRESOLVED');
      for (let start = 0; start < unresolved.length; start += 8) await Promise.all(unresolved.slice(start, start + 8).map(async line => {
        const results = await Promise.all(next.observations.filter(e => e.arrival_line_id === line.id && !e.retired_at).map(e => api.lookup(e.raw_serial)));
        states[line.id] = results.some(result => result.result_type !== 'no_match');
      }));
      if (ticket === generation.current.value) { setData(next); setConflicts(states); }
    } catch (e) { if (ticket === generation.current.value) setError(receivingError(e)); }
    finally { if (ticket === generation.current.value) setLoading(false); }
  }, []);
  useEffect(() => { const requests = generation.current; void load(); return () => { requests.value++; }; }, [load]);
  useEffect(() => { if (composer) composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [composer, preferred]);
  const pending = useMemo(() => data ? pendingRows(data) : [], [data]);
  const actual = useMemo(() => data ? actualRows(data) : [], [data]);
  const activePending = pending.filter(p => p.fulfilment.active && p.fulfilment.remaining > 0);
  const visiblePending = activePending.filter(p => searchPending(p, search));
  const visibleActual = actual.filter(a => searchActual(a, search) && (filter === 'all' || (filter === 'complete' ? a.state !== 'UNRESOLVED' : a.state === 'UNRESOLVED')));
  const changeTab = (value: 'pending' | 'actual') => { setTab(value); setComposer(null); setPreferred(undefined); setSearch(''); setNotice(''); };
  const arrived = async (result: CreateArrivalResult) => {
    // A persisted physical arrival is never re-submitted to repair a failed match or refresh.
    setComposer(null);
    const failed = result.matches.filter(m => m.status === 'CONFLICT');
    setNotice(failed.length ? '實際到貨已保存；待收對應尚未完成：' + failed.map(m => receivingError(new Error(m.message))).join('；') + ' 請在已收到列調整對應。' : '實際到貨已保存。');
    if (!preferred) { setTab('actual'); setSearch(''); setFilter('all'); setExpanded('arrival:' + result.lines[0]?.id); }
    setPreferred(undefined); await load();
  };
  const historyPending = history?.type === 'pending' ? pending.find(p => p.key === history.key) : undefined;
  const historyActual = history?.type === 'actual' ? actual.find(a => a.key === history.key) : undefined;
  return <section aria-label="物料到貨" className="min-h-0 min-w-0 rounded-xl border border-theme-border bg-card/50 min-[1100px]:h-[calc(100%-8.5rem)] min-[1100px]:overflow-y-auto">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-theme-border p-3">
      <div role="tablist" aria-label="物料到貨狀態" className="flex rounded-lg border border-theme-border bg-page p-1">
        <button type="button" role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? v5Primary : v5Button} onClick={() => changeTab('pending')}>待收 {activePending.length}</button>
        <button type="button" role="tab" aria-selected={tab === 'actual'} className={tab === 'actual' ? v5Primary : v5Button} onClick={() => changeTab('actual')}>已收到 {actual.length}</button>
      </div>
      <button type="button" disabled={!canEdit || !data || loading || Boolean(error)} className={v5Primary} onClick={() => { setPreferred(undefined); setComposer(tab === 'pending' ? 'pending' : 'actual'); setNotice(''); }}>{tab === 'pending' ? '＋新增北辦待收' : '＋新增到貨'}</button>
    </div>
    <div className="flex min-w-0 flex-wrap items-end gap-2 border-b border-theme-border p-3">
      <label className="min-w-0 basis-full text-sm sm:flex-1 sm:basis-0">搜尋<input type="search" aria-label="搜尋到貨" className={v5Field} value={search} onChange={e => setSearch(e.target.value)} placeholder={tab === 'pending' ? '品項、案件、預登序號' : '品項、案件、實際序號'} /></label>
      {tab === 'actual' && <label className="text-sm">資料狀態<select aria-label="到貨資料狀態" className={v5Field} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部</option><option value="complete">已完整</option><option value="incomplete">待補資料</option></select></label>}
      <button type="button" className={v5Button} disabled={loading} onClick={() => void load()}>重新整理</button>
    </div>
    <div className="min-w-0 space-y-3 p-3">
      <ActionError message={error} />{notice && <p role="status" className="break-words rounded-lg bg-accent/10 p-3 text-sm">{notice}</p>}
      {loading && <p role="status" className="text-sm text-secondary">載入物料到貨…</p>}
      <div ref={composerRef}>{data && composer === 'pending' && <PendingForm data={data} api={api} onClose={() => setComposer(null)} onSaved={async id => { setComposer(null); setTab('pending'); setSearch(''); setExpanded(pendingKey('SE_SUPPLY', id)); await load(); }} />}
        {data && composer === 'actual' && <ActualArrivalComposer key={preferred?.key || 'standalone'} data={data} api={api} preferred={preferred} onClose={() => { setComposer(null); setPreferred(undefined); }} onSaved={arrived} />}</div>
      {data && <div className="min-w-0 space-y-2" aria-label={tab === 'pending' ? '待收列表' : '已收到列表'}>
        {tab === 'pending' ? visiblePending.map(row => <PendingListRow key={row.key} row={row} data={data} api={api} expanded={expanded === row.key} canEdit={canEdit && !loading && !Boolean(error)} onToggle={() => setExpanded(expanded === row.key ? null : row.key)} onChanged={load} onArrival={() => { setPreferred(row); setComposer('actual'); setNotice(''); }} onHistory={() => setHistory({ type: 'pending', key: row.key })} />)
          : visibleActual.map(row => <ActualListRow key={row.key} row={row} data={data} pending={pending} api={api} expanded={expanded === row.key} conflict={Boolean(row.line && conflicts[row.line.id])} canEdit={canEdit && !loading && !Boolean(error)} onToggle={() => setExpanded(expanded === row.key ? null : row.key)} onChanged={load} onHistory={() => setHistory({ type: 'actual', key: row.key })} />)}
        {(tab === 'pending' ? visiblePending : visibleActual).length === 0 && !loading && <p className="p-5 text-center text-sm text-secondary">沒有符合的{tab === 'pending' ? '待收' : '到貨'}紀錄</p>}
      </div>}
      {tab === 'pending' && <><button type="button" className={v5Button} onClick={() => setShowHistory(value => !value)} aria-expanded={showHistory}>待收歷程</button>{showHistory && <ul className="space-y-2">{pending.filter(p => !p.fulfilment.active && searchPending(p, search)).map(p => <li key={p.key}><button type="button" className={v5Button + ' w-full break-words text-left'} onClick={() => setHistory({ type: 'pending', key: p.key })}>{p.label} · 原預計 {p.fulfilment.expected} · 實收 {p.fulfilment.fulfilled}{p.fulfilment.cancellation ? ' · 取消剩餘 ' + p.fulfilment.cancellation.cancelled_remaining : ' · 已結束'}</button></li>)}</ul>}</>}
    </div>
    {data && (historyPending || historyActual) && <ReceivingHistory data={data} pending={historyPending} actual={historyActual} onClose={() => setHistory(null)} onChanged={load} />}
  </section>;
}

function ReceivingHistory({ data, pending, actual, onClose, onChanged }: { data: ReceivingSnapshot; pending?: PendingRow; actual?: ActualRow; onClose: () => void; onChanged: () => Promise<void> }) {
  const matches = data.matches.filter(m => pending ? matchSourceKey(m) === pending.key : m.arrival_line_id === actual?.line?.id);
  const events: { id: string; at: string | null; label: string; description: string }[] = matches.flatMap(m => [
    { id: m.id, at: m.created_at, label: '待收對應', description: '對應 ' + m.quantity },
    ...(m.cancelled_at ? [{ id: m.id + ':cancel', at: m.cancelled_at, label: '對應已調整', description: '原對應 ' + m.quantity + ' 已解除' }] : []),
  ]);
  if (pending) events.unshift({ id: pending.key, at: null, label: '待收數量', description: '原預計 ' + pending.fulfilment.expected + ' · 實收 ' + pending.fulfilment.fulfilled + (pending.fulfilment.cancellation ? ' · 取消剩餘 ' + pending.fulfilment.cancellation.cancelled_remaining : '') });
  if (pending?.fulfilment.cancellation) events.push({ id: pending.key + ':cancel', at: pending.fulfilment.cancellation.cancelled_at, label: '取消剩餘待收', description: '取消時已收到 ' + pending.fulfilment.cancellation.fulfilled_at_cancellation + ' · 取消剩餘 ' + pending.fulfilment.cancellation.cancelled_remaining });
  if (actual?.arrival) events.unshift({ id: actual.key, at: actual.arrival.actual_received_at, label: '實際到貨', description: actual.quantity + ' ' + actual.unit + ' · ' + (actual.state === 'POSTED' ? '已入庫' : '尚未入庫') });
  const kind: PendingKind = pending?.kind || (actual?.receipt?.source_type === 'SE_SUPPLY' ? 'SE_SUPPLY' : 'PROJECT_MATERIAL');
  const id = pending?.id || actual?.receipt?.project_material_id || actual?.receipt?.se_supply_record_id || '';
  return <MaterialReceiptHistoryDialog receipts={data.receipts.filter(r => r.source_type !== 'ARRIVAL').map(r => ({ ...r, source_type: r.source_type as PendingKind }))}
    sourceType={kind} sourceId={id} itemLabel={pending?.label || actual?.label || ''} contextLabel={pending?.projectLabel || actual?.projectLabel} unit={pending?.unit || actual?.unit || ''}
    canEdit={false} onClose={onClose} onChanged={onChanged} events={events} />;
}
