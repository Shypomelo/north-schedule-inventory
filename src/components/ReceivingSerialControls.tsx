'use client';
import { useId, useRef, useState } from 'react';
import type { InventoryItem } from '@/lib/db/types';
import { receivingError } from '@/lib/receiving-v5';
import { BarcodeScanner } from './BarcodeScanner';
import { previewSerialBatch, resolveReceivingSerial, SerialContext, SerialDraft, SerialResult } from '@/lib/receiving-serial-draft';

const field = 'mt-1 min-h-11 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary';
const button = 'min-h-11 rounded-lg border border-theme-border px-3 py-2 text-sm font-semibold disabled:opacity-40';

export function searchInventoryItems(items: InventoryItem[], query: string) {
  const key = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return items.filter(item => !key || [item.code, item.name, item.canonical_identity_key || '']
    .some(value => value.replace(/\s+/g, ' ').toLocaleLowerCase().includes(key)));
}

export function InventoryItemCombobox({ items, value, disabled, onChange, onCreate, serialRequirement }: {
  items: InventoryItem[]; value: string; disabled?: boolean; onChange: (id: string) => void;
  onCreate?: (key: string, unit: string, requiresSerial: boolean) => Promise<InventoryItem>; serialRequirement?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [newKey, setNewKey] = useState<string | null>(null), [unit, setUnit] = useState('');
  const [requiresSerial, setRequiresSerial] = useState(serialRequirement ?? true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const selected = items.find(i => i.id === value);
  const filtered = searchInventoryItems(items, query);
  const incompatible = (item: InventoryItem) => serialRequirement !== undefined && item.requires_serial !== serialRequirement;
  const choose = (item: InventoryItem) => { if (incompatible(item)) return; onChange(item.id); setQuery(''); setOpen(false); };
  const create = async () => {
    if (!onCreate || !newKey || !unit.trim() || busy) return;
    setBusy(true); setError('');
    try { const item = await onCreate(newKey, unit.trim(), requiresSerial); choose(item); setNewKey(null); }
    catch (e) { setError(receivingError(e)); }
    finally { setBusy(false); }
  };
  return <div className="relative" aria-busy={busy} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(false); if (!newKey) setQuery(''); } }}>
    <label htmlFor={id} className="text-sm">品項／型號</label>
    <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open && !newKey} aria-controls={id + '-list'} aria-activedescendant={open && filtered[active] ? id + '-' + active : undefined} disabled={disabled || busy || Boolean(newKey)}
      className={field} autoComplete="off" placeholder="搜尋品項或型號，例如 P401"
      value={open ? query : selected ? selected.code + ' · ' + selected.name : ''}
      onFocus={() => { setOpen(true); setActive(-1); }}
      onChange={e => { setQuery(e.target.value); setActive(-1); setOpen(true); if (value) onChange(''); }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQuery(''); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(n => Math.max(0, Math.min(filtered.length - 1, n + (e.key === 'ArrowDown' ? 1 : -1)))); }
        if (e.key === 'Enter' && open) { e.preventDefault(); const candidate = active >= 0 ? filtered[active] : filtered.length === 1 ? filtered[0] : null; if (candidate) choose(candidate); }
      }} />
    {open && !newKey && <ul id={id + '-list'} role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-theme-border bg-card shadow-xl">
      {filtered.map((item, n) => <li id={id + '-' + n} key={item.id} role="option" aria-selected={item.id === value} className={n === active ? 'bg-accent/10' : ''}>
        <button type="button" disabled={incompatible(item)} className="min-h-11 w-full px-3 py-2 text-left text-sm disabled:opacity-50" onMouseDown={e => e.preventDefault()} onClick={() => choose(item)}><span className="block break-words">{item.code} · {item.name}</span><span className="block text-xs text-secondary">{item.unit} · {item.requires_serial ? '需要序號' : '無序號'} · {item.item_category || item.category}{incompatible(item) ? ' · 與本次序號條件不同' : ''}</span></button>
      </li>)}
      {!filtered.length && <li className="p-3 text-sm text-secondary">{onCreate && query.trim() ? <button type="button" className="min-h-11 text-accent" onMouseDown={e => e.preventDefault()} onClick={() => { setNewKey(query.trim()); setUnit(serialRequirement === false ? 'pcs' : '台'); setRequiresSerial(serialRequirement ?? true); setError(''); setOpen(false); }}>＋新增新型號「{query.trim()}」</button> : '找不到符合的庫存品項'}</li>}
    </ul>}
    {newKey && <section aria-label="新增新型號" className="mt-2 space-y-3 rounded-lg border border-theme-border p-3" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); } }}>
      <p className="break-words text-sm">型號／規格：{newKey}</p>
      <label className="block text-sm">單位<input autoFocus aria-label="新型號單位" className={field} disabled={busy} value={unit} onChange={e => setUnit(e.target.value)} /></label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={requiresSerial} disabled={busy || serialRequirement !== undefined} onChange={e => setRequiresSerial(e.target.checked)} />需要序號</label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => { setNewKey(null); setOpen(true); }}>取消</button><button type="button" className={button + ' bg-accent text-white'} disabled={busy || !unit.trim()} onClick={() => void create()}>{busy ? '建立中…' : '建立並選用'}</button></div>
    </section>}
  </div>;
}

export function useReceivingDraft(context: Omit<SerialContext, 'drafts' | 'selected'>) {
  const [state, setState] = useState<{ drafts: SerialDraft[]; selected: string[] }>({ drafts: [], selected: [] });
  const current = useRef({ ...context, ...state });
  current.current = { ...context, ...state };
  const update = (drafts: SerialDraft[], selected: string[]) => {
    current.current = { ...current.current, drafts, selected };
    setState({ drafts, selected });
  };
  const accept = (raw: string): SerialResult => {
    const result = resolveReceivingSerial(raw, current.current);
    if (result.status === 'valid') {
      const c = current.current;
      update(result.value.entryId || c.drafts.some(d => d.key === result.value.key) ? c.drafts : [...c.drafts, result.value],
        c.receiving ? [...c.selected || [], result.value.key] : c.selected || []);
    }
    return result;
  };
  return { ...state, context: current.current, accept,
    reset: () => update([], []),
    clearSelection: () => update(current.current.drafts, []),
    deselect: (key: string) => update(current.current.drafts, current.current.selected.filter(k => k !== key)),
    remove: (key: string) => update(current.current.drafts.filter(d => d.key !== key), current.current.selected.filter(k => k !== key)),
  };
}

export function ReceivingSerialControls({ context, onAccept, label, itemLabel, disabled, scannerLabel = '連續掃碼', manualLabel = '手動新增', startWith }: {
  context: SerialContext; onAccept: (raw: string) => SerialResult; label: string; itemLabel: string; disabled?: boolean; scannerLabel?: string; manualLabel?: string; startWith?: 'manual' | 'batch' | 'scan';
}) {
  const [mode, setMode] = useState<'manual' | 'batch' | 'scan' | null>(startWith || null);
  const [raw, setRaw] = useState('');
  const [batch, setBatch] = useState('');
  const [feedback, setFeedback] = useState('');
  const preview = mode === 'batch' ? previewSerialBatch(batch, context) : [];
  const count = (status: string) => preview.filter(row => row.result.status === status).length;
  const accept = (value: string) => {
    const result = onAccept(value);
    setFeedback(result.status === 'valid' ? '✓ 已加入 ' + result.value.canonical : result.message);
    return result;
  };
  const selectedLabels = context.receiving
    ? [...context.entries.map(e => ({ key: e.id, canonical: e.normalized_serial })), ...context.drafts].filter(d => context.selected?.includes(d.key)).map(d => d.canonical)
    : [...context.entries.map(e => e.normalized_serial), ...context.drafts.map(d => d.canonical)];
  return <div className="space-y-2">
    <p className="text-sm font-semibold">{label}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={disabled} className={button} onClick={() => { setMode('scan'); setFeedback(''); }}>{scannerLabel}</button>
      <button type="button" disabled={disabled} className={button} onClick={() => { setMode('batch'); setFeedback(''); }}>批次輸入</button>
      <button type="button" disabled={disabled} className={button} onClick={() => { setMode('manual'); setFeedback(''); }}>{manualLabel}</button>
    </div>
    {mode === 'manual' && <div className="rounded-lg border border-theme-border p-3">
      <label className="text-sm">序號<input autoFocus aria-label="手動序號" className={field} value={raw} onChange={e => setRaw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (accept(raw).status === 'valid') setRaw(''); } }} /></label>
      <button type="button" disabled={disabled || !raw.trim()} className={button + ' mt-2'} onClick={() => { if (accept(raw).status === 'valid') setRaw(''); }}>新增</button>
    </div>}
    {mode === 'batch' && <section aria-label="批次輸入序號" className="rounded-lg border border-theme-border p-3">
      <label className="text-sm">一行一個序號（可貼上 Excel）<textarea autoFocus aria-label="批次序號" rows={5} className={field} value={batch} onChange={e => setBatch(e.target.value)} /></label>
      <p className="my-2 text-sm" role="status">有效 {count('valid')} · 重複 {count('duplicate')} · 衝突 {count('conflict')} · 格式錯誤 {count('invalid')} · 超量 {count('cap')}</p>
      <ul className="max-h-36 overflow-y-auto text-xs">{preview.map((row, n) => <li key={n} className="break-all py-1">{row.raw} · {row.result.status === 'valid' ? '可加入' : row.result.message}</li>)}</ul>
      <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={disabled || !count('valid')} onClick={() => { preview.filter(r => r.result.status === 'valid').forEach(r => accept(r.raw)); setBatch(''); setMode(null); }}>確認加入有效序號</button><button type="button" className={button} onClick={() => setMode(null)}>取消</button></div>
    </section>}
    {feedback && <p role="status" className="break-all text-sm">{feedback}</p>}
    {mode === 'scan' && <BarcodeScanner mode="continuous" onDetected={accept} onCancel={() => setMode(null)} onFinish={() => setMode(null)}>
      <p className="font-semibold">{itemLabel}</p><p>{label}</p><p role="status" className="break-all">{feedback}</p>
      <ul>{selectedLabels.map(value => <li key={value} className="break-all">✓ {value}</li>)}</ul>
    </BarcodeScanner>}
  </div>;
}
