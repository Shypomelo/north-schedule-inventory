'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { useUser } from './UserContext';
import { supabase } from '@/lib/db/supabaseClient';
import { createReceivingV6Api } from '@/lib/db/receiving-v6';
import {
  receivedItemGroups, receivingHistory, receivingPendingList, receivingWorkItems,
  type ReceivedGroup, type ReceivingHistoryRow, type ReceivingV6Snapshot,
} from '@/lib/receiving-v6';
import { receivingError, searchPending, type PendingRow } from '@/lib/receiving-v5';
import { receivingBatchMatches, receivingBatchViews, receivingTaipeiDay } from '@/lib/receiving-batch-view';
import { formatReceivingQuantity, formatTaipeiReceivingTime } from '@/lib/material-receiving';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import { ReceivingWorkBody, ReceivingWorkModal } from './ReceivingWorkModal';
import { ReceivingV6Composer } from './ReceivingV6Composer';
import { ReceivingThreeWayDetail } from './ReceivingThreeWayDetail';
import { ReceivingReturnDetail } from './ReceivingReturnDetail';
import { ReceivingPendingDeleteConfirm } from './ReceivingPendingDeleteConfirm';
import { useReceivingActionMenu, type ReceivingActionTarget } from './ReceivingActionMenu';
import { ActionError, v5Button, v5Primary } from './ReceivingV5Forms';
import { ReceivingPendingBatchForm } from './ReceivingPendingBatchForm';

const api = createReceivingV6Api(supabase);
type Tab = 'pending' | 'received' | 'history';
type Dialog = { kind: 'work'; key: string } | { kind: 'received'; key: string; mode: 'inventory' | 'SE' | 'SITE' | 'resolve' | 'cancel' } | { kind: 'return'; key: string } | { kind: 'pending' } | { kind: 'actual' };
const shortTime = (value: string | null) => value ? new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value)) : '時間未定';
const stateLabel = (state: 'STAGED' | 'UNRESOLVED' | 'POSTED' | 'LEGACY') => ({
  STAGED: '待入庫', UNRESOLVED: '待補資料', POSTED: '已入庫', LEGACY: '歷史收貨',
})[state];
const pendingMenuTarget = (row: PendingRow, canEdit: boolean): ReceivingActionTarget => ({ type: 'pending', key: row.key, receiptId: null,
  arrivalLineIds: [], state: row.fulfilment.remaining_status,
  pendingSource: { type: row.kind, id: row.id, updatedAt: row.updatedAt },
  actions: [{ id: 'view', label: '查看明細' }, ...(canEdit && row.updatedAt && row.fulfilment.fulfilled === 0 && !row.legacy
    ? [{ id: 'delete' as const, label: '刪除' }] : [])] });
const receivedMenuTarget = (group: ReceivedGroup, canEdit: boolean): ReceivingActionTarget => ({ type: 'received', key: group.key, receiptId: null,
  arrivalLineIds: Array.from(new Set(group.rows.map(row => row.line?.id).filter((id): id is string => Boolean(id)))),
  state: group.stages.map(stage => stage.kind).join(',') || group.states.join(','),
  actions: !canEdit || (!group.stages.length && !group.states.includes('UNRESOLVED'))
    ? [{ id: 'view', label: '查看明細' }] : group.states.includes('UNRESOLVED')
    ? [{ id: 'resolve', label: '補資料' }, { id: 'cancel-arrival', label: '取消實際到貨' }]
    : [{ id: 'post', label: '進北辦庫存' }, { id: 'route-se', label: '加入 SE 供貨追蹤' },
      { id: 'route-site', label: '送至案場' }, { id: 'cancel-arrival', label: '取消實際到貨' }] });
const historyMenuTarget = (row: ReceivingHistoryRow, canEdit: boolean): ReceivingActionTarget => ({ type: 'history', key: row.id,
  receiptId: row.receiptId, arrivalLineIds: row.arrivalLineId ? [row.arrivalLineId] : [], state: row.state,
  actions: canEdit && row.returnToReceived ? [{ id: 'return', label: '退回到已收到' }] : [] });

export function ReceivingV6Center() {
  const { currentUser } = useUser();
  const canEdit = Boolean(currentUser && currentUser.role !== 'VIEWER');
  const [data, setData] = useState<ReceivingV6Snapshot | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [tab, setTab] = useState<Tab>('pending');
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; label: string; source: NonNullable<ReceivingActionTarget['pendingSource']> } | null>(null);
  const actionMenu = useReceivingActionMenu((target, action) => {
    if (action === 'return' && target.type === 'history') setDialog({ kind: 'return', key: target.key });
    else if (target.type === 'received') {
      const group = received.find(value => value.key === target.key);
      setDialog({ kind: 'received', key: target.key, mode: action === 'route-se' ? 'SE' : action === 'route-site' ? 'SITE'
        : action === 'cancel-arrival' ? 'cancel' : action === 'resolve' || group?.states.includes('UNRESOLVED') ? 'resolve' : 'inventory' });
    }
    else if (action === 'delete' && target.type === 'pending' && target.pendingSource) {
      const row = pending.find(value => value.key === target.key);
      if (row) setDeleteTarget({ key: target.key, label: row.label, source: target.pendingSource });
    }
    else if (action === 'view' && target.type === 'pending') setDialog({ kind: 'work', key: target.key });
  });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++generation.current; setLoading(true); setError('');
    try {
      const next = await api.load();
      receivingWorkItems(next); // Preserve the existing quantity and serial consistency check.
      receivingPendingList(next); receivedItemGroups(next); receivingHistory(next);
      if (ticket === generation.current) { setData(next); return next; }
    } catch (cause) { if (ticket === generation.current) setError(receivingError(cause)); }
    finally { if (ticket === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { const requestGeneration = generation; void load(); return () => { requestGeneration.current++; }; }, [load]);

  const pending = useMemo(() => data ? receivingPendingList(data) : [], [data]);
  const history = useMemo(() => data ? receivingHistory(data) : [], [data]);
  const batches = useMemo(() => data ? receivingBatchViews(data, history) : [], [data, history]);
  const today = receivingTaipeiDay(new Date().toISOString());
  const recentBatches = batches.filter(batch => !batch.arrival.voided_at && (batch.day === today || batch.workCount > 0));
  const received = recentBatches.flatMap(batch => batch.groups);
  const workRows = useMemo(() => data ? receivingWorkItems(data) : [], [data]);
  const needle = query.trim().toLocaleLowerCase();
  const shownPending = pending.filter(row => searchPending(row, needle));
  const shownReceived = recentBatches.filter(batch => receivingBatchMatches(batch, needle));
  const shownHistory = batches.filter(batch => receivingBatchMatches(batch, needle));
  const standaloneHistory = history.filter(row => !row.arrivalLineId && [row.item, row.actor, row.type, row.state, row.projectLabel, row.at]
    .join(' ').toLocaleLowerCase().includes(needle));
  const days = Array.from(new Set(shownReceived.map(batch => batch.day)));
  const selectedWork = dialog?.kind === 'work' ? workRows.find(row => row.key === dialog.key) : undefined;
  const selectedReceived = dialog?.kind === 'received' ? received.find(group => group.key === dialog.key) : undefined;
  const selectedHistory = dialog?.kind === 'return' ? history.find(row => row.id === dialog.key) : undefined;
  const editable = canEdit && !loading && !error;
  const arrived = async (results: CreateArrivalResult[]) => {
    const conflicts = results.flatMap(result => result.matches).filter(match => match.status === 'CONFLICT');
    setNotice(conflicts.length ? '實際到貨已保存；部分待收對應尚未完成。' : '實際到貨已保存。');
    setQuery(''); setTab('received'); setDialog(null);
    await load();
  };
  const posted = async (groupKey: string, closeWhenEmpty: boolean) => {
    const next = await load();
    if (closeWhenEmpty && next && !receivingBatchViews(next, receivingHistory(next))
      .flatMap(batch => batch.groups).some(group => group.key === groupKey)) setDialog(null);
    return Boolean(next);
  };
  const reversed = async () => {
    const next = await load();
    if (next) { setDialog(null); setNotice('已退回到已收到。'); }
    return Boolean(next);
  };
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'pending', label: '待收貨', count: pending.length },
    { key: 'received', label: '已收到', count: recentBatches.length },
    { key: 'history', label: '收貨紀錄', count: batches.length + standaloneHistory.length },
  ];
  const createButtons = <><button type="button" className={v5Button} disabled={!editable || !data} onClick={() => setDialog({ kind: 'pending' })}>＋預計收貨</button><button type="button" className={v5Primary} disabled={!editable || !data} onClick={() => setDialog({ kind: 'actual' })}>＋實際到貨</button></>;

  return <section aria-label="物料收貨" className="min-w-0 rounded-xl border border-theme-border bg-card/60">
    <header className="border-b border-theme-border px-3 pt-3 sm:px-4">
      <div className="flex items-center justify-between gap-3"><h1 className="text-lg font-bold">物料收貨</h1><div className="hidden gap-2 sm:flex">{createButtons}</div><details className="relative sm:hidden"><summary className="cursor-pointer rounded-md px-2 py-1 text-sm text-accent">新增</summary><div className="absolute right-0 z-10 flex w-36 flex-col gap-2 rounded-lg border border-theme-border bg-card p-2 shadow-lg">{createButtons}</div></details></div>
      <div className="mt-3 flex min-w-0 items-center gap-2"><label className="relative min-w-0 flex-1"><span className="sr-only">搜尋品項、案件或序號</span><Search size={16} className="pointer-events-none absolute left-3 top-3 text-secondary" /><input type="search" className="h-10 w-full min-w-0 rounded-lg border border-theme-border bg-page pl-9 pr-3 text-sm" placeholder="搜尋品項 / 案件 / 序號" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" title="重新整理" aria-label="重新整理" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-theme-border" disabled={loading} onClick={() => void load()}><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button></div>
      <div role="tablist" aria-label="收貨分類" className="mt-3 flex gap-4 overflow-x-auto">{tabs.map(value => <button type="button" role="tab" key={value.key} aria-selected={tab === value.key} className={'shrink-0 border-b-2 pb-2 text-sm font-semibold ' + (tab === value.key ? 'border-accent text-accent' : 'border-transparent text-secondary hover:text-primary')} onClick={() => setTab(value.key)}>{value.label}<span className="ml-1.5 tabular-nums font-normal">{value.count}</span></button>)}</div>
    </header>
    <div className="min-w-0 px-3 sm:px-4"><ActionError message={error} />{notice && <p role="status" className="py-2 text-sm text-accent">{notice}</p>}{loading && !data && <p role="status" className="py-8 text-sm text-secondary">載入物料收貨…</p>}
      {tab === 'pending' && <div role="tabpanel" aria-label="待收貨" className="divide-y divide-theme-border">{shownPending.map(row => {
        const target = pendingMenuTarget(row, editable);
        return <div key={row.key} className="flex min-w-0 items-center gap-1">
          <button type="button" {...actionMenu.bind(target)} data-pending-row={row.key} className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left hover:bg-accent/5" onClick={() => setDialog({ kind: 'work', key: row.key })}><span className="min-w-0 flex-1"><span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><strong className="min-w-0 break-words text-sm">{row.label}</strong>{row.fulfilment.fulfilled > 0 && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">部分到貨</span>}</span><span className="mt-1 block text-xs text-secondary sm:text-sm">待收 <b className="tabular-nums text-primary">{formatReceivingQuantity(Number(row.fulfilment.remaining))}</b> {row.unit}<span className="hidden sm:inline">｜預計 {formatReceivingQuantity(Number(row.fulfilment.expected))}｜已到 {formatReceivingQuantity(Number(row.fulfilment.fulfilled))}</span>｜{row.expectedAt ? shortTime(row.expectedAt) : '時間未定'}{row.projectLabel !== '未指定案件' && `｜${row.projectLabel}`}</span></span><ChevronRight size={16} className="shrink-0 text-secondary" /></button>
          <button type="button" aria-label={`更多操作：${row.label}`} aria-haspopup="menu" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-page" onClick={event => actionMenu.openFromButton(target, event.currentTarget)}><MoreHorizontal size={18} /></button>
        </div>;
      })}</div>}
      {tab === 'received' && <div role="tabpanel" aria-label="已收到" className="space-y-1">{days.map(day => {
        const dayBatches = shownReceived.filter(batch => batch.day === day);
        return <details key={day} open={expandedDays[day] ?? (day === today || dayBatches.some(batch => batch.workCount > 0))}
          onToggle={event => { const open = event.currentTarget.open; setExpandedDays(current => current[day] === open ? current : { ...current, [day]: open }); }}
          className="border-b border-theme-border py-2">
          <summary className="cursor-pointer text-sm font-semibold">{day === today ? '今天 ' : ''}{day.slice(5).replace('-', '/')} · {dayBatches.length} 批{dayBatches.some(batch => batch.workCount > 0) ? ' · 待處理' : ''}</summary>
          <div className="space-y-2 pt-2">{dayBatches.map(batch => <details key={batch.id} data-received-batch={batch.id} className="rounded-lg border border-theme-border bg-page/40 px-3 py-2">
            <summary className="cursor-pointer text-sm"><strong>{batch.label}</strong><span className="ml-2 text-xs text-secondary">{shortTime(batch.at)} · {formatReceivingQuantity(batch.total)} 件 · {batch.itemCount} 種品項 · {batch.workCount ? `待處理 ${formatReceivingQuantity(batch.workCount)}` : '已完成'}</span></summary>
            <div className="divide-y divide-theme-border pt-1">{batch.groups.map(group => {
              const target = receivedMenuTarget(group, editable);
              const serials = group.rows.flatMap(row => row.observations.map(entry => entry.normalized_serial));
              return <div key={group.key} className="py-1"><div className="flex min-w-0 items-center gap-1">
                <button type="button" {...actionMenu.bind(target)} data-received-group={group.key} className="min-w-0 flex-1 py-2 text-left" onClick={() => setDialog({ kind: 'received', key: group.key, mode: group.states.includes('UNRESOLVED') ? 'resolve' : 'inventory' })}>
                  <strong className="text-sm">{group.states.includes('UNRESOLVED') ? '待補資料' : group.pn}</strong><span className="ml-2 text-xs text-secondary">{formatReceivingQuantity(group.quantity)} {group.unit || '台'} · {group.states.map(stateLabel).join('、')}</span>
                </button>{editable && <button type="button" className="min-h-9 shrink-0 px-2 text-xs text-accent" onClick={() => setDialog({ kind: 'received', key: group.key, mode: group.states.includes('UNRESOLVED') ? 'resolve' : 'inventory' })}>{group.states.includes('UNRESOLVED') ? '補資料' : '分類'}</button>}
                <button type="button" aria-label={`更多操作：${group.pn}`} className="min-h-9 shrink-0 px-2" onClick={event => actionMenu.openFromButton(target, event.currentTarget)}><MoreHorizontal size={17} /></button>
              </div>{serials.length > 0 && <details className="text-xs text-secondary"><summary className="cursor-pointer py-1">查看序號 · {serials.length}</summary><ul className="max-h-36 overflow-y-auto">{serials.map(serial => <li key={serial} className="break-all py-0.5">{serial}</li>)}</ul></details>}</div>;
            })}{batch.lines.filter(line => !batch.groups.some(group => group.rows.some(row => row.line?.id === line.id))).map(line => {
              const item = data?.items.find(value => value.id === line.inventory_item_id);
              return <div key={line.id} className="py-2 text-xs text-secondary">{item?.code || '待補資料'} · {formatReceivingQuantity(Number(line.quantity))} {line.unit || '台'} · 已完成</div>;
            })}</div>
          </details>)}</div>
        </details>;
      })}</div>}
      {tab === 'history' && <div role="tabpanel" aria-label="收貨紀錄" className="divide-y divide-theme-border">{shownHistory.map(batch => <details key={batch.id} data-history-batch={batch.id} className="py-2">
        <summary className="cursor-pointer text-sm"><strong>{batch.label}</strong><span className="ml-2 text-xs text-secondary">{formatTaipeiReceivingTime(batch.at)} · {formatReceivingQuantity(batch.total)} 件 · {batch.itemCount} 種品項 · {batch.workCount ? '待處理' : '已完成'}</span></summary>
        <div className="space-y-2 pl-3 pt-2">{batch.lineGroups.map(group => {
          return <div key={group.key} className="border-l-2 border-theme-border pl-2 text-xs"><p>{group.label} × {formatReceivingQuantity(group.quantity)} {group.unit}</p>{group.serials.length > 0 && <details><summary className="cursor-pointer text-secondary">查看序號 · {group.serials.length}</summary><ul>{group.serials.map(serial => <li key={serial} className="break-all">{serial}</li>)}</ul></details>}</div>;
        })}{batch.history.filter(row => row.type !== '實際到貨').map(row => {
          const target = historyMenuTarget(row, editable);
          return <article key={row.id} data-history-row={row.id} {...actionMenu.bind(target)} className="flex min-w-0 items-center gap-2 text-xs"><span className="min-w-0 flex-1 break-words">{row.type} · {row.item} · {formatReceivingQuantity(row.quantity)} {row.unit} · {row.state}</span>{target.actions.length > 0 && <button type="button" className="min-h-9 px-2" onClick={event => actionMenu.openFromButton(target, event.currentTarget)}><MoreHorizontal size={17} /></button>}</article>;
        })}</div>
      </details>)}{standaloneHistory.map(row => <article key={row.id} className="py-2 text-sm">{formatTaipeiReceivingTime(row.at)} · {row.type} · {row.item}</article>)}</div>}
      {!loading && !(tab === 'pending' ? shownPending.length : tab === 'received' ? shownReceived.length : shownHistory.length + standaloneHistory.length) && <p className="py-10 text-center text-sm text-secondary">{query ? '沒有符合的資料' : tab === 'pending' ? '目前沒有待收貨' : tab === 'received' ? '目前沒有已收到的貨品' : '目前沒有收貨紀錄'}</p>}
    </div>
    {actionMenu.popup}
    {deleteTarget && <ReceivingPendingDeleteConfirm key={deleteTarget.key + ':' + deleteTarget.source.updatedAt}
      target={deleteTarget} api={api} onClose={() => setDeleteTarget(null)} onDeleted={async () => {
        if (!await load()) throw new Error('PENDING_DELETE_REFRESH_FAILED');
        setDeleteTarget(null); setNotice('待收貨已刪除。');
      }} />}
    {dialog && data && <ReceivingWorkModal title={dialog.kind === 'pending' ? '預計收貨' : dialog.kind === 'actual' ? '實際到貨' : dialog.kind === 'received' ? '已收到明細' : dialog.kind === 'return' ? '退回到已收到' : '收貨工作'} onClose={() => setDialog(null)}>
      {dialog.kind === 'pending' ? <ReceivingPendingBatchForm data={data} api={api} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); setNotice('預計收貨已建立。'); setQuery(''); setTab('pending'); await load(); }} />
        : dialog.kind === 'actual' ? <ReceivingV6Composer data={data} api={api} onClose={() => setDialog(null)} onSaved={arrived} />
          : dialog.kind === 'received' ? selectedReceived ? <ReceivingThreeWayDetail key={selectedReceived.key + ':' + dialog.mode} group={selectedReceived} data={data} api={api} canEdit={editable} initialMode={dialog.mode} onChanged={async () => posted(selectedReceived.key, true)} /> : <p className="text-sm">此筆已更新，請重新整理。</p>
            : dialog.kind === 'return' ? selectedHistory?.returnToReceived ? <ReceivingReturnDetail key={selectedHistory.id} row={selectedHistory} api={api} canReverse={editable} onReversed={reversed} /> : <p className="text-sm">此筆已更新，請重新整理。</p>
            : selectedWork ? <ReceivingWorkBody key={selectedWork.key} row={selectedWork} data={data} api={api} canEdit={editable} onChanged={async () => { await load(); }} onCreated={arrived} /> : <p className="text-sm">此筆已更新，請重新整理。</p>}
      {error && <ActionError message={error} />}
    </ReceivingWorkModal>}
  </section>;
}
