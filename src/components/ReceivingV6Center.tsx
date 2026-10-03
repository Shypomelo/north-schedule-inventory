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
import { formatReceivingQuantity, formatTaipeiReceivingTime } from '@/lib/material-receiving';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import { ReceivingWorkBody, ReceivingWorkModal } from './ReceivingWorkModal';
import { ReceivingV6Composer } from './ReceivingV6Composer';
import { ReceivingThreeWayDetail } from './ReceivingThreeWayDetail';
import { ReceivingReturnDetail } from './ReceivingReturnDetail';
import { ReceivingPendingDeleteConfirm } from './ReceivingPendingDeleteConfirm';
import { useReceivingActionMenu, type ReceivingActionTarget } from './ReceivingActionMenu';
import { ActionError, PendingForm, v5Button, v5Primary } from './ReceivingV5Forms';

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
  const received = useMemo(() => data ? receivedItemGroups(data) : [], [data]);
  const history = useMemo(() => data ? receivingHistory(data) : [], [data]);
  const workRows = useMemo(() => data ? receivingWorkItems(data) : [], [data]);
  const needle = query.trim().toLocaleLowerCase();
  const shownPending = pending.filter(row => searchPending(row, needle));
  const shownReceived = received.filter(group => [group.pn, group.name, ...group.projectLabels,
    ...group.rows.flatMap(row => row.observations.map(entry => entry.normalized_serial))].join(' ').toLocaleLowerCase().includes(needle));
  const shownHistory = history.filter(row => [row.item, row.actor, row.type, row.state, row.projectLabel].join(' ').toLocaleLowerCase().includes(needle));
  const selectedWork = dialog?.kind === 'work' ? workRows.find(row => row.key === dialog.key) : undefined;
  const selectedReceived = dialog?.kind === 'received' ? received.find(group => group.key === dialog.key) : undefined;
  const selectedHistory = dialog?.kind === 'return' ? history.find(row => row.id === dialog.key) : undefined;
  const editable = canEdit && !loading && !error;
  const arrived = async (result: CreateArrivalResult) => {
    const conflicts = result.matches.filter(match => match.status === 'CONFLICT');
    setNotice(conflicts.length ? '實際到貨已保存；部分待收對應尚未完成。' : '實際到貨已保存。');
    setQuery(''); setTab('received'); setDialog(null);
    await load();
  };
  const posted = async (groupKey: string, closeWhenEmpty: boolean) => {
    const next = await load();
    if (closeWhenEmpty && next && !receivedItemGroups(next).some(group => group.key === groupKey)) setDialog(null);
    return Boolean(next);
  };
  const reversed = async () => {
    const next = await load();
    if (next) { setDialog(null); setNotice('已退回到已收到。'); }
    return Boolean(next);
  };
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'pending', label: '待收貨', count: pending.length },
    { key: 'received', label: '已收到', count: received.length },
    { key: 'history', label: '收貨紀錄', count: history.length },
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
      {tab === 'received' && <div role="tabpanel" aria-label="已收到" className="divide-y divide-theme-border">{shownReceived.map(group => {
        const target = receivedMenuTarget(group, editable);
        return <div key={group.key} className="flex min-w-0 items-center gap-1">
          <button type="button" {...actionMenu.bind(target)} data-received-group={group.key} className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left hover:bg-accent/5" onClick={() => setDialog({ kind: 'received', key: group.key, mode: group.states.includes('UNRESOLVED') ? 'resolve' : 'inventory' })}><span className="min-w-0 flex-1"><span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><strong className="break-all text-sm">{group.pn}</strong><span className="truncate text-xs text-secondary">{group.name}</span>{group.states.map(state => <span key={state} className={'rounded px-1.5 py-0.5 text-xs ' + (state === 'UNRESOLVED' ? 'bg-warning/10 text-warning' : 'bg-page text-secondary')}>{stateLabel(state)}</span>)}{group.temporary && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">臨時到貨</span>}</span><span className="mt-1 block text-xs text-secondary sm:text-sm"><b className="tabular-nums text-primary">{formatReceivingQuantity(group.quantity)} {group.unit}</b>｜{shortTime(group.at)}{group.projectLabels.length > 0 && `｜${group.projectLabels.join('、')}`}</span></span><ChevronRight size={16} className="shrink-0 text-secondary" /></button>
          {editable && <button type="button" className={v5Button + ' shrink-0'} onClick={() => setDialog({ kind: 'received', key: group.key, mode: group.states.includes('UNRESOLVED') ? 'resolve' : 'inventory' })}>{group.states.includes('UNRESOLVED') ? '補資料' : group.stages.length ? '後續處理' : '查看明細'}</button>}
          <button type="button" aria-label={`更多操作：${group.pn}`} aria-haspopup="menu" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-page" onClick={event => actionMenu.openFromButton(target, event.currentTarget)}><MoreHorizontal size={18} /></button>
        </div>;
      })}</div>}
      {tab === 'history' && <div role="tabpanel" aria-label="收貨紀錄" className="divide-y divide-theme-border">{shownHistory.map(row => {
        const target = historyMenuTarget(row, editable);
        return <article key={row.id} {...actionMenu.bind(target)} data-history-row={row.id} className="min-w-0 py-3 text-sm"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><time className="shrink-0 tabular-nums text-secondary">{formatTaipeiReceivingTime(row.at)}</time><strong>{row.type}</strong><span className="min-w-0 break-words">{row.item}</span><span className="ml-auto shrink-0 tabular-nums font-semibold">{row.quantity > 0 ? '+' : ''}{formatReceivingQuantity(row.quantity)} {row.unit}</span></div><div className="mt-1 flex flex-wrap items-center justify-between gap-1"><p className="break-words text-xs text-secondary">{row.actor}｜{row.state}{row.projectLabel !== '未指定案件' && `｜${row.projectLabel}`}</p>{target.actions.length > 0 && <button type="button" aria-label={`更多操作：${row.item}`} aria-haspopup="menu" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-page" onClick={event => actionMenu.openFromButton(target, event.currentTarget)}><MoreHorizontal size={18} /></button>}</div></article>;
      })}</div>}
      {!loading && !(tab === 'pending' ? shownPending.length : tab === 'received' ? shownReceived.length : shownHistory.length) && <p className="py-10 text-center text-sm text-secondary">{query ? '沒有符合的資料' : tab === 'pending' ? '目前沒有待收貨' : tab === 'received' ? '目前沒有已收到的貨品' : '目前沒有收貨紀錄'}</p>}
    </div>
    {actionMenu.popup}
    {deleteTarget && <ReceivingPendingDeleteConfirm key={deleteTarget.key + ':' + deleteTarget.source.updatedAt}
      target={deleteTarget} api={api} onClose={() => setDeleteTarget(null)} onDeleted={async () => {
        if (!await load()) throw new Error('PENDING_DELETE_REFRESH_FAILED');
        setDeleteTarget(null); setNotice('待收貨已刪除。');
      }} />}
    {dialog && data && <ReceivingWorkModal title={dialog.kind === 'pending' ? '預計收貨' : dialog.kind === 'actual' ? '實際到貨' : dialog.kind === 'received' ? '已收到明細' : dialog.kind === 'return' ? '退回到已收到' : '收貨工作'} onClose={() => setDialog(null)}>
      {dialog.kind === 'pending' ? <PendingForm embedded compact data={data} api={api} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); setNotice('預計收貨已建立。'); setQuery(''); setTab('pending'); await load(); }} />
        : dialog.kind === 'actual' ? <ReceivingV6Composer data={data} api={api} onClose={() => setDialog(null)} onSaved={arrived} />
          : dialog.kind === 'received' ? selectedReceived ? <ReceivingThreeWayDetail key={selectedReceived.key + ':' + dialog.mode} group={selectedReceived} data={data} api={api} canEdit={editable} initialMode={dialog.mode} onChanged={async () => posted(selectedReceived.key, true)} /> : <p className="text-sm">此筆已更新，請重新整理。</p>
            : dialog.kind === 'return' ? selectedHistory?.returnToReceived ? <ReceivingReturnDetail key={selectedHistory.id} row={selectedHistory} api={api} canReverse={editable} onReversed={reversed} /> : <p className="text-sm">此筆已更新，請重新整理。</p>
            : selectedWork ? <ReceivingWorkBody key={selectedWork.key} row={selectedWork} data={data} api={api} canEdit={editable} onChanged={async () => { await load(); }} onCreated={arrived} /> : <p className="text-sm">此筆已更新，請重新整理。</p>}
      {error && <ActionError message={error} />}
    </ReceivingWorkModal>}
  </section>;
}
