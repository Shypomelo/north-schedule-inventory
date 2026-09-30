'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useUser } from './UserContext';
import { supabase } from '@/lib/db/supabaseClient';
import { createReceivingV6Api } from '@/lib/db/receiving-v6';
import { matchesReceivingFilter, receivingWorkItems, workItemSearch, workItemStock, type ReceivingV6Snapshot } from '@/lib/receiving-v6';
import { receivingError, type PendingRow } from '@/lib/receiving-v5';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import { ReceivingWorkBody, ReceivingWorkModal } from './ReceivingWorkModal';
import { ReceivingV6Composer } from './ReceivingV6Composer';
import { ActionError, PendingForm, v5Button, v5Primary } from './ReceivingV5Forms';

const api = createReceivingV6Api(supabase);
const filters = ['待處理', '已收到', '全部'] as const;
type Dialog = { kind: 'work'; key: string; lineId?: string } | { kind: 'pending' } | { kind: 'actual'; preferred?: PendingRow };
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '日期未定';
export function ReceivingV6Center() {
  const { currentUser } = useUser();
  const canEdit = Boolean(currentUser && currentUser.role !== 'VIEWER');
  const [data, setData] = useState<ReceivingV6Snapshot | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<string>('待處理');
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ row: PendingRow; requestId: string } | null>(null);
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++generation.current; setLoading(true); setError('');
    try {
      const next = await api.load(); receivingWorkItems(next); // Fail closed on inconsistent quantity/identity projection.
      if (ticket === generation.current) setData(next);
    } catch (e) { if (ticket === generation.current) setError(receivingError(e)); }
    finally { if (ticket === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { const requestGeneration = generation; void load(); return () => { requestGeneration.current++; }; }, [load]);
  const rows = useMemo(() => data ? receivingWorkItems(data).filter(row => {
    if (deletedKeys.has(row.key)) return false;
    const p = row.pending;
    if (!p) return true;
    const source = p.kind === 'PROJECT_MATERIAL' ? data.materials.find(m => m.id === p.id) : data.supplies.find(s => s.id === p.id);
    return !source?.receiving_deleted_at;
  }) : [], [data, deletedKeys]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close); window.addEventListener('keydown', close); window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  const visible = rows.filter(r => workItemSearch(r, query) && matchesReceivingFilter(r.status, filter));
  const selected = dialog?.kind === 'work' ? rows.find(r => r.key === dialog.key) || rows.find(r => r.slices.some(s => s.actual.line?.id === dialog.lineId)) : undefined;
  const editable = canEdit && !loading && !error;
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError('');
    try {
      await api.deletePending({ p_request_id: deleteTarget.requestId, p_source_type: deleteTarget.row.kind,
        p_source_id: deleteTarget.row.id, p_expected_updated_at: deleteTarget.row.updatedAt });
      setDeletedKeys(previous => new Set(previous).add(deleteTarget.row.key));
      setDeleteTarget(null); setNotice('待收已從工作清單移除，預登序號已安全退役。');
      await load();
    } catch (e) {
      setDeleteError(receivingError(e));
    } finally { setDeleting(false); }
  };
  const arrived = async (result: CreateArrivalResult) => {
    const conflicts = result.matches.filter(m => m.status === 'CONFLICT');
    setNotice(conflicts.length ? '實際到貨已保存；部分預計收貨對應未完成，請開啟收貨紀錄調整。' : '實際到貨已保存。');
    setQuery(''); setFilter('全部');
    // Close the composer immediately after a successful command; a refresh failure never resubmits it.
    setDialog(previous => previous?.kind === 'work' ? previous : null);
    await load();
  };
  return <section aria-label="物料收貨" className="min-w-0 rounded-xl border border-theme-border bg-card/60">
    <header className="space-y-3 border-b border-theme-border p-3 sm:px-4">
      <h1 className="text-lg font-bold">物料收貨</h1>
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-0 sm:flex-1"><label className="relative min-w-0 flex-1"><span className="sr-only">搜尋品項、案件或序號</span><Search size={17} className="pointer-events-none absolute left-3 top-3.5 text-secondary" /><input type="search" className="h-11 w-full min-w-0 rounded-lg border border-theme-border bg-page pl-9 pr-3 text-sm" placeholder="搜尋品項 / 案件 / 序號" value={query} onChange={e => setQuery(e.target.value)} /></label><button type="button" title="重新整理" aria-label="重新整理" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-theme-border" disabled={loading} onClick={() => void load()}><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button></div>
        <div className="flex gap-2"><button className={v5Button} disabled={!editable || !data} onClick={() => setDialog({ kind: 'pending' })}>＋預計收貨</button><button className={v5Primary} disabled={!editable || !data} onClick={() => setDialog({ kind: 'actual' })}>＋實際到貨</button></div>
      </div>
      <div role="group" aria-label="收貨篩選" className="flex gap-1.5 overflow-x-auto pb-1">{filters.map(value => <button type="button" key={value} aria-pressed={value === filter} className={'shrink-0 rounded-full px-3 py-2 text-sm font-medium ' + (value === filter ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-page')} onClick={() => setFilter(value)}>{value}<span className="ml-1 tabular-nums">{rows.filter(r => matchesReceivingFilter(r.status, value)).length}</span></button>)}</div>
    </header>
    <div className="space-y-2 p-2 sm:p-3"><ActionError message={error} />{notice && <p role="status" className="px-2 py-1 text-sm text-accent">{notice}</p>}{loading && !data && <p role="status" className="p-4 text-sm text-secondary">載入物料收貨…</p>}
      <div aria-label="物料收貨清單" className="space-y-2">{visible.map(row => { const p = row.pending, stock = workItemStock(row, data!); return <button type="button" data-work-item={row.key} key={row.key} onClick={() => { setNotice(''); setDialog({ kind: 'work', key: row.key, lineId: row.slices[0]?.actual.line?.id }); }} onContextMenu={event => { if (!editable || row.status !== '待收' || !p) return; event.preventDefault(); setMenu({ key: row.key, x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 56) }); }} className="group flex w-full min-w-0 items-center gap-2 rounded-lg border border-theme-border bg-card px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent/5 focus-visible:outline-accent">
        <span className="min-w-0 flex-1 space-y-0.5"><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-semibold">{row.label}</span><span className="hidden max-w-[25%] truncate text-sm text-secondary sm:block">{row.projectLabel === '未指定案件' ? '' : row.projectLabel}</span><span className={'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ' + (row.status === '待補資料' ? 'bg-warning/10 text-warning' : row.status === '部分到貨' ? 'bg-accent/10 text-accent' : 'bg-page text-secondary')}>{row.status}</span></span>
          <span className="block text-sm tabular-nums text-secondary">{p ? `預計 ${p.fulfilment.expected}｜已到 ${p.fulfilment.fulfilled}｜剩 ${p.fulfilment.remaining}｜${shortDate(p.expectedAt)}` : row.status === '待補資料' ? `${shortDate(row.at)} 掃碼收到｜尚未確認品項` : `${shortDate(row.at)} 到貨 ${row.received} ${row.unit}｜未對應預計收貨`}</span>
          {stock.known && <span className="block text-sm tabular-nums text-secondary">{stock.shared ? '本批共用庫存・查看後續處理' : `庫存 ${stock.available}｜SE ${stock.se}｜案場 ${stock.site}`}</span>}
        </span><ChevronRight size={17} className="shrink-0 text-secondary group-hover:text-accent" />
      </button>; })}</div>
      {!loading && !visible.length && <p className="py-10 text-center text-sm text-secondary">沒有符合的收貨紀錄</p>}
    </div>
    {menu && <div role="menu" aria-label="待收操作" className="fixed z-50 min-w-36 rounded-lg border border-theme-border bg-card p-1 shadow-lg" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm text-danger hover:bg-page" onClick={() => { const p = rows.find(row => row.key === menu.key)?.pending; setMenu(null); if (p) { setDeleteError(''); setDeleteTarget({ row: p, requestId: crypto.randomUUID() }); } }}>刪除待收</button></div>}
    {deleteTarget && <ReceivingWorkModal title="刪除待收" onClose={() => { if (!deleting) setDeleteTarget(null); }}><div aria-busy={deleting} className="space-y-4"><p className="break-words text-sm font-semibold">{deleteTarget.row.label}｜{deleteTarget.row.projectLabel}</p><p className="text-sm">確定刪除這筆待收資料？</p>{deleteError && <ActionError message={deleteError} />}<div className="flex gap-2"><button type="button" className={v5Button} disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className={v5Primary} disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? '處理中…' : '刪除'}</button></div></div></ReceivingWorkModal>}
    {dialog && data && <ReceivingWorkModal title={dialog.kind === 'pending' ? '預計收貨' : dialog.kind === 'actual' ? '實際到貨' : '收貨工作'} onClose={() => setDialog(null)}>
      {dialog.kind === 'pending' ? <PendingForm embedded compact data={data} api={api} onClose={() => setDialog(null)} onSaved={async id => { setDialog(null); setNotice('預計收貨已建立。'); setQuery(''); setFilter('待處理'); await load(); }} />
        : dialog.kind === 'actual' ? <ReceivingV6Composer data={data} api={api} preferred={dialog.preferred} onClose={() => setDialog(null)} onSaved={arrived} />
          : selected ? <ReceivingWorkBody key={selected.key} row={selected} data={data} api={api} canEdit={Boolean(editable)} onChanged={load} onCreated={arrived} /> : <p className="text-sm">此筆已更新，請關閉後重新整理清單。</p>}
      {error && <ActionError message={error} />}
    </ReceivingWorkModal>}
  </section>;
}
