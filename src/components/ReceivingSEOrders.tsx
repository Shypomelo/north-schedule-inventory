'use client';

import { useState } from 'react';
import type { Project } from '@/lib/db/types';
import type { PendingRow } from '@/lib/receiving-v5';
import type { SECaseRule } from '@/lib/db/se-partner';
import { linkedPendingKeys, pendingCandidates, seOrderProject, seOrderStatus,
  type SEOrderView, type SEScopeState, type SEItemLink } from '@/lib/se-partner-view';

export function ReceivingSEOrders({ orders, projects, pending, query, focusOrderNo, canReview, rules,
  onConfirmScope, onSetCaseRule, onLink, onUnlink }: {
  orders: SEOrderView[]; projects: Project[]; pending: PendingRow[]; query: string; focusOrderNo: string | null;
  canReview: boolean; rules: SECaseRule[];
  onConfirmScope: (orderNo: string, scope: SEScopeState, projectId: string | null) => Promise<void>;
  onSetCaseRule: (caseNumber: string, scope: 'NORTH' | 'NOT_NORTH', projectId: string | null) => Promise<void>;
  onLink: (itemId: string, type: SEItemLink['sourceType'], sourceId: string, quantity: number) => Promise<void>;
  onUnlink: (linkId: string) => Promise<void>;
}) {
  const [status, setStatus] = useState('全部');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const setChoice = (key: string, value: string) => setChoices(current => ({ ...current, [key]: value }));
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); setMessage('已更新 SE 訂單快照。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失敗'); }
    finally { setBusy(false); }
  };
  const needle = query.trim().toLocaleLowerCase();
  const visible = orders.filter(view => (status === '全部' || seOrderStatus(view).filter === status)
    && [view.orderNo, view.order?.siteName, ...(view.order?.caseNumbers || []), view.order?.status,
      view.order?.statusLabel, view.order?.carrier, ...(view.order?.trackingNos || []),
      ...(view.order?.items.map(item => item.name) || []), view.removal?.reason]
      .join(' ').toLocaleLowerCase().includes(needle));
  const statuses = ['全部', ...Array.from(new Set(orders.map(view => seOrderStatus(view).filter)))];
  const activeProjects = projects.filter(project => !project.deleted_at);
  return <div role="tabpanel" aria-label="SE 供貨" className="space-y-3 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-secondary">SolarEdge 訂單快照 · 開啟頁面不會同步外部 API，也不會建立收貨或庫存</p>
      <label className="text-xs text-secondary">狀態 <select aria-label="SE 訂單狀態" className="ml-1 rounded-md border border-theme-border bg-page px-2 py-1.5 text-sm text-primary" value={status} onChange={event => setStatus(event.target.value)}>{statuses.map(value => <option key={value} value={value}>{value === 'removed' ? '已失效' : value === '全部' ? value : seOrderStatus(orders.find(view => seOrderStatus(view).filter === value)!).label}</option>)}</select></label></div>
    {message && <p role="status" className="text-sm text-accent">{message}</p>}
    {visible.map(view => {
      const order = view.order;
      const project = seOrderProject(view, projects);
      const linked = linkedPendingKeys(view, pending);
      return <details key={view.orderNo} open={focusOrderNo === view.orderNo ? true : undefined} className="rounded-lg border border-theme-border bg-page/40 p-3" data-se-order={view.orderNo}>
        <summary className="cursor-pointer"><div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><strong className="block break-words text-sm">{order?.siteName || '案場資訊未保留'}</strong><span className="text-xs text-secondary">訂單 {view.orderNo} · 案號 {order?.caseNumbers.length ? order.caseNumbers.join('、') : '未提供'}</span></div><span className="rounded bg-accent/10 px-2 py-1 text-xs text-accent">{seOrderStatus(view).label}</span></div>
          <p className="mt-2 text-xs text-secondary">{order?.items.map(item => `${item.name} × ${item.qty}`).join('、') || '無品項資料'} · {order?.carrier || '物流未提供'} · {order?.trackingNos.length ? order.trackingNos.join('、') : '無託運單號'}</p></summary>
        <div className="mt-3 space-y-3 border-t border-theme-border pt-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <p><span className="text-secondary">北部範圍</span><br />{view.scopeState === 'NORTH' ? '已確認北部' : view.scopeState === 'NOT_NORTH' ? '已確認非北部' : '待審核'}{project ? ` · ${project.name}` : view.scopeState === 'NORTH' ? ' · 多案場須逐品項確認' : ''}</p>
            <p><span className="text-secondary">待收貨關聯</span><br />{linked.length ? `已關聯 ${linked.length} 筆待收貨` : '未關聯；請使用既有預計收貨流程建立需求'}</p>
            <p><span className="text-secondary">物流／託運單號</span><br />{order?.carrier || '未提供'} · {order?.trackingNos.length ? order.trackingNos.join('、') : '未提供'}</p>
            {order && <p><span className="text-secondary">開單日期／最後異動</span><br />{order.createdAt} · {order.updatedAt || '未提供'}</p>}
            {view.removal && <p><span className="text-secondary">移除通知</span><br />{view.removal.reason} · {view.removal.removedAt}</p>}
          </div>
          {order && <section><h3 className="font-semibold">API 原始品項</h3><div className="mt-1 space-y-1">{order.items.map((item, index) => <p key={index} className="break-words">{index + 1}. {item.name} × {item.qty}</p>)}</div><p className="text-xs text-secondary">原始分行沒有品項 ID，也不代表已確認案場歸屬。</p></section>}
          {view.items.length > 0 && <section className="space-y-2"><h3 className="font-semibold">同型號統計與待收貨關聯</h3>{view.items.map(item => {
            const candidates = pendingCandidates(view, item, pending).filter(row => view.projectId || rules.some(rule =>
              order?.caseNumbers.includes(rule.caseNumber) && rule.scopeState === 'NORTH' && rule.projectId === row.projectId));
            const selected = choices[`link:${item.id}`] || '';
            return <div key={item.id} className="rounded-md border border-theme-border p-2"><strong>{item.name}</strong> · {item.quantity} 件
              <p className="mt-1 text-xs text-secondary">SN 預留（非 API 欄位）：{item.serials.length ? item.serials.join('、') : '尚無'}</p>
              {item.links.map(link => <div key={link.id} className="mt-1 flex flex-wrap items-center gap-2 text-xs">已關聯 {link.sourceType}:{link.sourceId} · {link.quantity} 件{canReview && <button type="button" disabled={busy} className="text-accent" onClick={() => void act(() => onUnlink(link.id))}>解除</button>}</div>)}
              {canReview && item.active && view.scopeState === 'NORTH' && !view.removal && order?.status !== 'cancelled' && <div className="mt-2 flex flex-wrap items-center gap-2"><select aria-label={`關聯待收貨 ${item.name}`} className="min-h-10 min-w-0 max-w-full rounded border border-theme-border bg-page px-2" value={selected} onChange={event => setChoice(`link:${item.id}`, event.target.value)}><option value="">選擇待收貨</option>{candidates.map(row => <option key={row.key} value={row.key}>{row.projectLabel} · {row.label} · 待收 {row.fulfilment.remaining}</option>)}</select><input aria-label={`關聯數量 ${item.name}`} type="number" min="0.001" step="any" className="min-h-10 w-24 rounded border border-theme-border bg-page px-2" value={quantities[item.id] || ''} onChange={event => setQuantities(current => ({ ...current, [item.id]: event.target.value }))} placeholder="數量" /><button type="button" disabled={busy || !selected || !(Number(quantities[item.id]) > 0)} className="min-h-10 rounded border border-theme-border px-3 text-accent" onClick={() => { const [type, sourceId] = selected.split(':'); void act(() => onLink(item.id, type as SEItemLink['sourceType'], sourceId, Number(quantities[item.id]))); }}>確認關聯</button></div>}
            </div>;
          })}</section>}
          {canReview && order && !view.removal && order.status !== 'cancelled' && <section className="space-y-2 border-t border-theme-border pt-3"><h3 className="font-semibold">管理員範圍審核</h3>
            {order.caseNumbers.map(caseNumber => { const rule = rules.find(value => value.caseNumber === caseNumber); const key = `case:${caseNumber}`; const chosen = choices[key] ?? rule?.projectId ?? ''; return <div key={caseNumber} className="flex flex-wrap items-center gap-2"><span>案號 {caseNumber} · {rule ? rule.scopeState === 'NORTH' ? '北部已確認' : '非北部已確認' : '待確認'}</span><select aria-label={`案號 ${caseNumber} 案場`} className="min-h-10 rounded border border-theme-border bg-page px-2" value={chosen} onChange={event => setChoice(key, event.target.value)}><option value="">選擇案場</option>{activeProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" disabled={busy || !chosen} className="min-h-10 rounded border border-theme-border px-2" onClick={() => void act(() => onSetCaseRule(caseNumber, 'NORTH', chosen))}>確認北部案號</button><button type="button" disabled={busy} className="min-h-10 rounded border border-theme-border px-2" onClick={() => void act(async () => { await onSetCaseRule(caseNumber, 'NOT_NORTH', null); if (order.caseNumbers.length === 1) await onConfirmScope(view.orderNo, 'NOT_NORTH', null); })}>標記非北部案號</button></div>; })}
            <div className="flex flex-wrap items-center gap-2"><select aria-label={`訂單 ${view.orderNo} 案場`} className="min-h-10 rounded border border-theme-border bg-page px-2" value={choices[`order:${view.orderNo}`] ?? view.projectId ?? ''} onChange={event => setChoice(`order:${view.orderNo}`, event.target.value)}><option value="">多案場／尚未選擇</option>{activeProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" disabled={busy} className="min-h-10 rounded border border-theme-border px-3 text-accent" onClick={() => void act(() => onConfirmScope(view.orderNo, 'NORTH', (choices[`order:${view.orderNo}`] ?? view.projectId) || null))}>確認北部訂單</button><button type="button" disabled={busy} className="min-h-10 rounded border border-theme-border px-3" onClick={() => void act(() => onConfirmScope(view.orderNo, 'NOT_NORTH', null))}>標記非北部訂單</button></div>
          </section>}
          {canReview && view.scopeState === 'NOT_NORTH' && !view.removal && <button type="button" disabled={busy} className="min-h-10 rounded border border-theme-border px-3" onClick={() => void act(() => onConfirmScope(view.orderNo, 'UNREVIEWED', null))}>重新審核；詳細資料待下一次同步</button>}
        </div>
      </details>;
    })}
    {!visible.length && <p className="py-10 text-center text-sm text-secondary">{needle || status !== '全部' ? '沒有符合條件的 SE 訂單' : '目前沒有 SE 訂單快照'}</p>}
  </div>;
}
