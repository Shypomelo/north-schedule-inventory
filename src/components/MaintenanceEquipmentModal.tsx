'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '@/lib/db/supabaseClient';
import { createMaintenanceEquipmentApi, equipmentSourceLabel, filterEquipmentCandidates, type EquipmentCandidate, type MaintenanceEquipmentRecord } from '@/lib/db/maintenance-usage';

const api = createMaintenanceEquipmentApi(supabase);
const field = 'min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm';
const localTime = (value?: string) => { const now = value ? new Date(value) : new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
// Display grouping only: exact models and backend candidate identities remain unchanged.
const equipmentFamily = (row: EquipmentCandidate) => row.model.trim().split('-')[0] || row.item_name?.trim() || '未提供型號';

export function MaintenanceEquipmentModal({ taskId, record, onClose, onRegistered }: { taskId: string; record?: MaintenanceEquipmentRecord; onClose: () => void; onRegistered: () => void }) {
  const [rows, setRows] = useState<EquipmentCandidate[]>([]);
  const [query, setQuery] = useState('');
  const [equipment, setEquipment] = useState('');
  const [model, setModel] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [selected, setSelected] = useState<EquipmentCandidate[]>([]);
  const [initialReplacedAt] = useState(() => localTime(record?.replaced_at));
  const [notes, setNotes] = useState(record?.notes || '');
  const [notesOpen, setNotesOpen] = useState(false);
  const [confirmCrossProject, setConfirmCrossProject] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const requests = useRef(new Map<string, string>());
  const dialog = useRef<HTMLElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const equipmentOptions = useMemo(() => Array.from(new Set(rows.map(equipmentFamily))).sort(), [rows]);
  const modelOptions = useMemo(() => Array.from(new Set(rows.filter(row => equipmentFamily(row) === equipment).map(row => row.model).filter(Boolean))).sort(), [rows, equipment]);
  const scoped = useMemo(() => equipment && model ? rows.filter(row => equipmentFamily(row) === equipment && row.model === model) : [], [rows, equipment, model]);
  const filtered = useMemo(() => filterEquipmentCandidates(scoped, query), [scoped, query]);
  const count = Number(quantity);
  const validQuantity = Number.isSafeInteger(count) && count > 0;
  const crossProjectRows = selected.filter(row => row.cross_project);
  const canSubmit = !loading && validQuantity && (!record || count === 1) && selected.length === count && selected.every(row => row.eligible && scoped.some(candidate => candidate.key === row.key)) && (crossProjectRows.length === 0 || confirmCrossProject);
  const clearSelection = () => { setSelected([]); setQuery(''); setError(''); setConfirmCrossProject(false); };
  useEffect(() => {
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    api.search(taskId, record?.id).then(data => {
      if (!active) return;
      setRows(data);
      const current = record && data.find(row => row.current_record);
      if (current) { setEquipment(equipmentFamily(current)); setModel(current.model); setSelected([current]); }
    })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '設備載入失敗'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; previous?.focus(); };
  }, [taskId, record?.id]);

  return createPortal(<div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-3" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!submitting.current) onClose(); }
    if (event.key === 'Tab') {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:enabled,input:enabled,select:enabled,textarea:enabled');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={record ? '修改設備維修' : '新增設備維修'} className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--modal-bg)] p-4 text-[var(--modal-text)] shadow-2xl">
      <h2 className="text-lg font-bold">{record ? '修改設備維修' : '新增設備維修'}</h2>
      <form onSubmit={async event => {
        event.preventDefault(); event.stopPropagation();
        if (submitting.current || !canSubmit) return;
        const enteredDate = dateInput.current?.value || '';
        // Editing a serial/note must not truncate an existing event's seconds.
        const date = new Date(record && enteredDate === initialReplacedAt ? record.replaced_at : enteredDate);
        if (!Number.isFinite(date.getTime())) { setError('請填寫有效的實際更換日期時間'); return; }
        submitting.current = true; setSaving(true); setError('');
        const registered = new Set<string>();
        try {
          for (const candidate of selected) {
            const payload = JSON.stringify([record?.id, record?.revision, candidate.key, candidate.version, date.toISOString(), notes, confirmCrossProject]);
            if (!requests.current.has(payload)) requests.current.set(payload, crypto.randomUUID());
            await api.register({ requestId: requests.current.get(payload)!, taskId, candidate, replacedAt: date.toISOString(), notes, confirmCrossProject, record });
            registered.add(candidate.key);
          }
          onRegistered(); onClose();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : '登錄失敗，請重試';
          const remaining = selected.filter(row => !registered.has(row.key));
          const progress = registered.size ? `已登錄 ${registered.size} / ${selected.length} 台；剩餘 ${remaining.length} 台尚未確認。` : '';
          setError(progress + message);
          if (registered.size) {
            setRows(current => current.filter(row => !registered.has(row.key)));
            setSelected(remaining); setQuantity(String(remaining.length));
            onRegistered();
          }
          setUncertain(!message.includes('EQUIPMENT_CONFLICT') && /fetch|network|連線|未取得/i.test(message));
          if (message.includes('EQUIPMENT_CONFLICT')) {
            setSelected([]);
            setConfirmCrossProject(false);
            setLoading(true);
            try { setRows(await api.search(taskId, record?.id)); }
            catch { setRows([]); setError(`${progress}${message}；重新載入來源失敗，請關閉後重試。`); }
            finally { setLoading(false); }
          }
        } finally { submitting.current = false; setSaving(false); }
      }}>
        <fieldset disabled={saving || uncertain} className="mt-3 space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
          <label className="min-w-0 text-sm">設備<select required disabled={loading} className={`${field} mt-1`} value={equipment} onChange={event => { setEquipment(event.target.value); setModel(''); clearSelection(); }}>
            <option value="">{loading ? '載入設備中…' : '先選設備／品項'}</option>
            {equipmentOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select></label>
          <label className="min-w-0 text-sm">數量<input required disabled={!!record} type="number" min="1" step="1" className={`${field} mt-1`} value={quantity} onChange={event => { setQuantity(event.target.value); setSelected([]); setError(''); setConfirmCrossProject(false); }} /></label>
          </div>
          <label className="block text-sm">型號<select required disabled={!equipment || loading} className={`${field} mt-1`} value={model} onChange={event => { setModel(event.target.value); clearSelection(); }}>
            <option value="">請選擇型號</option>
            {modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select></label>
          {!validQuantity && <p className="text-sm text-[var(--danger)]">數量須為大於 0 的整數。</p>}
          {equipment && model && <>
          <p aria-live="polite" className="text-sm font-semibold">序號：已選 {selected.length} / {validQuantity ? count : '—'}</p>
          <label className="block"><span className="sr-only">搜尋／掃描序號</span><input autoComplete="off" className={field} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} placeholder="搜尋／掃描序號" /></label>
          <div className="max-h-40 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)]" aria-label="設備搜尋結果">
            {loading ? <p className="p-2">載入中…</p> : filtered.length === 0 ? <p className="p-2">無符合的設備</p> : filtered.map(row => <button type="button" key={row.key} disabled={!row.eligible || !validQuantity || (count > 1 && selected.length >= count && !selected.some(candidate => candidate.key === row.key))} onClick={() => { setSelected(current => current.some(candidate => candidate.key === row.key) ? current.filter(candidate => candidate.key !== row.key) : count === 1 ? [row] : current.length < count ? [...current, row] : current); setError(''); setConfirmCrossProject(false); }} aria-pressed={selected.some(candidate => candidate.key === row.key)} className={`block min-h-12 w-full px-2.5 py-2 text-left text-sm disabled:opacity-50 ${selected.some(candidate => candidate.key === row.key) ? 'bg-[var(--accent)]/15 ring-1 ring-inset ring-[var(--accent)]' : 'hover:bg-[var(--surface-secondary)]'}`}>
              <span className="block break-all font-medium">{selected.some(candidate => candidate.key === row.key) ? '✓ ' : ''}{row.serial}</span>
              <span className="block break-words text-xs text-[var(--modal-muted)]">{row.model} · {equipmentSourceLabel[row.source_type]}{row.se_supply_record_id ? ` · 原案場：${row.original_project_name || row.project_name || '未指定'}` : ''}</span>
              {row.conflict && <span className="block text-xs text-[var(--danger)]">需確認：{row.conflict}</span>}
            </button>)}
          </div>
          {selected.some(row => !filtered.some(visible => visible.key === row.key)) && <ul aria-label="已選序號" className="max-h-24 overflow-y-auto text-xs">{selected.map(row => <li key={row.key} className="flex items-center justify-between gap-2"><span className="break-all">✓ {row.serial}</span><button type="button" aria-label={`移除 ${row.serial}`} className="min-h-11 shrink-0 px-2" onClick={() => { setSelected(current => current.filter(candidate => candidate.key !== row.key)); setConfirmCrossProject(false); }}>移除</button></li>)}</ul>}
          {crossProjectRows.length > 0 && <div role="note" aria-label="跨案場使用提醒" className="rounded-lg border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs">
            {Array.from(new Set(crossProjectRows.map(row => row.original_project_name || row.project_name || '未指定'))).map(name => <p key={name}>原 SE 供貨案場：{name}</p>)}
            <p>本次維修案場：{crossProjectRows[0].maintenance_project_name}</p>
            <label className="flex min-h-10 items-center gap-2 font-semibold"><input type="checkbox" checked={confirmCrossProject} onChange={event => setConfirmCrossProject(event.target.checked)} />確認跨案場使用</label>
          </div>}
          {count > 1 && <p className="text-xs text-[var(--modal-muted)]">逐台登錄；中途失敗會保留已成功紀錄。</p>}
          </>}
          <label className="block text-sm">實際更換時間<input ref={dateInput} required name="replaced_at" type="datetime-local" className={`${field} mt-1`} defaultValue={initialReplacedAt} /></label>
          <button type="button" aria-expanded={notesOpen} onClick={() => setNotesOpen(value => !value)} className="min-h-9 text-sm text-[var(--modal-muted)]">{notesOpen ? '－收合備註' : notes ? '＋備註（已有內容）' : '＋備註'}</button>
          {notesOpen && <label className="block text-sm"><span className="sr-only">備註</span><textarea rows={2} className={`${field} py-2`} value={notes} onChange={event => setNotes(event.target.value)} /></label>}
        </fieldset>
        {error && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        {uncertain && <p className="text-sm">結果尚未確認，請以相同資料重試；系統不會重複出庫。</p>}
        <div className="mt-3 flex justify-end gap-2 border-t border-[var(--border)] pt-3">
          <button type="button" disabled={saving} onClick={onClose} className="min-h-11 rounded-lg border border-[var(--border)] px-4">取消</button>
          <button type="submit" disabled={saving || !canSubmit} className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-bold text-[var(--accent-text)] disabled:opacity-50">{saving ? '儲存中…' : uncertain ? '重試未確認的儲存' : record ? '儲存修改' : '確認登錄'}</button>
        </div>
      </form>
    </section>
  </div>, document.body);
}
