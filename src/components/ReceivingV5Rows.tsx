'use client';

import { useEffect, useState } from 'react';
import type { ReceivingV5Api, MatchInput, MatchCandidate } from '@/lib/db/receiving-v5';
import { matchSourceKey, sourceFields, receivingError, type ActualRow, type PendingRow, type ReceivingSnapshot } from '@/lib/receiving-v5';
import { formatTaipeiReceivingTime } from '@/lib/material-receiving';
import { InventoryItemCombobox } from './ReceivingSerialControls';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';
import { ActionError, PendingForm, PendingSerialEditor, useV5Action, useV5Request, v5Button, v5Field, v5Primary } from './ReceivingV5Forms';
import { selectReceivingProjects } from '@/lib/project-selectors';

export function PendingListRow({ row, data, api, expanded, canEdit, onToggle, onChanged, onArrival, onHistory }: {
  row: PendingRow; data: ReceivingSnapshot; api: ReceivingV5Api; expanded: boolean; canEdit: boolean;
  onToggle: () => void; onChanged: () => Promise<void>; onArrival: () => void; onHistory: () => void;
}) {
  const [edit, setEdit] = useState<'edit' | 'serial' | 'scan' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const action = useV5Action(); const request = useV5Request();
  const item = data.items.find(i => i.id === row.itemId);
  const f = row.fulfilment;
  return <article data-pending-row={row.key} className="min-w-0 rounded-xl border border-theme-border bg-card">
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full min-w-0 items-start justify-between gap-3 p-3 text-left">
      <span className="min-w-0 space-y-1"><span className="block break-words font-semibold">{row.label} ×{f.expected} {row.unit}</span><span className="block break-words text-xs text-secondary">預計 {row.expectedAt ? formatTaipeiReceivingTime(row.expectedAt) : '未定'}｜{row.projectLabel}</span><span className="block text-sm">已收到 {f.fulfilled} / {f.expected}｜剩餘 {f.remaining}</span>{Boolean(item?.requires_serial || row.observations.length) && <span className="block text-xs text-secondary">預登序號 {row.observations.length}</span>}</span>
      <span className="shrink-0 py-1 text-sm text-accent">{expanded ? '收合' : '展開'}</span>
    </button>
    {expanded && <div className="min-w-0 space-y-3 border-t border-theme-border p-3">
      <p className="break-words text-sm">{row.notes || '尚無備註'}</p>
      <p className="text-sm">預登序號：{row.observations.length} / {f.expected}</p>
      <ul className="max-h-40 overflow-y-auto text-sm">{row.observations.map(e => <li key={e.id} className="break-all py-1">{e.normalized_serial}</li>)}</ul>
      {row.legacy && <p className="text-sm text-secondary">此待收含歷史收貨，請先核對歷程；歷史收貨不會自動轉成到貨對應。</p>}
      <div className="flex flex-wrap gap-2">
        {canEdit && !row.legacy && <><button type="button" className={v5Button} onClick={() => setEdit('edit')}>修改待收</button>
          {item?.requires_serial && <><button type="button" className={v5Button} onClick={() => setEdit('serial')}>預登序號</button><button type="button" className={v5Button} onClick={() => setEdit('scan')}>掃碼預登</button></>}
          <button type="button" className={v5Primary} onClick={onArrival}>登錄實際到貨</button><button type="button" className={v5Button} onClick={() => setEdit('cancel')}>取消剩餘待收</button></>}
        <button type="button" className={v5Button} onClick={onHistory}>歷程</button>
      </div>
      {edit === 'edit' && <PendingForm data={data} api={api} row={row} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await onChanged(); }} />}
      {(edit === 'serial' || edit === 'scan') && <PendingSerialEditor key={edit} data={data} api={api} row={row} scan={edit === 'scan'} onClose={() => setEdit(null)} onSaved={onChanged} />}
      {edit === 'cancel' && <div className="space-y-3 rounded-lg border border-warning/40 p-3" aria-label="取消剩餘待收確認">
        <p className="text-sm">已收到 {f.fulfilled}，剩餘 {f.remaining} 將不再等待。</p>
        <label className="block text-sm">原因（選填）<input className={v5Field} disabled={action.busy} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <ActionError message={action.error} /><div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={action.busy} onClick={() => setEdit(null)}>繼續等待</button><button type="button" className={v5Primary} disabled={action.busy} onClick={() => void action.run(async () => {
          await api.cancelRemaining(request({ p_source_type: row.kind, p_source_id: row.id, p_reason: reason.trim() || null })); setEdit(null); await onChanged();
        })}>確認取消剩餘</button></div>
      </div>}
    </div>}
  </article>;
}

export function ArrivalMetadata({ row, data, api, onChanged, onClose }: {
  row: ActualRow; data: ReceivingSnapshot; api: ReceivingV5Api; onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(row.arrival!.project_id || '');
  const [notes, setNotes] = useState(row.arrival!.notes || '');
  const [version] = useState(row.arrival!.version);
  const action = useV5Action(); const request = useV5Request();
  return <form aria-label="編輯到貨資料" className="space-y-3 rounded-lg border border-theme-border p-3" onSubmit={e => { e.preventDefault(); void action.run(async () => {
    await api.metadata(request({ p_arrival_id: row.arrival!.id, p_expected_version: version, p_project_id: projectId || null, p_notes: notes.trim() || null }));
    onClose(); await onChanged();
  }); }}>
    <fieldset disabled={action.busy} className="min-w-0 space-y-3"><ReceivingProjectCombobox projects={selectReceivingProjects(data.projects)} value={projectId} onChange={setProjectId} /><label className="block text-sm">備註（選填）<textarea className={v5Field} rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label></fieldset>
    <ActionError message={action.error} /><div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={action.busy} onClick={onClose}>取消編輯</button><button className={v5Primary} disabled={action.busy}>儲存到貨資料</button></div>
  </form>;
}

function CompleteArrival({ row, data, api, conflict, onChanged }: { row: ActualRow; data: ReceivingSnapshot; api: ReceivingV5Api; conflict: boolean; onChanged: () => Promise<void> }) {
  const [itemId, setItemId] = useState('');
  const action = useV5Action(); const request = useV5Request();
  return <section aria-label="補齊品項" className="space-y-3 rounded-lg border border-warning/40 p-3">
    <p className="text-sm">實物已在北辦，尚未計入正式可用庫存。</p>
    {conflict ? <p className="text-sm text-warning">序號已有庫存身份或有衝突，請先核對原序號資料。</p> : <InventoryItemCombobox items={data.items.filter(i => i.is_active && i.requires_serial === Boolean(row.observations.length))} value={itemId} onChange={setItemId} disabled={action.busy} />}
    <ActionError message={action.error} />
    <button type="button" className={v5Primary} disabled={action.busy || conflict || !itemId} onClick={() => void action.run(async () => {
      const lookups = await Promise.all(row.observations.map(e => api.lookup(e.raw_serial)));
      if (lookups.some(r => r.result_type !== 'no_match')) throw new Error('ARRIVAL_SERIAL_IDENTITY_CONFLICT');
      await api.complete(request({ p_line_id: row.line!.id, p_item_id: itemId }));
      await onChanged();
    })}>儲存並完成入庫</button>
  </section>;
}

interface MatchDraft { key: string; quantity: string; entryIds: string[] }
export function MatchEditor({ row, data, pending, api, onChanged, onClose }: {
  row: ActualRow; data: ReceivingSnapshot; pending: PendingRow[]; api: ReceivingV5Api; onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null);
  const [version] = useState(row.line!.version);
  const [drafts, setDrafts] = useState<MatchDraft[]>(() => {
    const groups = new Map<string, MatchDraft>();
    for (const match of row.matches) {
      const key = matchSourceKey(match); const previous = groups.get(key);
      groups.set(key, { key, quantity: String(Number(previous?.quantity || 0) + Number(match.quantity)), entryIds: [...previous?.entryIds || [], ...data.matchObservations.filter(s => s.match_id === match.id && !s.cancelled_at).map(s => s.arrival_entry_id)] });
    }
    return Array.from(groups.values());
  });
  const action = useV5Action(); const request = useV5Request();
  const [loadError, setLoadError] = useState('');
  useEffect(() => { let live = true;
    api.candidates(row.line!, row.arrival!, data).then(rows => { if (live) setCandidates(rows); }).catch(e => { if (live) setLoadError(receivingError(e)); });
    return () => { live = false; };
    // Keep one version/candidate snapshot for the edit session. RPC rejects concurrent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const serialized = Boolean(row.observations.length);
  const total = drafts.reduce((n, d) => n + (serialized ? d.entryIds.length : Number(d.quantity) || 0), 0);
  const update = (key: string, values: Partial<MatchDraft>) => setDrafts(current => current.map(d => d.key === key ? { ...d, ...values } : d));
  return <section aria-label="調整待收對應" className="min-w-0 space-y-3 rounded-lg border border-theme-border p-3">
    <h4 className="font-semibold">本次到貨 {row.quantity} {row.unit} · 總分配 {total} / {row.quantity}</h4>
    {drafts.map(d => {
      const candidate = candidates?.find(p => p.key === d.key);
      const source = candidate || pending.find(p => p.key === d.key);
      const available = Boolean(candidate);
      return <fieldset key={d.key} disabled={action.busy} className="min-w-0 space-y-2 rounded-lg border border-theme-border p-3">
        <legend className="max-w-full break-words text-sm">{source?.label || '原待收'}｜{source?.projectLabel}</legend>
        {candidates && !available && <p className="text-sm text-warning">此待收已結束或不相容，請解除這筆對應後再儲存。</p>}
        {serialized ? <div className="max-h-48 space-y-1 overflow-y-auto">{row.observations.map(entry => <label key={entry.id} className="flex min-h-11 min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={d.entryIds.includes(entry.id)} disabled={!available || candidate?.eligibleEntryIds?.includes(entry.id) === false || drafts.some(other => other.key !== d.key && other.entryIds.includes(entry.id))} onChange={e => update(d.key, { entryIds: e.target.checked ? [...d.entryIds, entry.id] : d.entryIds.filter(id => id !== entry.id) })} /><span className="break-all">{entry.normalized_serial}</span></label>)}</div> : <label className="block text-sm">對應數量<input type="number" aria-label={`對應數量 ${source?.projectLabel || d.key}`} min="0" step="any" disabled={!available} value={d.quantity} className={v5Field} onChange={e => update(d.key, { quantity: e.target.value })} /></label>}
        <button type="button" className={v5Button} onClick={() => setDrafts(current => current.filter(value => value.key !== d.key))}>解除這筆對應</button>
      </fieldset>;
    })}
    {!candidates && !loadError && <p role="status" className="text-sm">正在尋找相容待收…</p>}
    <ActionError message={loadError} />
    {candidates?.filter(p => !drafts.some(d => d.key === p.key)).map(p => <div key={p.key} className="space-y-2 rounded-lg bg-page p-3">
      <p className="break-words text-sm">{p.label} ×{p.fulfilment.expected}｜剩餘 {p.fulfilment.remaining}｜{p.projectLabel}｜預計 {p.expectedAt ? formatTaipeiReceivingTime(p.expectedAt) : '未定'}</p>
      <button type="button" className={v5Button} disabled={action.busy} onClick={() => setDrafts(current => [...current, { key: p.key, quantity: String(Math.max(0, Math.min(p.fulfilment.remaining, row.quantity - total))), entryIds: [] }])}>{candidates.length === 1 ? '接受' : '連結'}</button>
    </div>)}
    {candidates?.length === 0 && <p className="text-sm text-secondary">目前沒有相容的有效待收。</p>}
    <ActionError message={action.error} />
    <div className="flex flex-wrap gap-2"><button type="button" className={v5Button} disabled={action.busy} onClick={onClose}>取消調整</button><button type="button" className={v5Primary} disabled={action.busy || !candidates || total > row.quantity} onClick={() => void action.run(async () => {
      const matches: MatchInput[] = drafts.flatMap(d => {
        const quantity = serialized ? d.entryIds.length : Number(d.quantity);
        if (!Number.isFinite(quantity) || quantity < 0) throw new Error('請輸入有效的對應數量。');
        if (!quantity) return [];
        const source = candidates?.find(p => p.key === d.key);
        if (!source) throw new Error('請先解除已結束或不相容的待收對應。');
        if (serialized && d.entryIds.some(id => !source.eligibleEntryIds?.includes(id))) throw new Error('選取的序號與待收預登資料不相容。');
        if (serialized && d.entryIds.filter(id => source.unregisteredEntryIds?.includes(id)).length > (source.unregisteredCapacity || 0)) throw new Error('MATCH_PREDECLARED_SERIAL_CONFLICT');
        return [{ ...sourceFields(source), quantity, entry_ids: serialized ? d.entryIds : [] }];
      });
      await api.replaceMatches(request({ p_line_id: row.line!.id, p_expected_version: version, p_matches: matches }));
      onClose(); await onChanged();
    })}>確認調整</button></div>
  </section>;
}

export function ActualListRow({ row, data, pending, api, conflict, expanded, canEdit, onToggle, onChanged, onHistory }: {
  row: ActualRow; data: ReceivingSnapshot; pending: PendingRow[]; api: ReceivingV5Api; conflict: boolean; expanded: boolean;
  canEdit: boolean; onToggle: () => void; onChanged: () => Promise<void>; onHistory: () => void;
}) {
  const [edit, setEdit] = useState<'metadata' | 'matches' | null>(null);
  const status = row.state === 'LEGACY' ? '歷史收貨' : row.state === 'POSTED' ? '已入庫' : row.state === 'STAGED' ? '已收到・待入庫' : conflict ? '已收到・序號待確認' : '已收到・待補品項';
  return <article data-actual-row={row.key} className="min-w-0 rounded-xl border border-theme-border bg-card">
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full min-w-0 items-start justify-between gap-3 p-3 text-left">
      <span className="min-w-0 space-y-1"><span className="block break-all font-semibold">{row.label}{row.state !== 'UNRESOLVED' && ` ×${row.quantity} ${row.unit}`}</span><span className="block text-xs text-secondary">{row.at ? formatTaipeiReceivingTime(row.at) : '收貨時間未記錄'}{row.observations.length ? `｜序號 ${row.observations.length}` : ''}</span><span className={`block text-sm ${row.state === 'UNRESOLVED' ? 'text-warning' : 'text-secondary'}`}>{status}</span></span>
      <span className="shrink-0 py-1 text-sm text-accent">{expanded ? '收合' : '展開'}</span>
    </button>
    {expanded && <div className="min-w-0 space-y-3 border-t border-theme-border p-3">
      <p className="text-sm">實收：{row.quantity} {row.unit}{row.reversed ? `（已更正 ${row.reversed}）` : ''}</p>
      <p className="break-words text-sm">案件：{row.projectLabel}</p><p className="break-words text-sm">備註：{row.arrival?.notes || row.receipt?.notes || '尚無備註'}</p>
      {row.arrival && canEdit && <button type="button" className={v5Button} onClick={() => setEdit('metadata')}>編輯案件／備註</button>}
      {edit === 'metadata' && <ArrivalMetadata row={row} data={data} api={api} onChanged={onChanged} onClose={() => setEdit(null)} />}
      {row.state === 'UNRESOLVED' && canEdit && <CompleteArrival row={row} data={data} api={api} conflict={conflict} onChanged={onChanged} />}
      {row.state === 'POSTED' && <div className="space-y-2">
        <p className="text-sm font-semibold">待收對應</p>
        {!row.matches.length && <p className="text-sm text-secondary">未對應</p>}
        {row.matches.map(m => { const p = pending.find(value => value.key === matchSourceKey(m)); return <p key={m.id} className="break-words text-sm">{p?.label || '原待收'} ×{p?.fulfilment.expected || '—'}｜{p?.projectLabel}｜本次對應 {m.quantity}</p>; })}
        {canEdit && <button type="button" className={v5Button} onClick={() => setEdit('matches')}>{row.matches.length ? '調整對應' : '尋找待收'}</button>}
      </div>}
      {edit === 'matches' && <MatchEditor row={row} data={data} pending={pending} api={api} onChanged={onChanged} onClose={() => setEdit(null)} />}
      <ul className="max-h-48 overflow-y-auto text-sm" aria-label="實際到貨序號">{row.observations.map(e => <li key={e.id} className="break-all py-1">{e.normalized_serial}</li>)}</ul>
      <button type="button" className={v5Button} onClick={onHistory}>歷程</button>
    </div>}
  </article>;
}
