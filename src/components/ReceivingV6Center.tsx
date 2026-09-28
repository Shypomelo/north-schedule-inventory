'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useUser } from './UserContext';
import { supabase } from '@/lib/db/supabaseClient';
import { createReceivingV6Api } from '@/lib/db/receiving-v6';
import { receivingWorkItems, workItemSearch, workItemStock, type ReceivingV6Snapshot } from '@/lib/receiving-v6';
import { receivingError, type PendingRow } from '@/lib/receiving-v5';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import { ReceivingWorkBody, ReceivingWorkModal } from './ReceivingWorkModal';
import { ReceivingV6Composer } from './ReceivingV6Composer';
import { ActionError, PendingForm, v5Button, v5Primary } from './ReceivingV5Forms';

const api = createReceivingV6Api(supabase);
const filters = ['全部', '待收', '部分到貨', '已收到', '待補資料'] as const;
type Dialog = { kind: 'work'; key: string; lineId?: string } | { kind: 'pending' } | { kind: 'actual'; preferred?: PendingRow };
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '日期未定';
export function ReceivingV6Center() {
  const { currentUser } = useUser();
  const canEdit = Boolean(currentUser && currentUser.role !== 'VIEWER');
  const [data, setData] = useState<ReceivingV6Snapshot | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<string>('全部');
  const [dialog, setDialog] = useState<Dialog | null>(null);
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
  const rows = useMemo(() => data ? receivingWorkItems(data) : [], [data]);
  const visible = rows.filter(r => workItemSearch(r, query) && (filter === '全部' || r.status === filter));
  const selected = dialog?.kind === 'work' ? rows.find(r => r.key === dialog.key) || rows.find(r => r.slices.some(s => s.actual.line?.id === dialog.lineId)) : undefined;
  const editable = canEdit && !loading && !error;
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
      <div role="group" aria-label="收貨篩選" className="flex gap-1.5 overflow-x-auto pb-1">{filters.map(value => <button type="button" key={value} aria-pressed={value === filter} className={'shrink-0 rounded-full px-3 py-2 text-sm font-medium ' + (value === filter ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-page')} onClick={() => setFilter(value)}>{value}<span className="ml-1 tabular-nums">{rows.filter(r => value === '全部' || r.status === value).length}</span></button>)}</div>
    </header>
    <div className="space-y-2 p-2 sm:p-3"><ActionError message={error} />{notice && <p role="status" className="px-2 py-1 text-sm text-accent">{notice}</p>}{loading && !data && <p role="status" className="p-4 text-sm text-secondary">載入物料收貨…</p>}
      <div aria-label="物料收貨清單" className="space-y-2">{visible.map(row => { const p = row.pending, stock = workItemStock(row, data!); return <button type="button" data-work-item={row.key} key={row.key} onClick={() => { setNotice(''); setDialog({ kind: 'work', key: row.key, lineId: row.slices[0]?.actual.line?.id }); }} className="group flex w-full min-w-0 items-center gap-2 rounded-lg border border-theme-border bg-card px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent/5 focus-visible:outline-accent">
        <span className="min-w-0 flex-1 space-y-0.5"><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-semibold">{row.label}</span><span className="hidden max-w-[25%] truncate text-sm text-secondary sm:block">{row.projectLabel === '未指定案件' ? '' : row.projectLabel}</span><span className={'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ' + (row.status === '待補資料' ? 'bg-warning/10 text-warning' : row.status === '部分到貨' ? 'bg-accent/10 text-accent' : 'bg-page text-secondary')}>{row.status}</span></span>
          <span className="block text-sm tabular-nums text-secondary">{p ? `預計 ${p.fulfilment.expected}｜已到 ${p.fulfilment.fulfilled}｜剩 ${p.fulfilment.remaining}｜${shortDate(p.expectedAt)}` : row.status === '待補資料' ? `${shortDate(row.at)} 掃碼收到｜尚未確認品項` : `${shortDate(row.at)} 到貨 ${row.received} ${row.unit}｜未對應預計收貨`}</span>
          {stock.known && <span className="block text-sm tabular-nums text-secondary">{stock.shared ? '本批共用庫存・查看後續處理' : `庫存 ${stock.available}｜SE ${stock.se}｜案場 ${stock.site}`}</span>}
        </span><ChevronRight size={17} className="shrink-0 text-secondary group-hover:text-accent" />
      </button>; })}</div>
      {!loading && !visible.length && <p className="py-10 text-center text-sm text-secondary">沒有符合的收貨紀錄</p>}
    </div>
    {dialog && data && <ReceivingWorkModal title={dialog.kind === 'pending' ? '預計收貨' : dialog.kind === 'actual' ? '實際到貨' : '收貨工作'} onClose={() => setDialog(null)}>
      {dialog.kind === 'pending' ? <PendingForm embedded compact data={data} api={api} onClose={() => setDialog(null)} onSaved={async id => { setDialog(null); setNotice('預計收貨已建立。'); setQuery(''); setFilter('全部'); await load(); }} />
        : dialog.kind === 'actual' ? <ReceivingV6Composer data={data} api={api} preferred={dialog.preferred} onClose={() => setDialog(null)} onSaved={arrived} />
          : selected ? <ReceivingWorkBody key={selected.key} row={selected} data={data} api={api} canEdit={Boolean(editable)} onChanged={load} onCreated={arrived} /> : <p className="text-sm">此筆已更新，請關閉後重新整理清單。</p>}
      {error && <ActionError message={error} />}
    </ReceivingWorkModal>}
  </section>;
}
