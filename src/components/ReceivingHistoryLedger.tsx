'use client';

import { formatTaipeiReceivingTime, formatReceivingQuantity } from '@/lib/material-receiving';
import type { ReceivingLedgerRow } from '@/lib/receiving-history-ledger';

const number = (value: number | null) => value === null ? '無法確認' : formatReceivingQuantity(value);

export function ReceivingHistoryLedger({ rows, query, canEdit, onReturn }: {
  rows: ReceivingLedgerRow[]; query: string; canEdit: boolean; onReturn: (id: string) => void;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = rows.filter(row => [row.event.at, row.event.projectLabel, row.event.item, row.event.type, row.source, row.state,
    ...row.serials, ...row.destinations.map(value => value.label)].join(' ').toLocaleLowerCase().includes(needle));
  return <div role="tabpanel" aria-label="收貨紀錄" className="divide-y divide-theme-border">
    {visible.map(row => <details key={row.event.id} data-history-row={row.event.id} className="py-3">
      <summary className="cursor-pointer"><div className="grid min-w-0 gap-1 text-sm sm:grid-cols-[9rem_minmax(7rem,1fr)_minmax(10rem,1.4fr)_6rem_6rem_6rem] sm:items-center sm:gap-3">
        <time className="text-xs text-secondary" dateTime={row.event.at}>{formatTaipeiReceivingTime(row.event.at)}</time>
        <span className="break-words">{row.event.projectLabel}</span><strong className="break-words">{row.event.item}</strong>
        <span className="tabular-nums">{formatReceivingQuantity(row.event.quantity)} {row.event.unit}</span>
        <span className="text-xs text-secondary">{row.source}</span><span className="text-xs font-semibold">{row.state}</span>
      </div></summary>
      <div className="mt-3 space-y-3 rounded-lg bg-page/50 p-3 text-xs sm:text-sm">
        <p>事件：{row.event.type} · {row.event.state} · 經手：{row.event.actor}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><p>原始收貨量<br /><b>{number(row.original)}</b></p><p>有效收貨量<br /><b>{number(row.effective)}</b></p><p>已分配量<br /><b>{number(row.allocated)}</b></p><p>未分配量<br /><b>{number(row.unallocated)}</b></p></div>
        <p>分配目的地：{row.destinations.length ? row.destinations.map(value => `${value.label} ${formatReceivingQuantity(value.quantity)}`).join('、') : row.state === '待分配' ? '尚未分配' : '無法確認'}</p>
        <p className="break-all">SN：{row.serials.length ? row.serials.join('、') : '未提供或非序號物料'}</p>
        <div><strong>原始收貨及退回、更正、取消歷程</strong><ul className="mt-1 space-y-1">{row.history.map(event => <li key={event.id}>{formatTaipeiReceivingTime(event.at)} · {event.label} · {formatReceivingQuantity(event.quantity)} {row.event.unit}{event.reason ? ` · ${event.reason}` : ''}</li>)}</ul></div>
        {canEdit && row.event.returnToReceived && <button type="button" className="min-h-10 rounded-md border border-theme-border px-3 text-sm text-accent" onClick={() => onReturn(row.event.id)}>退回到已收到</button>}
      </div>
    </details>)}
    {!visible.length && <p className="py-10 text-center text-sm text-secondary">{needle ? '沒有符合的收貨紀錄' : '目前沒有收貨紀錄'}</p>}
  </div>;
}
