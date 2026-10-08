'use client';

import { useState } from 'react';
import type { Project } from '@/lib/db/types';
import type { PendingRow } from '@/lib/receiving-v5';
import { matchSEOrderPending, matchSEOrderProject, seOrderStatus, type SEOrderView } from '@/lib/se-order-mock';

export function ReceivingSEOrders({ orders, projects, pending, query, focusOrderNo }: {
  orders: SEOrderView[]; projects: Project[]; pending: PendingRow[]; query: string; focusOrderNo: string | null;
}) {
  const [status, setStatus] = useState('全部');
  const needle = query.trim().toLocaleLowerCase();
  const visible = orders.filter(view => (status === '全部' || seOrderStatus(view).filter === status)
    && [view.orderNo, view.order?.siteName, ...(view.order?.caseNumbers || []), view.order?.status, view.order?.statusLabel,
      view.order?.carrier, ...(view.order?.trackingNos || []), ...(view.order?.items.map(item => item.name) || []),
      view.removal?.reason].join(' ').toLocaleLowerCase().includes(needle));
  const statuses = ['全部', ...Array.from(new Set(orders.map(view => seOrderStatus(view).filter)))];
  return <div role="tabpanel" aria-label="SE 供貨" className="space-y-3 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-secondary">SolarEdge Partner API v1.0 Mock · 只供畫面與掃碼定位，不會建立收貨或庫存</p>
      <label className="text-xs text-secondary">狀態 <select aria-label="SE 訂單狀態" className="ml-1 rounded-md border border-theme-border bg-page px-2 py-1.5 text-sm text-primary" value={status} onChange={event => setStatus(event.target.value)}>{statuses.map(value => <option key={value} value={value}>{value === 'removed' ? '已失效' : value === '全部' ? value : seOrderStatus(orders.find(view => seOrderStatus(view).filter === value)!).label}</option>)}</select></label></div>
    {visible.map(view => {
      const order = view.order;
      const match = matchSEOrderProject(view, projects);
      const pendingState = matchSEOrderPending(view, pending, match.project);
      return <details key={view.orderNo} open={focusOrderNo === view.orderNo ? true : undefined} className="rounded-lg border border-theme-border bg-page/40 p-3" data-se-order={view.orderNo}>
        <summary className="cursor-pointer"><div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><strong className="block break-words text-sm">{order?.siteName || '已移除訂單（無案場資料）'}</strong><span className="text-xs text-secondary">訂單 {view.orderNo} · 案號 {order?.caseNumbers.length ? order.caseNumbers.join('、') : '未提供'}</span></div><span className="rounded bg-accent/10 px-2 py-1 text-xs text-accent">{seOrderStatus(view).label}</span></div>
          <p className="mt-2 text-xs text-secondary">{order?.items.map(item => `${item.name} × ${item.qty}`).join('、') || 'removed 通知未提供品項'} · {order?.carrier || '物流未提供'} · {order?.trackingNos.length ? order.trackingNos.join('、') : '無託運單號'}</p></summary>
        <div className="mt-3 grid gap-3 border-t border-theme-border pt-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <p><span className="text-secondary">北部案場對應</span><br />{match.state === 'INVALID' ? '已失效' : match.project ? `${match.project.name} · Mock 同名候選，待權威確認` : '待確認訂單 · 未找到唯一同名案場'}</p>
          <p><span className="text-secondary">待收貨關聯</span><br />{pendingState === 'CANDIDATE' ? '找到候選，須人工確認' : pendingState === 'NONE' ? '已失效，不關聯' : '未確認，不納入待收貨'}</p>
          <p><span className="text-secondary">物流／託運單號</span><br />{order?.carrier || '未提供'} · {order?.trackingNos.length ? order.trackingNos.join('、') : '未提供'}</p>
          {order && <p><span className="text-secondary">開單日期／最後異動</span><br />{order.createdAt} · {order.updatedAt || '未提供'}</p>}
          {view.removal && <p><span className="text-secondary">移除通知</span><br />{view.removal.reason} · {view.removal.removedAt}</p>}
          {order?.items.map((item, index) => <div key={index} className="rounded-md border border-theme-border p-2 sm:col-span-2 lg:col-span-3"><strong>{item.name}</strong> · {item.qty} 件
            <p className="mt-1 break-all text-xs text-secondary">SN 預留（UI 衍生欄位；API 不提供 SN）</p></div>)}
        </div>
      </details>;
    })}
    {!visible.length && <p className="py-10 text-center text-sm text-secondary">沒有符合條件的 SE 訂單</p>}
  </div>;
}
