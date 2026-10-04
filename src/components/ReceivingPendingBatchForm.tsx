'use client';

import { useRef, useState, type FormEvent } from 'react';
import type { ReceivingV6Api } from '@/lib/db/receiving-v6';
import { classifySerialFormat, normalizeSerialInput } from '@/lib/inventory-serial-normalization';
import { receivingError, resolveArrivalSerial, serialsAlias, type PendingRow, type ReceivingSnapshot } from '@/lib/receiving-v5';
import { selectReceivingProjects } from '@/lib/project-selectors';
import { BarcodeScanner } from './BarcodeScanner';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';
import { useReceivingItems } from './useReceivingItems';
import { ActionError, useV5Action, useV5Request, v5Button, v5Field, v5Primary } from './ReceivingV5Forms';

type Draft = { key: string; itemId: string; quantity: string; expectedDate: string; serials: string[]; manual: string };
const taipeiToday = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const freshDraft = (): Draft => ({ key: crypto.randomUUID(), itemId: '', quantity: '1', expectedDate: taipeiToday(), serials: [], manual: '' });

export function ReceivingPendingBatchForm({ data: initialData, api, onClose, onSaved }: {
  data: ReceivingSnapshot; api: ReceivingV6Api; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { data, createItem } = useReceivingItems(initialData, api);
  const [projectId, setProjectId] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Draft[]>([freshDraft()]);
  const [scanKey, setScanKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [serialError, setSerialError] = useState('');
  const rowsRef = useRef(rows);
  const action = useV5Action(), request = useV5Request();
  const update = (next: Draft[]) => { rowsRef.current = next; setRows(next); };
  const change = (key: string, patch: Partial<Draft>) => update(rowsRef.current.map(row => row.key === key ? { ...row, ...patch } : row));
  const addSerial = async (key: string, input: string) => {
    const raw = normalizeSerialInput(input);
    const row = rowsRef.current.find(value => value.key === key);
    const item = data.items.find(value => value.id === row?.itemId);
    if (!row || !item?.requires_serial) throw new Error('請先選擇需要序號的品項。');
    if (classifySerialFormat(raw) === 'unknown') throw new Error('序號格式無法辨識。');
    if (rowsRef.current.some(value => value.serials.some(serial => serialsAlias(serial, raw)))) throw new Error('此序號已在本次預計收貨中。');
    if (row.serials.length >= Number(row.quantity)) throw new Error('預登序號不可超過數量。');
    setChecking(true);
    try {
      const lookup = await api.lookup(raw);
      const resolved = resolveArrivalSerial(raw, lookup, data.observations, data.items,
        { itemId: item.id } as PendingRow);
      if (resolved.state === 'conflict') throw new Error('序號已有其他品項或庫存關聯。');
      const latest = rowsRef.current.find(value => value.key === key);
      if (!latest || latest.itemId !== item.id || rowsRef.current.some(value => value.serials.some(serial => serialsAlias(serial, raw))))
        throw new Error('品項或序號已變更，請重新確認。');
      update(rowsRef.current.map(value => value.key === key
        ? { ...value, serials: [...value.serials, resolved.raw], manual: '' } : value));
      setSerialError('');
    } finally { setChecking(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void action.run(async () => {
      const items = rowsRef.current.map(row => {
        const item = data.items.find(value => value.id === row.itemId && value.is_active);
        const quantity = Number(row.quantity);
        if (!item || !Number.isFinite(quantity) || quantity <= 0 || item.requires_serial && !Number.isInteger(quantity)
          || !row.expectedDate || Number.isNaN(Date.parse(`${row.expectedDate}T00:00:00+08:00`))
          || row.serials.length > quantity || !item.requires_serial && row.serials.length)
          throw new Error('請確認每筆品項、數量、日期與預登序號。');
        return { item_id: item.id, quantity, expected_at: `${row.expectedDate}T00:00:00+08:00`, serials: row.serials };
      });
      if (!items.length) throw new Error('請新增至少一個品項。');
      await api.createPendingBatch(request({ p_project_id: projectId || null, p_notes: notes.trim() || null, p_items: items }));
      await onSaved();
    });
  };
  return <form aria-label="預計收貨" className="space-y-3" onSubmit={submit}>
    <fieldset disabled={action.busy || checking} className="space-y-3">
      <ReceivingProjectCombobox projects={selectReceivingProjects(data.projects)} value={projectId} onChange={setProjectId} />
      <div className="divide-y divide-theme-border rounded-lg border border-theme-border">
        {rows.map((row, index) => {
          const item = data.items.find(value => value.id === row.itemId);
          const today = taipeiToday(), tomorrow = nextDay(today);
          return <section key={row.key} className="space-y-2 p-3" aria-label={`品項 ${index + 1}`}>
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">品項 {index + 1}</h3>{rows.length > 1 && <button type="button" className="text-xs text-danger" onClick={() => update(rowsRef.current.filter(value => value.key !== row.key))}>移除</button>}</div>
            <InventoryItemCombobox items={data.items.filter(value => value.is_active)} value={row.itemId} onCreate={createItem}
              onChange={itemId => change(row.key, { itemId, serials: [] })} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[7rem_1fr]">
              <label className="text-sm">數量<input type="number" required min={item?.requires_serial ? 1 : 0.001}
                step={item?.requires_serial ? 1 : 'any'} className={v5Field} value={row.quantity}
                onChange={e => change(row.key, { quantity: e.target.value })} /></label>
              <div className="text-sm"><span>預計到貨</span><div className="mt-1 flex flex-wrap items-center gap-1">
                <button type="button" aria-pressed={row.expectedDate === today} className={v5Button + ' min-h-9 py-1'} onClick={() => change(row.key, { expectedDate: today })}>今天</button>
                <button type="button" aria-pressed={row.expectedDate === tomorrow} className={v5Button + ' min-h-9 py-1'} onClick={() => change(row.key, { expectedDate: tomorrow })}>明天</button>
                <input type="date" aria-label={`品項 ${index + 1} 預計到貨日期`} required className="min-h-9 min-w-0 rounded-lg border border-theme-border bg-page px-2 text-sm"
                  value={row.expectedDate} onChange={e => change(row.key, { expectedDate: e.target.value })} />
                <span className="text-xs text-secondary">{row.expectedDate.slice(5).replace('-', '/')}</span>
              </div></div>
            </div>
            {item?.requires_serial && <details><summary className="cursor-pointer py-1 text-sm text-accent">預登序號 {row.serials.length} / {row.quantity || 0}</summary>
              <div className="space-y-2 pt-1"><div className="flex flex-wrap gap-2"><button type="button" className={v5Button} onClick={() => setScanKey(row.key)}>掃碼預登</button>
                <label className="flex min-w-0 flex-1 gap-1"><span className="sr-only">手動新增序號</span><input className={v5Field + ' mt-0'} placeholder="輸入單一序號" value={row.manual}
                  onChange={e => change(row.key, { manual: e.target.value })} /><button type="button" className={v5Button} disabled={!row.manual.trim()}
                    onClick={() => void addSerial(row.key, row.manual).catch(error => setSerialError(receivingError(error)))}>手動新增</button></label></div>
                <ul className="max-h-40 overflow-y-auto text-xs">{row.serials.map(serial => <li key={serial} className="flex items-center justify-between gap-2 py-1"><span className="break-all">{serial}</span><button type="button" className="min-h-9 text-danger" onClick={() => change(row.key, { serials: row.serials.filter(value => value !== serial) })}>移除</button></li>)}</ul>
              </div></details>}
          </section>;
        })}
      </div>
      <button type="button" className={v5Button} onClick={() => update([...rowsRef.current, freshDraft()])}>＋新增品項</button>
      <label className="block text-sm">備註<textarea rows={2} className={v5Field} value={notes} onChange={e => setNotes(e.target.value)} /></label>
    </fieldset>
    <ActionError message={serialError || action.error} />
    <div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={action.busy} onClick={onClose}>取消</button><button type="submit" className={v5Primary} disabled={action.busy || checking}>{action.busy ? '建立中…' : '建立預計收貨'}</button></div>
    {scanKey && <BarcodeScanner mode="continuous" onDetected={raw => { void addSerial(scanKey, raw).catch(error => setSerialError(receivingError(error))); }}
      onCancel={() => setScanKey(null)} onFinish={() => setScanKey(null)}><p>預登序號 · 品項 {rows.findIndex(row => row.key === scanKey) + 1}</p></BarcodeScanner>}
  </form>;
}
