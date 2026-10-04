'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { InventoryItemCombobox, ReceivingSerialControls, useReceivingDraft } from './ReceivingSerialControls';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';
import { resolveReceivingSerial } from '@/lib/receiving-serial-draft';
import { dbAdapter } from '@/lib/db';
import { supabase } from '@/lib/db/supabaseClient';
import type { InventoryItem, InventorySerial, Project, ProjectMaterial, SESupplyRecord } from '@/lib/db/types';
import { createReceivingApi, isActiveSEReservation, ReceivingSerialEntry } from '@/lib/db/receiving-routing';
import { selectReceivingProjects } from '@/lib/project-selectors';
import type { PendingReceivingItem } from '@/lib/material-receiving';

const api = createReceivingApi(supabase);
const field = 'mt-1 min-h-10 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary';
const button = 'min-h-10 rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold disabled:opacity-40';
const message = (error: unknown) => error instanceof Error ? error.message : '操作失敗，請重新確認';
export function useRequest() {
  const previous = useRef<{ key: string; id: string }>();
  return (payload: Record<string, unknown>) => {
    const key = JSON.stringify(payload);
    if (previous.current?.key !== key) previous.current = { key, id: crypto.randomUUID() };
    return { ...payload, p_request_id: previous.current.id };
  };
}
export function ReceivingFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label={title}>
    <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-theme-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="mb-4 flex items-center justify-between gap-2"><h3 className="font-bold">{title}</h3><button type="button" className={button} aria-label="關閉" onClick={onClose}><X size={20} /></button></div>{children}
    </div>
  </div>;
}

export function OfficeArrivalDialog({ projects, onClose, onCreated }: { projects: Project[]; onClose: () => void; onCreated: (record: SESupplyRecord) => void | Promise<void> }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [projectId, setProjectId] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const request = useRequest();
  useEffect(() => { let active = true; Promise.all([dbAdapter.getInventoryItems(), dbAdapter.getInventorySerials()]).then(([rows, identities]) => { if (active) { setItems(rows.filter(i => i.is_active)); setSerials(identities); } }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, []);
  const item = items.find(i => i.id === itemId);
  const draft = useReceivingDraft({ item: item || { id: '', requires_serial: false }, serials, entries: [], capacity: Number(quantity) });
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!item || saving) return;
    setError(''); setSaving(true);
    try {
      const amount = Number(quantity);
      if (!Number.isFinite(amount) || amount <= 0 || (item.requires_serial && !Number.isInteger(amount))) throw new Error('請確認數量');
      if (draft.drafts.length > amount) throw new Error('已登序號不可超過需求數量');
      const created = await api.createArrival(request({ p_item_id: item.id, p_quantity: amount, p_expected_at: expected ? new Date(expected).toISOString() : null, p_project_id: projectId || null, p_notes: notes || null, p_serials: item.requires_serial ? draft.drafts.map(d => d.canonical) : [] }));
      await onCreated(created);
    } catch (e) { setError(message(e)); } finally { setSaving(false); }
  }
  return <ReceivingFrame title="新增北辦待收" onClose={onClose}><form onSubmit={submit} className="space-y-3">
    <fieldset disabled={saving} className="space-y-3">
    <InventoryItemCombobox items={items} value={itemId} onChange={id => { setItemId(id); draft.reset(); setError(''); }} />
    <div className="grid grid-cols-2 gap-3"><label className="text-sm">數量<input required type="number" min={item?.requires_serial ? 1 : 0.001} step={item?.requires_serial ? 1 : 'any'} value={quantity} onChange={e => setQuantity(e.target.value)} className={field} /></label><label className="text-sm">單位<input readOnly value={item?.unit || ''} className={field} /></label></div>
    {item?.requires_serial && <section aria-label="到貨序號" className="space-y-2 rounded-lg border border-theme-border p-3">
      <ReceivingSerialControls context={draft.context} onAccept={draft.accept} itemLabel={item.code} disabled={saving} label={`序號 已登 ${draft.drafts.length} / ${quantity}`} />
      <ul className="max-h-40 overflow-y-auto">{draft.drafts.map(d => <li key={d.key} className="flex items-center gap-2 py-1 text-sm"><span className="min-w-0 flex-1 break-all">{d.canonical}</span><button type="button" className={button} onClick={() => draft.remove(d.key)} aria-label={`移除 ${d.canonical}`}>移除</button></li>)}</ul>
      {draft.drafts.length > Number(quantity) && <p role="alert" className="text-sm text-danger">已登序號不可超過需求數量，請調整數量或移除序號</p>}
    </section>}
    <label className="block text-sm">預計到貨<input type="datetime-local" value={expected} onChange={e => setExpected(e.target.value)} className={field} /></label>
    <ReceivingProjectCombobox projects={projects} value={projectId} onChange={setProjectId} disabled={saving} />
    <label className="block text-sm">備註<input className={field} value={notes} onChange={e => setNotes(e.target.value)} /></label>
    </fieldset>
    <p className="text-xs text-secondary">新增後維持待收；收到時才入庫。</p>{error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <button disabled={saving || !item || draft.drafts.length > Number(quantity)} className={`${button} w-full bg-accent text-white`}>{saving ? '儲存中…' : '建立待收'}</button>
  </form></ReceivingFrame>;
}

export function ReceivingDetailDialog({ item, onClose, onChanged, inline = false }: { item: PendingReceivingItem; onClose: () => void; onChanged: () => void | Promise<void>; inline?: boolean }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [entries, setEntries] = useState<ReceivingSerialEntry[]>([]);
  const [itemId, setItemId] = useState('');
  const [sourceItemId, setSourceItemId] = useState('');
  const [mode, setMode] = useState<'detail' | 'supplement' | 'receive'>(inline ? 'receive' : 'detail');
  const [startWith, setStartWith] = useState<'manual' | 'batch' | 'scan'>('manual');
  const [quantity, setQuantity] = useState(String(item.remainingQuantity));
  const [receivedAt] = useState(() => new Date().toISOString());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const request = useRequest();
  useEffect(() => {
    let active = true;
    Promise.all([dbAdapter.getInventoryItems(), dbAdapter.getInventorySerials(), api.entries(item.sourceType, item.sourceId), api.sourceItem(item.sourceType, item.sourceId)])
      .then(([rows, identities, pending, sourceItem]) => { if (!active) return; setItems(rows.filter(i => i.is_active && i.unit === item.unit)); setSerials(identities); setEntries(pending); setItemId(sourceItem || ''); setSourceItemId(sourceItem || ''); setLoaded(true); })
      .catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [item.sourceType, item.sourceId, item.unit]);
  const inventoryItem = items.find(i => i.id === itemId);
  const draft = useReceivingDraft({ item: inventoryItem || { id: '', requires_serial: false }, serials, entries, capacity: mode === 'receive' ? item.remainingQuantity : item.quantity, receiving: mode === 'receive' });
  async function retire(entry: ReceivingSerialEntry) {
    if (busy) return; setBusy(true); setError('');
    try { await api.retireEntry(entry); setEntries(await api.entries(item.sourceType, item.sourceId)); draft.deselect(entry.id); await onChanged(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function savePending() {
    if (busy) return; setBusy(true); setError('');
    try {
      for (const d of draft.drafts) {
        await api.registerRaw(item.sourceType, item.sourceId, itemId, d.canonical);
        draft.remove(d.key);
      }
      setEntries(await api.entries(item.sourceType, item.sourceId));
      setMode(inline ? 'receive' : 'detail');
      await onChanged();
    } catch (e) {
      setError(message(e));
      try { setEntries(await api.entries(item.sourceType, item.sourceId)); } catch { /* Preserve the original save error. */ }
    } finally { setBusy(false); }
  }
  async function receive() {
    if (!inventoryItem || busy) return;
    setBusy(true); setError('');
    try {
      const amount = inventoryItem.requires_serial ? draft.selected.length : Number(quantity);
      if (!Number.isFinite(amount) || amount <= 0 || amount > item.remainingQuantity) throw new Error('請確認本次收到數量');
      const ids: string[] = [];
      if (inventoryItem.requires_serial) {
        // Materialize only selected local drafts, on explicit final confirmation.
        // The existing RPC remains responsible for atomic CREATE / IN / RECEIVE and race checks.
        for (const key of draft.selected) {
          const entry = entries.find(e => e.id === key);
          if (entry) { ids.push(entry.id); continue; }
          const d = draft.drafts.find(value => value.key === key);
          if (!d) throw new Error('缺少序號，請重新選取');
          const registered = await api.registerRaw(item.sourceType, item.sourceId, itemId, d.canonical);
          ids.push(registered.id);
        }
      }
      await api.receive(request({ p_source_type: item.sourceType, p_source_id: item.sourceId, p_item_id: itemId, p_quantity: amount, p_entry_ids: ids, p_received_at: receivedAt, p_notes: null }));
      await onChanged();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const beginSupplement = (start: 'manual' | 'batch' | 'scan') => { draft.clearSelection(); setStartWith(start); setMode('supplement'); setError(''); };
  const Frame = inline ? ReceivingInlineFrame : ReceivingFrame;
  return <Frame title={item.itemLabel} onClose={onClose}>
    <p className="mb-3 text-sm">需求：{item.quantity} · 已收：{item.receivedQuantity} · 待收：{item.remainingQuantity}</p>
    {!loaded && !error && <p role="status">載入中…</p>}
    {loaded && item.remainingQuantity > 0 && <InventoryItemCombobox items={items} value={itemId} disabled={Boolean(sourceItemId) || entries.length > 0 || busy} onChange={id => { setItemId(id); draft.reset(); setMode(inline ? 'receive' : 'detail'); }} />}
    {inventoryItem?.requires_serial && <>
      <p className="my-3 text-sm font-semibold">序號 已登 {entries.length + draft.drafts.length} / {item.quantity}</p>
      {(mode === 'detail' || inline) && item.remainingQuantity > 0 && <div className="flex flex-wrap gap-2"><button className={button} onClick={() => beginSupplement('manual')}>補序號</button><button className={button} onClick={() => beginSupplement('scan')}>連續掃碼</button><button className={button} onClick={() => beginSupplement('batch')}>批次輸入</button></div>}
      {mode !== 'detail' && <ReceivingSerialControls key={mode + startWith} context={draft.context} onAccept={draft.accept} itemLabel={inventoryItem.code} disabled={busy} startWith={mode === 'supplement' ? startWith : undefined}
        label={mode === 'receive' ? `已選 ${draft.selected.length} / ${item.remainingQuantity} · 本次收到：${draft.selected.length} ${item.unit}` : `序號 已登 ${entries.length + draft.drafts.length} / ${item.quantity}`}
        scannerLabel={mode === 'receive' ? '掃描到貨序號' : '連續掃碼'} manualLabel={mode === 'receive' ? '手動輸入' : '手動新增'} />}
      <div className="my-3 max-h-64 space-y-2 overflow-y-auto">{entries.map(entry => {
        const result = resolveReceivingSerial(entry.raw_serial, { ...draft.context, receiving: true, capacity: item.quantity, selected: [] });
        const invalid = result.status !== 'valid';
        const existing = serials.find(s => s.id === (result.status === 'valid' ? result.value.inventorySerialId : entry.inventory_serial_id));
        return <div key={entry.id} className="flex items-start gap-3 rounded-lg border border-theme-border p-3 text-sm">
          <label className="flex min-w-0 flex-1 gap-3">
          {mode === 'receive' && <input type="checkbox" className="mt-1 h-5 w-5" disabled={busy || invalid} checked={draft.selected.includes(entry.id)} onChange={e => { if (!e.target.checked) draft.deselect(entry.id); else { const r = draft.accept(entry.raw_serial); if (r.status !== 'valid') setError(r.message); } }} />}
          <span className="min-w-0 break-all">{entry.raw_serial}<span className={`block text-xs ${invalid && !entry.active_receipt_id ? 'text-danger' : 'text-secondary'}`}>{entry.active_receipt_id ? '✓ 已入庫' : invalid ? result.message : existing ? '系統已有 · 在庫' : '待收 · 尚未建立庫存序號'}</span></span>
          </label>{mode === 'supplement' && !entry.active_receipt_id && <button type="button" className="min-h-11 shrink-0 text-xs text-secondary" disabled={busy} onClick={() => void retire(entry)}>移除</button>}
        </div>;
      })}
      {draft.drafts.map(d => <div key={d.key} className="flex items-center gap-2 rounded-lg border border-theme-border p-3 text-sm"><label className="flex min-w-0 flex-1 gap-3">{mode === 'receive' && <input type="checkbox" disabled={busy} checked={draft.selected.includes(d.key)} onChange={e => { if (!e.target.checked) draft.deselect(d.key); else { const r = draft.accept(d.raw); if (r.status !== 'valid') setError(r.message); } }} />}<span className="break-all">{d.canonical}<span className="block text-xs text-secondary">尚未儲存</span></span></label><button type="button" className={button} disabled={busy} onClick={() => draft.remove(d.key)}>移除</button></div>)}</div>
      {mode === 'supplement' && <button className={button} disabled={busy || !draft.drafts.length} onClick={() => void savePending()}>{busy ? '儲存中…' : '儲存待收序號'}</button>}
    </>}
    {item.remainingQuantity > 0 && inventoryItem && <>
      {mode === 'detail' && <button className={`${button} mt-3 w-full bg-accent text-white`} disabled={busy || !loaded} onClick={() => { draft.clearSelection(); setMode('receive'); setError(''); }}>確認收到</button>}
      {mode === 'receive' && <>
        {!inventoryItem.requires_serial && <label className="my-3 block text-sm">本次收到<input className={field} type="number" min="0.001" step="any" max={item.remainingQuantity} value={quantity} onChange={e => setQuantity(e.target.value)} disabled={busy} /></label>}
        <button className={`${button} mt-3 w-full bg-accent text-white`} disabled={busy || (inventoryItem.requires_serial && !draft.selected.length)} onClick={() => void receive()}>{busy ? '處理中…' : `確認收到${inventoryItem.requires_serial ? ` ${draft.selected.length} ${item.unit}` : ''}`}</button>
      </>}
      {mode !== 'detail' && (!inline || mode === 'supplement') && <button className={`${button} mt-2 w-full`} disabled={busy} onClick={() => { draft.clearSelection(); setMode(inline ? 'receive' : 'detail'); }}>返回待收明細</button>}
    </>}
    {!inline && item.receivedQuantity > 0 && itemId && <div className="mt-4"><InventoryRoutingPanel itemId={itemId} onChanged={onChanged} /></div>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </Frame>;
}

function ReceivingInlineFrame({ children }: { title: string; onClose: () => void; children: ReactNode }) { return <section aria-label="本次收貨" className="space-y-2">{children}</section>; }

export function InventoryRoutingPanel({ itemId, onChanged }: { itemId: string; onChanged: () => void | Promise<void> }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [serials, setSerials] = useState<InventorySerial[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [reserved, setReserved] = useState<SESupplyRecord[]>([]);
  const [materials, setMaterials] = useState<ProjectMaterial[]>([]);
  const [mode, setMode] = useState<'SE' | 'SITE' | null>(null);
  const [projectId, setProjectId] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [receivedAt] = useState(() => new Date().toISOString());
  const request = useRequest();
  const refresh = useCallback(async () => {
    const [i, s, p, r] = await Promise.all([dbAdapter.getInventoryItems(), dbAdapter.getInventorySerials(), dbAdapter.getProjects(), dbAdapter.getSESupplyRecords()]);
    setItems(i); setSerials(s); setProjects(selectReceivingProjects(p)); setReserved(r.filter(isActiveSEReservation));
  }, []);
  useEffect(() => { void refresh().catch(e => setError(message(e))); }, [refresh]);
  useEffect(() => { let active = true; setMaterials([]); setMaterialId(''); if (projectId) dbAdapter.listProjectMaterials(projectId).then(rows => { if (active) setMaterials(rows); }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [projectId]);
  const item = items.find(i => i.id === itemId);
  const available = serials.filter(s => s.item_id === itemId && s.status === '在庫' && !reserved.some(r => r.inventory_serial_id === s.id));
  const candidates = useMemo(() => materials.filter(m => (m.inventory_item_id === itemId || !m.inventory_item_id && Boolean(item && [m.item_name, m.specification].some(value => value && [item.name, item.code].includes(value)))) && m.unit === item?.unit && m.delivery_destination === 'SITE' && m.procurement_status !== 'RECEIVED'), [materials, itemId, item]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!item || busy) return; setBusy(true); setError(''); setSuccess('');
    try {
      if (mode === 'SE') {
        if (selected.length !== 1) throw new Error('請選擇一台設備');
        await api.reserve(request({ p_serial_id: selected[0], p_project_id: projectId || null }));
        setSuccess('已加入 SE 供貨追蹤並預留，庫存不變');
      } else {
        if (!projectId || !materialId) throw new Error('請選擇案場與物料需求');
        await api.deliver(request({ p_item_id: itemId, p_project_id: projectId, p_quantity: item.requires_serial ? selected.length : Number(quantity), p_serial_ids: selected, p_material_id: materialId === 'NEW' ? null : materialId, p_create_new: materialId === 'NEW', p_received_at: receivedAt, p_notes: null }));
        setSuccess('已出庫，案場收貨紀錄已建立');
      }
      setMode(null); setSelected([]); await refresh(); await onChanged();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="space-y-3 border-t border-theme-border pt-3" aria-label="庫存後續用途"><p className="text-sm font-bold">庫存後續用途</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => { setMode(null); setSuccess('留在庫存'); }}>留在庫存</button>{item?.requires_serial && item.is_se_maintenance_equipment && <button type="button" className={button} onClick={() => { setMode('SE'); setSelected([]); }}>加入 SE 供貨追蹤</button>}<button type="button" className={button} onClick={() => { setMode('SITE'); setSelected([]); }}>送至案場</button></div>
    {mode && <form onSubmit={submit} className="space-y-3"><label className="block text-sm">{mode === 'SITE' ? '送達案場' : '預留案場（選填）'}<select className={field} required={mode === 'SITE'} value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">選擇案件</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {item?.requires_serial ? <fieldset><legend className="text-sm">在庫序號</legend>{available.map(s => <label key={s.id} className="flex gap-2 py-2 text-sm"><input type="checkbox" checked={selected.includes(s.id)} onChange={e => setSelected(ids => e.target.checked ? mode === 'SE' ? [s.id] : [...ids, s.id] : ids.filter(id => id !== s.id))} /><span className="break-all">{s.serial_number}</span></label>)}{!available.length && <p className="text-sm text-secondary">沒有可用序號；已預留設備請由對應維修使用。</p>}</fieldset> : <label className="block text-sm">數量<input type="number" required min="0.001" step="any" className={field} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
      {mode === 'SITE' && <><label className="block text-sm">案場物料需求<select required className={field} value={materialId} onChange={e => setMaterialId(e.target.value)}><option value="">請選擇，不自動配對</option>{candidates.map(m => <option key={m.id} value={m.id}>{m.inventory_item_id ? '' : '待確認品項 · '}{m.item_name} · {m.specification} · 需求 {m.quantity} {m.unit}</option>)}<option value="NEW">建立新的案場物料</option></select></label><p className="text-xs text-secondary">確認表示已離開北辦並送達案場。</p></>}
      <button disabled={busy || !item || Boolean(item.requires_serial && !selected.length)} className={`${button} bg-accent text-white`}>{busy ? '處理中…' : mode === 'SE' ? '確認預留' : '確認已送達'}</button>
    </form>}{success && <p role="status" className="text-sm text-success">{success}</p>}{error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </section>;
}

export function ReceivingCorrectionDialog({ receipt, onClose, onChanged }: { receipt: import('@/lib/db/types').MaterialReceipt; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [entries, setEntries] = useState<ReceivingSerialEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(String(receipt.quantity_received));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reversedAt] = useState(() => new Date().toISOString());
  const request = useRequest();
  useEffect(() => {
    let active = true;
    api.entries(receipt.source_type, (receipt.project_material_id || receipt.se_supply_record_id)!).then(rows => {
      if (!active) return;
      const current = rows.filter(row => row.active_receipt_id === receipt.id);
      setEntries(current); setSelected(current.map(row => row.id)); setLoaded(true);
    }).catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [receipt]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await api.correct(request({ p_receipt_id: receipt.id, p_quantity: entries.length ? selected.length : Number(quantity), p_entry_ids: selected, p_reversed_at: reversedAt, p_notes: notes }));
      await onChanged(); onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <ReceivingFrame title="收貨與庫存更正" onClose={onClose}><form onSubmit={submit} className="space-y-3"><p className="text-sm text-secondary">原收貨歷程保留。完整作廢入庫須符合既有 ADMIN 權限；已有後續使用或封帳時不能更正。</p>
    {entries.length ? <fieldset><legend>選擇誤收設備</legend>{entries.map(entry => <label key={entry.id} className="flex gap-2 py-2 text-sm"><input type="checkbox" checked={selected.includes(entry.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, entry.id] : ids.filter(id => id !== entry.id))} />{entry.raw_serial}</label>)}</fieldset> : <label className="block text-sm">更正數量<input required type="number" min="0.001" step="any" className={field} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
    <label className="block text-sm">更正原因<input required className={field} value={notes} onChange={e => setNotes(e.target.value)} /></label>{error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <button disabled={busy || !loaded || Boolean(entries.length && !selected.length)} className={`${button} bg-warning text-black`}>{busy ? '更正中…' : '確認更正'}</button>
  </form></ReceivingFrame>;
}
