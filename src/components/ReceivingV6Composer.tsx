'use client';

import { useRef, useState } from 'react';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import { groupedSerialArrival, type SerialAutoDraft } from '@/lib/receiving-v6';
import { pendingRows, sourceFields, type PendingRow, type ReceivingSnapshot } from '@/lib/receiving-v5';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { useReceivingItems } from './useReceivingItems';
import { ReceiptDateTimeInput } from './ReceiptDateTimeInput';
import { ActionError, useV5Action, useV5Request, v5Field, v5Primary } from './ReceivingV5Forms';
import type { BoxSnapshot, ScanBox } from '@/lib/receiving-box-session';
import { resolveBoxArrival } from '@/lib/receiving-box-arrival';
import { ScannerModelResolver } from '@/lib/receiving-scanner-model';
import { BarcodeScanner } from './BarcodeScanner';
import type { InventoryItem } from '@/lib/db/types';

export function SerializedArrivalReview({ drafts, model, unknownCount, resolving }: {
  drafts: SerialAutoDraft[]; model?: InventoryItem; unknownCount: number; resolving: boolean;
}) {
  return <>
    <div><p className="text-xl font-semibold tabular-nums">{drafts.length} 台設備</p>{resolving && <p role="status" className="text-xs text-secondary">正在確認序號…</p>}</div>
    <ul aria-label="到貨序號" className="max-h-48 space-y-1 overflow-y-auto text-sm">{drafts.map(d => <li key={d.raw} className="break-all py-0.5 font-medium">{d.raw}</li>)}</ul>
    {model && <p className="text-sm text-secondary"><span className="mr-2">型號</span><span className="break-all text-primary">{model.code}</span></p>}
    {drafts.some(d => d.state === 'conflict') && <p className="text-sm text-warning">序號已存在或與品項衝突，請返回掃描確認。</p>}
    {drafts.some(d => d.choiceRequired) && <p className="text-sm text-warning">請選擇序號對應的預計收貨。</p>}
    {!model && drafts.some(d => d.state === 'unknown') && <p className="text-sm text-warning">待確認品項</p>}
    {unknownCount > 0 && <p className="text-sm text-warning">待確認條碼 · {unknownCount} 筆條碼需核對</p>}
  </>;
}

export function ReceivingV6Composer({ data: initialData, api, preferred, onClose, onSaved }: {
  data: ReceivingSnapshot; api: ReceivingV6Api; preferred?: PendingRow; onClose: () => void; onSaved: (result: CreateArrivalResult) => Promise<void>;
}) {
  const { data, createItem } = useReceivingItems(initialData, api);
  const pending = pendingRows(data);
  const initialItem = data.items.find(i => i.id === preferred?.itemId);
  const [phase, setPhase] = useState<'scan' | 'review' | 'plain'>('scan');
  const [itemId, setItemId] = useState(initialItem?.id || '');
  const [quantity, setQuantity] = useState('1');
  const [plainTarget, setPlainTarget] = useState(preferred?.key || '');
  const [at, setAt] = useState<string | null>(new Date().toISOString());
  const [adjustTime, setAdjustTime] = useState(false);
  const [drafts, setDrafts] = useState<SerialAutoDraft[]>([]);
  const [boxSnapshot, setBoxSnapshot] = useState<BoxSnapshot>();
  const [submitted, setSubmitted] = useState(false);
  const current = useRef<SerialAutoDraft[]>([]);
  const scannedModels = useRef(new Set<string>());
  const scannedUnknown = useRef(new Set<string>());
  const resolvedItems = useRef(new Map<string, InventoryItem>());
  const modelResolver = useRef<ScannerModelResolver | null>(null);
  const attemptedArrivalRequests = useRef(new Set<string>());
  if (!modelResolver.current) modelResolver.current = new ScannerModelResolver(initialData.items, createItem);
  const [resolving, setResolving] = useState(0);
  const action = useV5Action(), request = useV5Request();
  const update = (next: SerialAutoDraft[]) => { current.current = next; setDrafts(next); };
  const resolveModel = async (normalizedPN: string) => {
    const item = await modelResolver.current!.resolve(normalizedPN);
    resolvedItems.current.set(item.id, item);
    return item;
  };
  const acceptBoxes = async (boxes: ScanBox[], snapshot: BoxSnapshot) => {
    if (submitted) throw new Error('已完成實際到貨，請使用修改／撤回／更正。');
    setResolving(1);
    try {
      const items = Array.from(new Map([...data.items, ...Array.from(resolvedItems.current.values())].map(item => [item.id, item])).values());
      if (boxes.some(box => box.model?.kind === 'MODEL' && !items.some(item => item.id === box.model?.itemId && item.is_active && item.requires_serial)))
        throw new Error('型號尚未綁定可用的正式品項，請重試。');
      const next = await resolveBoxArrival(boxes, { ...data, items }, serials => api.lookupBatch(serials), preferred,
        serials => api.activeArrivalSerials(serials));
      update(next);
      setBoxSnapshot(snapshot);
      scannedModels.current = new Set(boxes.flatMap(box => box.model?.itemId ? [box.model.itemId] : []));
      scannedUnknown.current = new Set(boxes.flatMap(box => box.unknown.map(code => code.normalized)));
      setPhase('review');
    } finally { setResolving(0); }
  };
  const item = data.items.find(i => i.id === itemId && !i.requires_serial);
  const suggestions = pending.filter(p => !p.legacy && p.itemId === item?.id && p.fulfilment.active && p.fulfilment.remaining >= Number(quantity));
  const model = scannedModels.current.size === 1 ? data.items.find(i => i.id === Array.from(scannedModels.current)[0])
    || resolvedItems.current.get(Array.from(scannedModels.current)[0]) : undefined;
  if (phase === 'scan') return <BarcodeScanner mode="continuous" items={data.items} initialBoxes={boxSnapshot}
    onBoxesFinish={acceptBoxes} onResolveModel={resolveModel} onDetected={() => { /* Box session owns capture until final confirmation. */ }}
    onCancel={onClose} onNoBarcode={() => setPhase('plain')} />;
  return <form aria-label="實際到貨" className="min-w-0 space-y-4" onSubmit={event => {
    event.preventDefault();
    if (submitted) return;
    if (event.currentTarget.querySelector('[aria-invalid="true"]')) { action.setError('請先確認到貨時間。'); return; }
    void action.run(async () => {
      if (!at) throw new Error('請確認到貨時間。');
      const prepared = phase === 'review' ? groupedSerialArrival(drafts, pending) : {
        lines: item && Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? [{ inventory_item_id: item.id, quantity: Number(quantity), unit: item.unit }] : [],
        matches: plainTarget && suggestions.some(p => p.key === plainTarget) ? [{ ...sourceFields(suggestions.find(p => p.key === plainTarget)!), line_index: 0, quantity: Number(quantity) }] : [],
      };
      if (!prepared.lines.length) throw new Error('請加入序號，或選擇品項並填寫數量。');
      if (phase === 'plain' && plainTarget && !prepared.matches.length) throw new Error('預計收貨可對應數量不足，請重新選擇。');
      const args = request({ p_actual_received_at: at, p_lines: prepared.lines, p_matches: prepared.matches, p_project_id: preferred?.projectId || null });
      if (phase === 'review' && !attemptedArrivalRequests.current.has(args.p_request_id)) {
        const active = await api.activeArrivalSerials(drafts.map(d => d.raw));
        if (active.length) throw new Error(`序號 ${active.join('、')} 已存在到貨紀錄，請返回掃描確認。`);
      }
      // A retry with the same request ID must reach the RPC's cached response.
      attemptedArrivalRequests.current.add(args.p_request_id);
      const result = await api.create(args);
      setSubmitted(true);
      await onSaved(result);
    });
  }}>
    <fieldset disabled={action.busy || submitted} className="min-w-0 space-y-4">
      {phase === 'review' ? <>
        <p className="text-sm text-secondary">已掃 {boxSnapshot?.completedBoxes.length || 0} 箱・共 {drafts.length} 台</p>
        <SerializedArrivalReview drafts={drafts} model={model} unknownCount={scannedUnknown.current.size} resolving={Boolean(resolving)} />
        {preferred && <p className="text-xs text-secondary">對應預計收貨：{preferred.label}｜{preferred.projectLabel}</p>}
        {drafts.filter(d => d.choiceRequired).map(d => <label key={d.raw} className="block text-sm">{d.raw}：選擇預計收貨<select className={v5Field} value="" disabled={Boolean(resolving)} onChange={e => { const target = pending.find(p => p.key === e.target.value); update(current.current.map(x => x.raw === d.raw ? { ...x, pendingKey: target?.key || null, itemId: target?.itemId || x.itemId, state: target?.itemId || x.itemId ? 'known' : 'unknown', choiceRequired: false } : x)); }}><option value="" disabled>請選擇</option>{d.candidates.map(key => { const p = pending.find(p => p.key === key)!; return <option value={key} key={key}>{p.label}｜{p.projectLabel}｜剩餘 {p.fulfilment.remaining}</option>; })}<option value="standalone">保留未對應</option></select></label>)}
      </> : <>
        <p className="text-lg font-semibold">無條碼物料</p>
        <InventoryItemCombobox items={data.items.filter(i => i.is_active)} value={itemId} onCreate={createItem} serialRequirement={false} onChange={id => { setItemId(id); setPlainTarget(''); }} />
        <label className="block text-sm">數量（{item?.unit || '—'}）<input aria-label="實收數量" className={v5Field} type="number" min="0.001" step="any" required value={quantity} onChange={e => { setQuantity(e.target.value); }} /></label>
        {preferred?.projectId && <p className="text-xs text-secondary">案件：{preferred.projectLabel}</p>}
      </>}
      <div className="border-t border-theme-border pt-3"><div className="flex items-center justify-between gap-2 text-sm"><span>到貨時間：{adjustTime ? '已調整' : '現在'}</span><button type="button" className="min-h-11 px-2 text-sm text-accent" onClick={() => setAdjustTime(v => !v)}>調整</button></div>{adjustTime && <ReceiptDateTimeInput label="實際到貨" value={at} onChange={setAt} required />}</div>
    </fieldset>
    <ActionError message={action.error} />
    <button className={v5Primary + ' w-full'} disabled={submitted || action.busy || Boolean(resolving) || drafts.some(d => d.choiceRequired || d.state === 'conflict') || (phase === 'review' ? !drafts.length : !item)}>{submitted ? '已完成實際到貨' : action.busy ? '儲存中…' : '完成實際到貨'}</button>
    <div className="flex justify-between text-sm"><button type="button" className="min-h-11 px-2 text-accent" disabled={submitted || action.busy || Boolean(resolving)} onClick={() => setPhase('scan')}>返回掃描</button><button type="button" className="min-h-11 px-2 text-secondary" disabled={submitted || action.busy || Boolean(resolving)} onClick={onClose}>取消</button></div>
  </form>;
}
