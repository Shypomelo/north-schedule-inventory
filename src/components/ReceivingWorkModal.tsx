'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowLeft } from 'lucide-react';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import { handoffCorrectionRequired, type HandoffAllocation, type HandoffScope, type ReceivingV6Snapshot, type ReceivingWorkItem, type ArrivalSlice } from '@/lib/receiving-v6';
import { pendingRows, receivingError, type ActualRow } from '@/lib/receiving-v5';
import { compatibleProjectRequirements, selectProjectRequirement, type ReceivingProjectRequirement } from '@/lib/receiving-project-requirements';
import { formatTaipeiReceivingTime } from '@/lib/material-receiving';
import { selectActiveProjects } from '@/lib/project-selectors';
import { PendingForm, PendingSerialEditor, ActionError, useV5Action, useV5Request, v5Button, v5Field, v5Primary } from './ReceivingV5Forms';
import { ArrivalMetadata, MatchEditor } from './ReceivingV5Rows';
import { ReceivingV6Composer } from './ReceivingV6Composer';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';
import { useReceivingItems } from './useReceivingItems';

export function ReceivingWorkModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1) return;
      if (event.key === 'Escape' && !(event.target as HTMLElement)?.closest('[role="combobox"]')) { event.preventDefault(); if (!panel.current?.querySelector('fieldset:disabled,[aria-busy="true"]')) close.current(); }
      if (event.key === 'Tab') {
        const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex="0"]') || []).filter(e => e.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/45 sm:items-center sm:p-5">
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClickCapture={event => { if (panel.current?.querySelector('fieldset:disabled,[aria-busy="true"]')) { event.preventDefault(); event.stopPropagation(); } }} className="flex max-h-[96dvh] w-full min-w-0 flex-col rounded-t-2xl border border-theme-border bg-card shadow-xl outline-none sm:max-h-[88dvh] sm:max-w-[820px] sm:rounded-2xl">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border px-4 py-3 sm:px-6"><h2 className="min-w-0 truncate text-base font-bold">{title}</h2><button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-page" aria-label="關閉收貨工作" onClick={onClose}><X size={20} /></button></header>
      <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">{children}</div>
    </div>
  </div>, document.body);
}

type WorkView = { kind: 'summary' | 'actual' | 'pending' | 'cancel' | 'serial' | 'history' } | { kind: 'match' | 'metadata'; actual: ActualRow } | { kind: 'handoff'; slice: ArrivalSlice; route: 'SE' | 'SITE'; allocation?: HandoffAllocation } | { kind: 'retract'; slice: ArrivalSlice; allocation: HandoffAllocation };
export function ReceivingWorkBody({ row, data, api, canEdit, onChanged, onCreated }: {
  row: ReceivingWorkItem; data: ReceivingV6Snapshot; api: ReceivingV6Api; canEdit: boolean; onChanged: () => Promise<void>; onCreated: (result: CreateArrivalResult) => Promise<void>;
}) {
  const [view, setView] = useState<WorkView>({ kind: 'summary' });
  const [reason, setReason] = useState('');
  const action = useV5Action(), request = useV5Request();
  const back = () => setView({ kind: 'summary' });
  const changed = async () => { back(); await onChanged(); };
  const p = row.pending;
  const backButton = <button type="button" className={v5Button + ' mb-4 inline-flex items-center gap-2'} onClick={back}><ArrowLeft size={16} />返回收貨摘要</button>;
  if (view.kind === 'actual') return <>{backButton}<ReceivingV6Composer data={data} api={api} preferred={p} onClose={back} onSaved={async result => { back(); await onCreated(result); }} /></>;
  if (view.kind === 'pending' && p) return <>{backButton}<PendingForm embedded data={data} api={api} row={p} onClose={back} onSaved={changed} /></>;
  if (view.kind === 'serial' && p) return <>{backButton}<PendingSerialEditor row={p} data={data} api={api} scan={false} onSaved={onChanged} onClose={back} /></>;
  if (view.kind === 'match') return <>{backButton}<MatchEditor row={view.actual} data={data} pending={pendingRows(data)} api={api} onChanged={onChanged} onClose={back} /></>;
  if (view.kind === 'metadata') return <>{backButton}<ArrivalMetadata row={view.actual} data={data} api={api} onChanged={onChanged} onClose={back} /></>;
  if (view.kind === 'handoff') return <>{backButton}<HandoffEditor key={view.allocation?.id || view.slice.receiptId!} view={view} data={data} api={api} onClose={back} onChanged={changed} /></>;
  if (view.kind === 'cancel' && p) return <>{backButton}<section aria-busy={action.busy} className="space-y-4"><h3 className="font-semibold">取消剩餘</h3><p className="text-sm">原預計 {p.fulfilment.expected}，已到 {p.fulfilment.fulfilled}；剩餘 {p.fulfilment.remaining} 將不再等待。原預計量和收貨紀錄會保留。</p><label className="block text-sm">原因（選填）<input className={v5Field} value={reason} onChange={e => setReason(e.target.value)} /></label><ActionError message={action.error} /><button type="button" className={v5Primary} disabled={action.busy || !canEdit} onClick={() => void action.run(async () => { await api.cancelRemaining(request({ p_source_type: p.kind, p_source_id: p.id, p_reason: reason.trim() || null })); await changed(); })}>確認取消剩餘</button></section></>;
  if (view.kind === 'retract') {
    const scope = data.scopes[view.slice.receiptId!], a = view.allocation;
    const quantity = a.route_type === 'SITE' ? scope.allocations.filter(x => x.site_receipt_id === a.site_receipt_id && !x.cancelled_at).reduce((n, x) => n + Number(x.quantity), 0) : a.quantity;
    const blocked = handoffCorrectionRequired(a, scope, data);
    return <>{backButton}<section aria-busy={action.busy} className="space-y-4"><h3 className="font-semibold">撤回{a.route_type === 'SE' ? ' SE 供貨追蹤' : '送至案場'}</h3><p className="text-sm">{a.route_type === 'SITE' ? '將撤回這次完整送貨' : '將撤回這筆供貨追蹤'}，共 {quantity} {row.unit}，恢復北辦可用量。原到貨紀錄會保留。</p><label className="block text-sm">撤回原因<input required className={v5Field} value={reason} onChange={e => setReason(e.target.value)} /></label>{blocked && <p className="text-sm text-warning">此筆已有後續使用，需走更正流程。</p>}<ActionError message={action.error} /><button type="button" className={v5Primary} disabled={action.busy || !canEdit || !reason.trim() || blocked} onClick={() => void action.run(async () => { await api.retract(request({ p_allocation_id: a.id, p_reason: reason.trim() })); await changed(); })}>確認撤回</button></section></>;
  }
  if (view.kind === 'history') return <>{backButton}<h3 className="mb-3 font-semibold">收貨歷程</h3><div className="divide-y divide-theme-border">{row.slices.map((s, i) => <p key={s.actual.key + i} className="py-3 text-sm">{formatTaipeiReceivingTime(s.actual.at)}｜收到 {s.quantity} {row.unit}{s.actual.reversed ? `，已更正 ${s.actual.reversed}` : ''}</p>)}{p?.fulfilment.cancellation && <p className="py-3 text-sm">{formatTaipeiReceivingTime(p.fulfilment.cancellation.cancelled_at)}｜取消剩餘 {p.fulfilment.cancellation.cancelled_remaining}，原預計 {p.fulfilment.expected}</p>}</div></>;
  return <div className="divide-y divide-theme-border">
    <section aria-label="收貨摘要" className="space-y-3 pb-4"><h3 className="text-sm font-semibold text-secondary">收貨摘要</h3><p className="break-words font-semibold">{row.label}</p><p className="text-sm text-secondary">{row.projectLabel} · {row.status}</p>{p ? <><dl className="grid grid-cols-3 gap-3 text-sm">{[['預計', p.fulfilment.expected], ['已到', p.fulfilment.fulfilled], ['剩餘', p.fulfilment.remaining]].map(([label, n]) => <div key={label}><dt className="text-secondary">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{n}<span className="ml-1 text-sm font-normal">{row.unit}</span></dd></div>)}</dl><p className="text-sm">預計到貨：{p.expectedAt ? formatTaipeiReceivingTime(p.expectedAt) : '未定'}{p.fulfilment.cancellation ? `｜已取消剩餘 ${p.fulfilment.cancellation.cancelled_remaining}` : ''}</p>{canEdit && p.fulfilment.active && !p.legacy && <div className="flex flex-wrap gap-2"><button className={v5Button} onClick={() => setView({ kind: 'pending' })}>修改預計</button><button className={v5Button} onClick={() => setView({ kind: 'cancel' })}>取消剩餘</button></div>}</> : <p className="text-sm">{formatTaipeiReceivingTime(row.at)}｜到貨 {row.received} {row.unit}｜未對應預計收貨</p>}</section>
    <section aria-label="實際到貨" className="space-y-3 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-secondary">實際到貨</h3>{canEdit && (!p || p.fulfilment.active) && !p?.legacy && <button className={v5Button} onClick={() => setView({ kind: 'actual' })}>＋繼續收貨</button>}</div>{!row.slices.length && <p className="text-sm text-secondary">尚未收到實物。</p>}{row.slices.map((s, index) => <div key={s.actual.key + index} className="space-y-2 py-1"><p className="text-sm font-semibold">{formatTaipeiReceivingTime(s.actual.at)}</p><p className="text-sm">{s.quantity} {row.unit}{s.entryIds.length ? `｜序號 ${s.entryIds.length}` : ''}{s.quantity !== s.actual.quantity ? `｜整批 ${s.actual.quantity}，本列對應 ${s.quantity}` : ''}{s.actual.state === 'POSTED' ? '｜已入庫' : s.actual.state === 'LEGACY' ? '｜歷史收貨' : s.actual.state === 'STAGED' ? '｜待入庫' : '｜待補資料'}</p>{s.entryIds.length > 0 && <details><summary className="cursor-pointer py-2 text-sm text-accent">查看序號</summary><ul className="max-h-40 overflow-y-auto text-sm">{s.actual.observations.filter(e => s.entryIds.includes(e.id)).map(e => <li className="break-all py-1" key={e.id}>{e.normalized_serial}</li>)}</ul></details>}{s.actual.state === 'UNRESOLVED' && canEdit && <CompleteUnknown row={s.actual} data={data} api={api} onChanged={onChanged} />}{s.actual.state === 'POSTED' && canEdit && <button className={v5Button} onClick={() => setView({ kind: 'match', actual: s.actual })}>{s.actual.matches.length ? '調整預計收貨對應' : '對應預計收貨'}</button>}</div>)}</section>
    {!row.slices.some(s => s.receiptId && data.scopes[s.receiptId]) && <section aria-label="後續處理" className="space-y-3 py-4"><h3 className="text-sm font-semibold text-secondary">後續處理</h3><p className="text-sm text-secondary">完成入庫並確認可用庫存後，可安排後續處理。</p></section>}
    {row.slices.some(s => s.receiptId && data.scopes[s.receiptId]) && <section aria-label="後續處理" className="space-y-4 py-4"><h3 className="text-sm font-semibold text-secondary">後續處理</h3>{row.slices.map((s, i) => {
      const scope = s.receiptId && data.scopes[s.receiptId]; if (!scope) return null;
      const shared = s.quantity !== scope.received;
      const allocations = scope.allocations.filter(a => !scope.requires_serial || a.inventory_serial_id && s.serialIds.includes(a.inventory_serial_id));
      const groups = new Map<string, HandoffAllocation[]>();
      allocations.forEach(a => { const key = a.route_type === 'SITE' ? a.site_receipt_id! : a.id; groups.set(key, [...groups.get(key) || [], a]); });
      return <div key={s.actual.key + i} className="space-y-3"><p className="text-sm">{formatTaipeiReceivingTime(s.actual.at)}{shared ? '｜以下為整批收貨，共用可用量' : ''}</p><p className="text-sm tabular-nums">目前北辦 {Math.max(0, scope.received - scope.site - scope.other)}｜可用 {scope.available}｜SE 供貨追蹤 {scope.se}｜已送案場 {scope.site}</p>{canEdit && scope.available > 0 && <div className="flex flex-wrap gap-2"><button className={v5Button} onClick={() => setView({ kind: 'handoff', slice: s, route: 'SE' })}>加入 SE 供貨追蹤</button><button className={v5Button} onClick={() => setView({ kind: 'handoff', slice: s, route: 'SITE' })}>送至案場</button></div>}
        {Array.from(groups).map(([key, records]) => { const a = records[0], se = data.supplies.find(x => x.id === a.se_supply_record_id), tx = data.transactions.find(t => t.id === a.inventory_transaction_id), projectId = se?.project_id || tx?.project_id;
          const correction = handoffCorrectionRequired(a, scope, data); const cancelled = Boolean(a.cancelled_at);
          return <div key={key} className="space-y-2 border-l-2 border-theme-border pl-3 text-sm"><p>{formatTaipeiReceivingTime(a.created_at)}｜{a.route_type === 'SE' ? 'SE 供貨追蹤' : '已送案場'}｜{data.projects.find(p => p.id === projectId)?.name || '未指定案件'}</p><p className="break-all">{scope.requires_serial ? records.map(r => data.observations.find(e => e.inventory_serial_id === r.inventory_serial_id)?.normalized_serial || '歷史序號').join('、') : `${a.quantity} ${row.unit}`}{cancelled ? '｜已撤回／調整' : ''}</p>{a.se_supply_record_id && <a className="text-accent underline" href={'/se-supply?record=' + a.se_supply_record_id}>查看 SE #{a.se_supply_record_id.slice(0, 8)}</a>}{!cancelled && canEdit && (correction ? <button type="button" className={v5Button} onClick={() => action.setError('此筆已有後續使用，需走更正流程。更正操作為後續功能。')}>更正</button> : <div className="flex gap-2">{a.route_type === 'SE' && <button className={v5Button} onClick={() => setView({ kind: 'handoff', slice: s, route: 'SE', allocation: a })}>修改</button>}<button className={v5Button} onClick={() => { setReason(''); setView({ kind: 'retract', slice: s, allocation: a }); }}>撤回</button></div>)}</div>;
        })}
      </div>;
    })}<ActionError message={action.error} /></section>}
    {row.slices.some(s => s.receiptId && data.scopeErrors[s.receiptId]) && <p className="py-3 text-sm text-warning">目前無法確認可用庫存，請重新整理後再進行後續處理。</p>}
    <section aria-label="其他資訊" className="space-y-3 pt-4"><h3 className="text-sm font-semibold text-secondary">其他資訊</h3>{p?.notes && <p className="break-words text-sm">{p.notes}</p>}{p && <details><summary className="cursor-pointer py-2 text-sm">預登序號（{p.observations.length}）</summary><ul className="max-h-40 overflow-y-auto text-sm">{p.observations.map(e => <li className="break-all" key={e.id}>{e.normalized_serial}</li>)}</ul>{canEdit && p.fulfilment.active && data.items.find(i => i.id === p.itemId)?.requires_serial && <button className={v5Button} onClick={() => setView({ kind: 'serial' })}>預登序號／掃碼預登</button>}</details>}{row.slices.filter(s => s.actual.arrival).map((s, i) => <div key={s.actual.key + i} className="space-y-2"><p className="break-words text-sm">{s.actual.arrival?.notes || ''}</p>{canEdit && <button className={v5Button} onClick={() => setView({ kind: 'metadata', actual: s.actual })}>修改到貨案件／備註</button>}</div>)}<button className={v5Button} onClick={() => setView({ kind: 'history' })}>查看歷程</button></section>
  </div>;
}

function CompleteUnknown({ row, data: initialData, api, onChanged }: { row: ActualRow; data: ReceivingV6Snapshot; api: ReceivingV6Api; onChanged: () => Promise<void> }) {
  const { data, createItem } = useReceivingItems(initialData, api);
  const [itemId, setItemId] = useState(''), [projectId, setProjectId] = useState(row.arrival?.project_id || ''), [notes, setNotes] = useState(row.arrival?.notes || '');
  const action = useV5Action(), request = useV5Request();
  return <form aria-label="完成到貨資料" className="space-y-3" onSubmit={e => { e.preventDefault(); void action.run(async () => {
    const checks = await Promise.all(row.observations.map(o => api.lookup(o.raw_serial)));
    if (checks.some(r => r.result_type !== 'no_match')) throw new Error('ARRIVAL_SERIAL_IDENTITY_CONFLICT');
    if (projectId !== (row.arrival!.project_id || '') || notes !== (row.arrival!.notes || '')) await api.metadata(request({ p_arrival_id: row.arrival!.id, p_expected_version: row.arrival!.version, p_project_id: projectId || null, p_notes: notes || null }));
    await api.complete(request({ p_line_id: row.line!.id, p_item_id: itemId })); await onChanged();
  }); }}><p className="text-sm text-warning">實物在北辦，尚未計入正式庫存。</p><fieldset disabled={action.busy} className="min-w-0 space-y-3"><InventoryItemCombobox items={data.items.filter(i => i.is_active)} value={itemId} onCreate={createItem} serialRequirement={Boolean(row.observations.length)} onChange={setItemId} /><ReceivingProjectCombobox projects={selectActiveProjects(data.projects)} value={projectId} onChange={setProjectId} /><label className="block text-sm">備註（選填）<input className={v5Field} value={notes} onChange={e => setNotes(e.target.value)} /></label></fieldset><ActionError message={action.error} /><button className={v5Primary} disabled={action.busy || !itemId}>完成資料並入庫</button></form>;
}

function HandoffEditor({ view, data, api, onClose, onChanged }: { view: Extract<WorkView, { kind: 'handoff' }>; data: ReceivingV6Snapshot; api: ReceivingV6Api; onClose: () => void; onChanged: () => Promise<void> }) {
  const scope = data.scopes[view.slice.receiptId!], a = view.allocation;
  const se = data.supplies.find(s => s.id === a?.se_supply_record_id);
  const [serialIds, setSerialIds] = useState<string[]>(a?.inventory_serial_id ? [a.inventory_serial_id] : []);
  const [quantity, setQuantity] = useState(String(a?.quantity || 1));
  const [projectId, setProjectId] = useState(se?.project_id || '');
  const [requirements, setRequirements] = useState<{ projectId: string; rows: ReceivingProjectRequirement[] } | null>(null);
  const [requirementId, setRequirementId] = useState(''), [requirementError, setRequirementError] = useState('');
  const [expectedVersion] = useState(se?.updated_at || '');
  const [at] = useState(new Date().toISOString());
  const action = useV5Action(), request = useV5Request();
  const allowed = Array.from(new Set([...scope.available_serial_ids.filter(id => view.slice.serialIds.includes(id)), ...(a?.inventory_serial_id ? [a.inventory_serial_id] : [])]));
  const amount = scope.requires_serial ? serialIds.length : Number(quantity);
  useEffect(() => { setRequirementId(''); }, [amount]);
  useEffect(() => {
    let cancelled = false; setRequirements(null); setRequirementId(''); setRequirementError('');
    if (view.route === 'SITE' && projectId) void api.projectRequirements(projectId, scope.item_id)
      .then(rows => { if (!cancelled) setRequirements({ projectId, rows }); })
      .catch(error => { if (!cancelled) setRequirementError(receivingError(error)); });
    return () => { cancelled = true; };
  }, [api, projectId, scope.item_id, view.route]);
  const requirementsReady = Boolean(requirements && requirements.projectId === projectId);
  const candidates = requirementsReady ? compatibleProjectRequirements(requirements!.rows, amount) : [];
  const target = requirementsReady ? selectProjectRequirement(requirements!.rows, amount, requirementId) : null;
  const requirementControl = view.route === 'SITE' && projectId ? <div className="space-y-2 text-sm">
    {!requirementsReady && !requirementError && <p role="status">查詢案場物料需求…</p>}
    <ActionError message={requirementError} />
    {requirementsReady && (candidates.length ? <label className="block">案場物料需求<select aria-label="案場物料需求" className={v5Field} value={target?.materialId || ''} onChange={e => setRequirementId(e.target.value)}><option value="">請選擇需求</option>{candidates.map(r => <option value={r.id} key={r.id}>{r.batch_name}｜{r.specification || r.item_name}｜需求 {r.quantity}・已收 {r.received}・剩 {Number(r.quantity) - Number(r.received)} {r.unit}</option>)}</select></label> : <p>此案場沒有可承接本次数量的相容需求；送達時建立新的案場物料。</p>)}
  </div> : null;
  return <form aria-label={a ? '修改 SE 供貨追蹤' : view.route === 'SE' ? '加入 SE 供貨追蹤' : '送至案場'} className="space-y-4" onSubmit={e => { e.preventDefault(); void action.run(async () => {
    const amount = scope.requires_serial ? serialIds.length : Number(quantity);
    if (!Number.isFinite(amount) || amount <= 0 || (!scope.requires_serial && amount > scope.available + Number(a?.quantity || 0))) throw new Error('請選擇本批可用的序號或數量。');
    if (view.route === 'SITE' && !projectId) throw new Error('請選擇案件。');
    if (a) await api.changeHandoff(request({ p_allocation_id: a.id, p_quantity: amount, p_serial_id: serialIds[0] || null, p_project_id: projectId || null, p_expected_updated_at: expectedVersion }));
    else {
      if (view.route === 'SITE' && !target) throw new Error('請先選擇有效的案場物料需求。');
      await api.handoff(request({ p_receipt_id: scope.receipt_id, p_route_type: view.route, p_quantity: amount, p_serial_ids: serialIds, p_project_id: projectId || null, p_received_at: at, p_material_id: target?.materialId || null, p_create_new: view.route === 'SITE' && Boolean(target?.createNew) }));
    }
    await onChanged();
  }); }}><h3 className="font-semibold">{a ? '修改 SE 供貨追蹤' : view.route === 'SE' ? '加入 SE 供貨追蹤' : '送至案場'}</h3><fieldset disabled={action.busy} className="min-w-0 space-y-4">{scope.requires_serial ? <div className="max-h-64 overflow-y-auto" aria-label="本批可用序號">{allowed.map(id => <label className="flex min-h-11 items-center gap-3 text-sm" key={id}><input type={a ? 'radio' : 'checkbox'} name="handoff-serial" checked={serialIds.includes(id)} onChange={e => setSerialIds(a ? [id] : e.target.checked ? [...serialIds, id] : serialIds.filter(x => x !== id))} /><span className="break-all">{data.observations.find(e => e.inventory_serial_id === id)?.normalized_serial || '歷史序號'}</span></label>)}</div> : <label className="block text-sm">數量（可用 {scope.available + Number(a?.quantity || 0)}）<input type="number" min="0.001" step="any" required className={v5Field} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}<ReceivingProjectCombobox required={view.route === 'SITE'} projects={selectActiveProjects(data.projects)} value={projectId} onChange={setProjectId} />{requirementControl}{view.route === 'SITE' && <p className="text-sm text-warning">確認後代表物料已實際送達案場。</p>}</fieldset><ActionError message={action.error} /><div className="flex flex-wrap justify-end gap-2"><button className={v5Button} type="button" disabled={action.busy} onClick={onClose}>取消</button><button className={v5Primary} disabled={action.busy || (view.route === 'SITE' && !target)}>{a ? '儲存修改' : view.route === 'SE' ? '轉入 SE 供貨追蹤' : '確認送至案場'}</button></div></form>;
}
