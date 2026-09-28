'use client';

import { useRef, useState } from 'react';
import type { CreateArrivalResult } from '@/lib/db/receiving-v5';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import { finishSerialDraft, groupedSerialArrival, pendingSerialDraft, type SerialAutoDraft } from '@/lib/receiving-v6';
import { pendingRows, sourceFields, serialsAlias, itemLabel, type PendingRow, type ReceivingSnapshot } from '@/lib/receiving-v5';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { useReceivingItems } from './useReceivingItems';
import { ReceiptDateTimeInput } from './ReceiptDateTimeInput';
import { ActionError, SerialInput, useV5Action, useV5Request, v5Button, v5Field, v5Primary } from './ReceivingV5Forms';

export function ReceivingV6Composer({ data: initialData, api, preferred, onClose, onSaved }: {
  data: ReceivingSnapshot; api: ReceivingV6Api; preferred?: PendingRow; onClose: () => void; onSaved: (result: CreateArrivalResult) => Promise<void>;
}) {
  const { data, createItem } = useReceivingItems(initialData, api);
  const pending = pendingRows(data);
  const initialItem = data.items.find(i => i.id === preferred?.itemId);
  const [mode, setMode] = useState<'serial' | 'plain'>(initialItem && !initialItem.requires_serial ? 'plain' : 'serial');
  const [itemId, setItemId] = useState(initialItem?.id || '');
  const [quantity, setQuantity] = useState('1');
  const [plainTarget, setPlainTarget] = useState(preferred?.key || '');
  const [at, setAt] = useState<string | null>(new Date().toISOString());
  const [adjustTime, setAdjustTime] = useState(false);
  const [drafts, setDrafts] = useState<SerialAutoDraft[]>([]);
  const current = useRef<SerialAutoDraft[]>([]), queue = useRef(Promise.resolve());
  const [resolving, setResolving] = useState(0);
  const action = useV5Action(), request = useV5Request();
  const update = (next: SerialAutoDraft[]) => { current.current = next; setDrafts(next); };
  const accept = (raw: string) => {
    setResolving(n => n + 1);
    const task = queue.current.then(async () => {
      if (current.current.some(d => serialsAlias(d.raw, raw))) return '已在本批清單';
      // Pending evidence is consulted first; canonical lookup still prevents duplicate IN.
      let draft = finishSerialDraft(pendingSerialDraft(raw, data, preferred?.projectId), await api.lookup(raw), data, preferred);
      if (preferred && !draft.candidates.length && draft.state === 'known' && draft.itemId === preferred.itemId) draft = { ...draft, pendingKey: preferred.key };
      update([...current.current, draft]);
      const target = pending.find(p => p.key === draft.pendingKey);
      return target ? `✓ 已找到預計收貨：${target.label}｜${target.projectLabel}，目前已到 ${target.fulfilment.fulfilled} / ${target.fulfilment.expected}` : draft.choiceRequired ? `找到 ${draft.candidates.length} 筆可能的預計收貨，請選擇。` : '已加入，未對應預計收貨';
    });
    queue.current = task.then(() => {}, () => {});
    return task.finally(() => setResolving(n => n - 1));
  };
  const item = data.items.find(i => i.id === itemId && !i.requires_serial);
  const suggestions = pending.filter(p => !p.legacy && p.itemId === item?.id && p.fulfilment.active && p.fulfilment.remaining >= Number(quantity));
  const groups = new Map<string, number>();
  for (const d of drafts) { const key = d.pendingKey || (d.state === 'known' ? 'unmatched' : 'unknown'); groups.set(key, (groups.get(key) || 0) + 1); }
  return <form aria-label="實際到貨" className="min-w-0 space-y-4" onSubmit={event => {
    event.preventDefault();
    if (event.currentTarget.querySelector('[aria-invalid="true"]')) { action.setError('請先確認到貨時間。'); return; }
    void action.run(async () => {
      if (!at) throw new Error('請確認到貨時間。');
      const prepared = mode === 'serial' ? groupedSerialArrival(drafts, pending) : {
        lines: item && Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? [{ inventory_item_id: item.id, quantity: Number(quantity), unit: item.unit }] : [],
        matches: plainTarget && suggestions.some(p => p.key === plainTarget) ? [{ ...sourceFields(suggestions.find(p => p.key === plainTarget)!), line_index: 0, quantity: Number(quantity) }] : [],
      };
      if (!prepared.lines.length) throw new Error('請加入序號，或選擇品項並填寫數量。');
      if (mode === 'plain' && plainTarget && !prepared.matches.length) throw new Error('預計收貨可對應數量不足，請重新選擇。');
      const result = await api.create(request({ p_actual_received_at: at, p_lines: prepared.lines, p_matches: prepared.matches, p_project_id: preferred?.projectId || null }));
      await onSaved(result);
    });
  }}>
    <fieldset disabled={action.busy} className="min-w-0 space-y-4">
      <div className="flex gap-2">{(['serial', 'plain'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? v5Primary : v5Button} disabled={Boolean(resolving || drafts.length)} onClick={() => setMode(m)}>{m === 'serial' ? '有序號設備' : '無序號物料'}</button>)}</div>
      {preferred && <p className="text-sm text-secondary">繼續收貨：{preferred.label}｜{preferred.projectLabel}｜剩餘 {preferred.fulfilment.remaining}</p>}
      {mode === 'serial' ? <>
        <SerialInput compact data={data} disabled={action.busy} draft={{ drafts, resolving, accept, remove: raw => update(current.current.filter(d => d.raw !== raw)), reset: () => update([]) }} />
        {drafts.length > 0 && <div className="space-y-2 border-t border-theme-border pt-3" aria-label="本批分組"><p className="font-semibold">本批 {drafts.length}</p>{Array.from(groups).map(([key, n]) => { const p = pending.find(p => p.key === key); return <p className="flex justify-between gap-3 text-sm" key={key}><span className="min-w-0 break-words">{p ? `${p.label}｜${p.projectLabel}` : key === 'unknown' ? '未對應・待補資料' : '未對應預計收貨'}</span><span className="shrink-0">{n} 台</span></p>; })}</div>}
        {drafts.filter(d => d.choiceRequired).map(d => <label key={d.raw} className="block text-sm">{d.raw}：找到 {d.candidates.length} 筆可能的預計收貨<select className={v5Field} value="" disabled={Boolean(resolving)} onChange={e => { const target = pending.find(p => p.key === e.target.value); update(current.current.map(x => x.raw === d.raw ? { ...x, pendingKey: target?.key || null, itemId: target?.itemId || x.itemId, state: target?.itemId || x.itemId ? 'known' : 'unknown', choiceRequired: false } : x)); }}><option value="" disabled>請選擇</option>{d.candidates.map(key => { const p = pending.find(p => p.key === key)!; return <option value={key} key={key}>{p.label}｜{p.projectLabel}｜剩餘 {p.fulfilment.remaining}</option>; })}<option value="standalone">保留未對應</option></select></label>)}
      </> : <>
        <InventoryItemCombobox items={data.items.filter(i => i.is_active)} value={itemId} onCreate={createItem} serialRequirement={false} onChange={id => { setItemId(id); setPlainTarget(''); }} />
        <label className="block text-sm">數量（{item?.unit || '—'}）<input aria-label="實收數量" className={v5Field} type="number" min="0.001" step="any" required value={quantity} onChange={e => { setQuantity(e.target.value); }} /></label>
        {suggestions.map(p => <div key={p.key} className="space-y-2 border-t border-theme-border pt-3"><p className="text-sm">建議對應：{p.label} ×{p.fulfilment.expected}｜{p.projectLabel}｜剩餘 {p.fulfilment.remaining}</p><button type="button" aria-pressed={plainTarget === p.key} className={plainTarget === p.key ? v5Primary : v5Button} onClick={() => setPlainTarget(plainTarget === p.key ? '' : p.key)}>{plainTarget === p.key ? '已選擇・取消對應' : '使用此預計收貨'}</button></div>)}
        {!plainTarget && <p className="text-sm text-secondary">本批會獨立記錄實際到貨。</p>}
      </>}
      <div className="border-t border-theme-border pt-3"><div className="flex items-center justify-between gap-2 text-sm"><span>到貨時間：{adjustTime ? '已調整' : '現在'}</span><button type="button" className={v5Button} onClick={() => setAdjustTime(v => !v)}>調整時間</button></div>{adjustTime && <ReceiptDateTimeInput label="實際到貨" value={at} onChange={setAt} required />}</div>
    </fieldset>
    <ActionError message={action.error} />
    <div className="flex justify-end gap-2 border-t border-theme-border pt-3"><button type="button" className={v5Button} disabled={action.busy || Boolean(resolving)} onClick={onClose}>取消</button><button className={v5Primary} disabled={action.busy || Boolean(resolving) || drafts.some(d => d.choiceRequired) || (mode === 'serial' ? !drafts.length : !item)}>{action.busy ? '儲存中…' : '完成實際到貨'}</button></div>
  </form>;
}
