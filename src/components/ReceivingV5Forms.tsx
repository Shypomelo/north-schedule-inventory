'use client';

import { FormEvent, useRef, useState } from 'react';
import { BarcodeScanner } from './BarcodeScanner';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';
import { useReceivingItems } from './useReceivingItems';
import { ReceiptDateTimeInput } from './ReceiptDateTimeInput';
import pendingCompactStyles from './ReceivingPendingCompact.module.css';
import type { ReceivingV5Api, CreateArrivalResult } from '@/lib/db/receiving-v5';
import {
  receivingError, resolveArrivalSerial, serialDraftLines, serialsAlias, sourceFields, itemLabel,
  type ArrivalSerialDraft, type PendingRow, type ReceivingSnapshot,
} from '@/lib/receiving-v5';
import { parseSerialBatch } from '@/lib/receiving-serial-draft';
import type { ScannerCode } from '@/lib/receiving-scanner-session';
import { selectActiveProjects } from '@/lib/project-selectors';
import { formatTaipeiReceivingTime } from '@/lib/material-receiving';

export const v5Field = 'mt-1 min-h-11 min-w-0 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary';
export const v5Button = 'min-h-11 max-w-full rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold disabled:opacity-40';
export const v5Primary = v5Button + ' bg-accent text-white';
export function useV5Request() {
  const requests = useRef(new Map<string, string>());
  return <T extends object,>(args: T): T & { p_request_id: string } => {
    const key = JSON.stringify(args);
    if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
    return { ...args, p_request_id: requests.current.get(key)! };
  };
}
export function useV5Action() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError(receivingError(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  return { busy, error, run, setError };
}
export function ActionError({ message }: { message: string }) {
  return message ? <p role="alert" className="break-words rounded-lg bg-danger/10 p-3 text-sm text-danger">{message}</p> : null;
}

function useSerialDraft(data: ReceivingSnapshot, api: ReceivingV5Api, preferred?: PendingRow, capacity = Infinity, planning = false) {
  const [drafts, setDrafts] = useState<ArrivalSerialDraft[]>([]);
  const [resolving, setResolving] = useState(0);
  const current = useRef(drafts);
  const queue = useRef(Promise.resolve());
  const update = (next: ArrivalSerialDraft[]) => { current.current = next; setDrafts(next); };
  const accept = (raw: string): Promise<string> => {
    setResolving(n => n + 1);
    const task = queue.current.then(async () => {
      if (current.current.some(d => serialsAlias(d.raw, raw)) || (planning && preferred?.observations.some(e => serialsAlias(e.normalized_serial, raw)))) return '已在本批清單';
      if (current.current.length + (planning ? preferred?.observations.length || 0 : 0) >= capacity) throw new Error('已達預計數量，請先調整數量。');
      const value = resolveArrivalSerial(raw, await api.lookup(raw), data.observations, data.items, preferred);
      if (planning && value.state === 'conflict') throw new Error('序號身份待確認，請先核對後再預登。');
      if (current.current.some(d => serialsAlias(d.raw, value.raw))) return '已在本批清單';
      update([...current.current, value]);
      return `已加入 ${value.raw}`;
    });
    queue.current = task.then(() => {}, () => {});
    return task.finally(() => setResolving(n => n - 1));
  };
  return { drafts, accept, resolving, remove: (raw: string) => update(current.current.filter(d => d.raw !== raw)), reset: () => update([]) };
}

export function SerialInput({ draft, data, disabled, planning = false, initialScan = false, compact = false, onScanBatch }: {
  draft: ReturnType<typeof useSerialDraft>; data: ReceivingSnapshot; disabled: boolean; planning?: boolean; initialScan?: boolean; compact?: boolean;
  onScanBatch?: (codes: ScannerCode[]) => Promise<string>;
}) {
  const [mode, setMode] = useState<'manual' | 'batch' | 'scan' | null>(initialScan ? 'scan' : null);
  const [raw, setRaw] = useState('');
  const [feedback, setFeedback] = useState('');
  const [scanWarning, setScanWarning] = useState('');
  const [duplicates, setDuplicates] = useState(0);
  const accept = async (value: string) => {
    try { const text = await draft.accept(value); setFeedback(text); if (text === '已在本批清單') setDuplicates(n => n + 1); return true; }
    catch (e) { setFeedback(receivingError(e)); return false; }
  };
  const list = <ul className="max-h-48 space-y-1 overflow-y-auto text-sm" aria-label="本批序號">{draft.drafts.map(d => <li key={d.raw} className="flex min-w-0 items-start gap-2">
    <span className="min-w-0 flex-1 break-all">{d.state === 'known' ? '✓' : '!'} {d.raw} · {d.state === 'conflict' ? '序號待確認' : d.itemId ? itemLabel(data.items.find(i => i.id === d.itemId)) : '待補品項'}</span>
    {mode !== 'scan' && <button type="button" className={v5Button} disabled={disabled || Boolean(draft.resolving)} aria-label={`移除 ${d.raw}`} onClick={() => draft.remove(d.raw)}>移除</button>}
  </li>)}</ul>;
  return <div className="min-w-0 space-y-2">
    <div className="flex flex-wrap gap-2">{(['scan', 'batch', 'manual'] as const).map(m => <button key={m} type="button" className={v5Button} disabled={disabled || Boolean(draft.resolving)} onClick={() => { setMode(m); setRaw(''); }}>{m === 'scan' ? planning ? '掃碼預登' : '連續掃碼' : m === 'batch' ? '批次輸入' : planning ? '預登序號' : '手動輸入'}</button>)}</div>
    {(mode === 'manual' || mode === 'batch') && <div className="space-y-2 rounded-lg border border-theme-border p-3">
      <label className="block text-sm">{mode === 'manual' ? '序號' : '序號（換行、逗號或 Excel 貼上）'}<textarea aria-label={mode === 'manual' ? '手動序號' : '批次序號'} rows={mode === 'manual' ? 1 : 4} className={v5Field} value={raw} disabled={disabled || Boolean(draft.resolving)} onChange={e => setRaw(e.target.value)} /></label>
      <button type="button" className={v5Button} disabled={disabled || Boolean(draft.resolving) || !raw.trim()} onClick={async () => {
        const rejected: string[] = [];
        for (const serial of parseSerialBatch(raw)) if (!await accept(serial)) rejected.push(serial);
        setRaw(rejected.join('\n'));
      }}>加入本批</button>
    </div>}
    <p role="status" className="text-sm">已加入 {draft.drafts.length} 筆 · 可辨識 {draft.drafts.filter(d => d.state === 'known').length} · 待補資料 {draft.drafts.filter(d => d.state !== 'known').length} · 重複 {duplicates}</p>
    {compact && mode !== 'scan' ? draft.drafts.length > 0 && <details><summary className="cursor-pointer py-2 text-sm">查看序號（{draft.drafts.length}）</summary>{list}</details> : list}{feedback && <p role="status" className="break-all text-sm">{feedback}</p>}
    {Boolean(draft.resolving) && <p role="status" className="text-sm">正在確認序號…</p>}
    {mode === 'scan' && <BarcodeScanner mode="continuous" items={onScanBatch ? data.items : undefined} warning={onScanBatch ? scanWarning : undefined} onBatch={onScanBatch ? codes => onScanBatch(codes).then(text => { setFeedback(text); setScanWarning(''); }).catch(e => { setFeedback(receivingError(e)); setScanWarning('確認失敗，請重新掃描。'); throw e; }) : undefined} onDetected={value => { void accept(value); }} onCancel={() => setMode(null)} onFinish={() => setMode(null)}>
      <p className="font-semibold">本批 {draft.drafts.length}</p><p role="status" className="break-all">{feedback}</p>{list}
    </BarcodeScanner>}
  </div>;
}

export function PendingForm({ data: initialData, api, row, onClose, onSaved, embedded = false, compact = false }: {
  data: ReceivingSnapshot; api: ReceivingV5Api; row?: PendingRow; onClose: () => void; onSaved: (id: string) => Promise<void>; embedded?: boolean; compact?: boolean;
}) {
  const { data, createItem } = useReceivingItems(initialData, api);
  const [itemId, setItemId] = useState(row?.itemId || '');
  const [quantity, setQuantity] = useState(String(row?.fulfilment.expected || 1));
  const [projectId, setProjectId] = useState(row?.projectId || '');
  const [expectedAt, setExpectedAt] = useState<string | null>(row?.expectedAt || null);
  const [notes, setNotes] = useState(row?.notes || '');
  const action = useV5Action(); const request = useV5Request();
  const item = data.items.find(i => i.id === itemId);
  const context = { ...row, itemId, observations: row?.observations || [] } as PendingRow;
  const draft = useSerialDraft(data, api, context, Number(quantity), true);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (event.currentTarget.querySelector('[aria-invalid="true"]')) { action.setError('請先修正預計到貨日期或時間。'); return; } void action.run(async () => {
    if (!item || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 || (item.requires_serial && !Number.isInteger(Number(quantity)))) throw new Error('請選擇品項並填寫有效數量。');
    if (Number(quantity) < (row?.fulfilment.fulfilled || 0) || Number(quantity) < draft.drafts.length + (row?.observations.length || 0)) throw new Error('數量不可少於已收到或已預登序號數量。');
    if (row) {
      await api.updatePending(row, { itemId, quantity: Number(quantity), projectId: projectId || null, expectedAt, notes: notes.trim() || null }, item);
      await onSaved(row.id);
    } else {
      const created = await api.createPending(request({ p_item_id: itemId, p_quantity: Number(quantity), p_expected_at: expectedAt, p_project_id: projectId || null, p_notes: notes.trim() || null, p_serials: draft.drafts.map(d => d.raw) }));
      await onSaved(created.id);
    }
  }); };
  const quantityField = <label className="min-w-0 text-sm">數量<input type="number" required min={item?.requires_serial ? 1 : 0.001} step={item?.requires_serial ? 1 : 'any'} className={v5Field} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>;
  const expectedField = <div className={'space-y-2 ' + (compact ? pendingCompactStyles.dateField : '')}><label className="text-sm">預計到貨<select aria-label="預計到貨方式" className={v5Field} value={expectedAt ? 'date' : 'unset'} onChange={e => setExpectedAt(e.target.value === 'date' ? new Date().toISOString() : null)}><option value="unset">{row?.kind === 'PROJECT_MATERIAL' && !row.sameDay ? '沿用批次時間／未定' : '未定'}</option><option value="date">日期</option></select></label>{expectedAt && <ReceiptDateTimeInput label="預計到貨" value={expectedAt} onChange={setExpectedAt} />}{row?.sameDay && <p className="text-sm text-secondary">此批同日到貨，預計時間會套用整批。</p>}</div>;
  return <form onSubmit={submit} aria-label={embedded ? row ? '修改預計' : '預計收貨' : row ? '修改待收' : '新增北辦待收'} className={(embedded ? 'min-w-0 space-y-3' : 'min-w-0 space-y-3 rounded-xl border border-accent/40 bg-page/50 p-3') + (compact ? ' ' + pendingCompactStyles.form : '')}>
    {!embedded && <h3 className="font-bold">{row ? '修改待收' : '新增北辦待收'}</h3>}
    <fieldset disabled={action.busy || Boolean(draft.resolving)} className="min-w-0 space-y-3">
      <InventoryItemCombobox items={data.items.filter(i => i.is_active || i.id === row?.itemId)} value={itemId} onCreate={createItem} disabled={Boolean(row && (row.kind === 'SE_SUPPLY' || row.fulfilment.fulfilled || row.observations.length))} onChange={id => { setItemId(id); draft.reset(); }} />
      {compact ? <div className={pendingCompactStyles.detailsGrid}>{quantityField}<label className="min-w-0 text-sm">單位<input aria-label="單位" readOnly className={v5Field + ' text-secondary'} value={item?.unit || '—'} /></label>{expectedField}</div> : <><div className="grid grid-cols-2 gap-3">{quantityField}<div className="text-sm">單位<p className="py-3">{item?.unit || '—'}</p></div></div>{expectedField}</>}
      <ReceivingProjectCombobox projects={selectActiveProjects(data.projects)} value={projectId} onChange={setProjectId} disabled={Boolean(row && (row.kind === 'PROJECT_MATERIAL' || row.fulfilment.fulfilled))} />
      <label className="block text-sm">備註（選填）<textarea rows={2} className={v5Field + (compact ? ' ' + pendingCompactStyles.notes : '')} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      {item?.requires_serial && !row && <><p className="text-sm">預登序號 {draft.drafts.length} / {quantity}（選填）</p><SerialInput draft={draft} data={data} planning compact={embedded} disabled={action.busy} /></>}
    </fieldset>
    <ActionError message={action.error} />
    <div className="flex flex-wrap gap-2"><button type="button" disabled={action.busy || Boolean(draft.resolving)} className={v5Button} onClick={onClose}>取消</button><button className={v5Primary} disabled={action.busy || Boolean(draft.resolving) || !item}>{action.busy ? '儲存中…' : embedded ? row ? '儲存預計' : '建立預計收貨' : row ? '儲存待收' : '建立待收'}</button></div>
  </form>;
}

export function PendingSerialEditor({ row, data, api, scan, onSaved, onClose }: {
  row: PendingRow; data: ReceivingSnapshot; api: ReceivingV5Api; scan: boolean; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const draft = useSerialDraft(data, api, row, row.fulfilment.expected, true);
  const action = useV5Action();
  return <section className="space-y-3 rounded-lg border border-theme-border p-3" aria-label="預登序號">
    <SerialInput draft={draft} data={data} planning initialScan={scan} disabled={action.busy} />
    <ActionError message={action.error} />
    <div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={action.busy || Boolean(draft.resolving)} onClick={onClose}>取消預登</button><button type="button" className={v5Primary} disabled={action.busy || Boolean(draft.resolving) || !draft.drafts.length} onClick={() => void action.run(async () => {
      // Registration is idempotent per source/identity. A retry safely resumes a partially saved batch.
      for (const d of draft.drafts) await api.register(row, d.raw);
      await onSaved(); onClose();
    })}>儲存待收序號</button></div>
  </section>;
}

export function ActualArrivalComposer({ data, api, preferred, onClose, onSaved }: {
  data: ReceivingSnapshot; api: ReceivingV5Api; preferred?: PendingRow; onClose: () => void; onSaved: (result: CreateArrivalResult) => Promise<void>;
}) {
  const preferredItem = data.items.find(i => i.id === preferred?.itemId);
  const [mode, setMode] = useState<'serial' | 'plain' | null>(preferredItem ? preferredItem.requires_serial ? 'serial' : 'plain' : null);
  const [itemId, setItemId] = useState(preferredItem?.id || '');
  const [quantity, setQuantity] = useState('1');
  const [at, setAt] = useState<string | null>(new Date().toISOString());
  const [adjustTime, setAdjustTime] = useState(false);
  const [timeChanged, setTimeChanged] = useState(false);
  const draft = useSerialDraft(data, api, preferred);
  const action = useV5Action(); const request = useV5Request();
  const item = data.items.find(i => i.id === itemId && !i.requires_serial);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (event.currentTarget.querySelector('[aria-invalid="true"]')) { action.setError('請先修正實際到貨日期或時間。'); return; } void action.run(async () => {
    if (!at) throw new Error('請確認到貨時間。');
    const lines = mode === 'serial' ? serialDraftLines(draft.drafts) : item && Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? [{ inventory_item_id: item.id, quantity: Number(quantity), unit: item.unit }] : [];
    if (!lines.length) throw new Error('請加入序號，或選擇品項並填寫有效數量。');
    const matches = preferred ? lines.flatMap((line, index) => line.inventory_item_id === preferred.itemId ? [{ ...sourceFields(preferred), line_index: index, quantity: line.quantity, raw_serials: 'raw_serials' in line ? line.raw_serials : [] }] : []) : [];
    if (preferred && matches.reduce((n, m) => n + m.quantity, 0) > preferred.fulfilment.remaining) throw new Error('本次對應超過待收剩餘數量，請調整本批。');
    const result = await api.create(request({ p_actual_received_at: at, p_lines: lines, p_project_id: preferred?.projectId || null, p_matches: matches }));
    await onSaved(result);
  }); };
  return <form aria-label="新增到貨" onSubmit={submit} className="min-w-0 space-y-3 rounded-xl border border-accent/40 bg-page/50 p-3">
    <h3 className="font-bold">新增到貨</h3>
    {preferred && <p className="break-words text-sm">對應待收：{preferred.label} · 剩餘 {preferred.fulfilment.remaining} {preferred.unit}。完成時對應本批可入庫數量。</p>}
    <fieldset disabled={action.busy} className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2"><button type="button" className={mode === 'serial' ? v5Primary : v5Button} disabled={Boolean(draft.resolving)} aria-pressed={mode === 'serial'} onClick={() => setMode('serial')}>有序號設備</button><button type="button" className={mode === 'plain' ? v5Primary : v5Button} disabled={Boolean(draft.resolving) || Boolean(draft.drafts.length)} aria-pressed={mode === 'plain'} onClick={() => setMode('plain')}>無序號物料</button></div>
      {mode === 'serial' && <SerialInput draft={draft} data={data} disabled={action.busy} />}
      {mode === 'plain' && <><InventoryItemCombobox items={data.items.filter(i => i.is_active && !i.requires_serial)} value={itemId} onChange={setItemId} /><div className="grid grid-cols-2 gap-3"><label className="min-w-0 text-sm">實收數量<input required type="number" min="0.001" step="any" className={v5Field} value={quantity} onChange={e => setQuantity(e.target.value)} /></label><div className="text-sm">單位<p className="py-3">{item?.unit || '—'}</p></div></div></>}
      {mode && <div className="space-y-2"><div className="flex flex-wrap items-center gap-2"><span className="text-sm">到貨時間：{timeChanged ? formatTaipeiReceivingTime(at) : '現在'}</span><button type="button" className={v5Button} onClick={() => setAdjustTime(value => !value)}>調整時間</button></div>{adjustTime && <ReceiptDateTimeInput label="實際到貨" value={at} onChange={value => { setAt(value); setTimeChanged(true); }} required />}</div>}
    </fieldset>
    <ActionError message={action.error} />
    <div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={action.busy || Boolean(draft.resolving)} onClick={onClose}>取消</button>{mode && <button className={v5Primary} disabled={action.busy || Boolean(draft.resolving) || (mode === 'serial' ? !draft.drafts.length : !item)}>{action.busy ? '儲存中…' : '完成實際到貨'}</button>}</div>
  </form>;
}
