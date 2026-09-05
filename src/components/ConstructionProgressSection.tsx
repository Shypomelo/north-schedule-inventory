"use client";

import { useState } from 'react';
import type { Contractor, ConstructionWorkType, ProjectConstructionProgress } from '@/lib/db/types';
import type { ConstructionProgressModel } from './useConstructionProgress';
import type { ConstructionUpdate } from '@/lib/db/construction-progress';
import {
  CONSTRUCTION_WORK_LABELS, classifyConstructionItem, constructionCompletionPatch,
  getConstructionCompletionDate, getConstructionToday, getConstructionWorkLabel, getProjectEntryDate,
  getConstructionConflict,
  isConstructionPrework, sortConstructionRows, validateConstructionWorkName,
} from '@/lib/construction-progress';
import { getContractorsForWorkType } from '@/lib/contractors';

const FIXED_TYPES: ConstructionWorkType[] = ['racking', 'electrical', 'steel', 'roof_cover', 'civil'];
const inputClass = 'w-full min-w-0 rounded border border-theme-border bg-page px-2 py-1.5 text-xs text-primary disabled:opacity-50';
const gridClass = 'grid grid-cols-[8rem_12rem_8.5rem_8.5rem_4rem_minmax(8rem,1fr)_4rem] items-center gap-2 px-3 py-2';
const statusLabels = { COMPLETED: '已完工', UNSCHEDULED: '未排程', SCHEDULED: '預計進場', IN_PROGRESS: '施工中', PREWORK: '前置作業' };

export function ConstructionProgressSection({ model }: { model: ConstructionProgressModel }) {
  const [adding, setAdding] = useState(false);
  const activeRows = model.rows.filter(row => !row.deleted_at && row.status_override !== 'disabled');
  const entry = getProjectEntryDate(activeRows);
  const today = getConstructionToday();
  const sorted = sortConstructionRows(activeRows);
  const prework = sorted.filter(row => isConstructionPrework(row, entry));
  const construction = sorted.filter(row => !isConstructionPrework(row, entry));
  const disabled = !model.canEdit || model.busy || model.loading;
  const nextOrder = Math.max(0, ...model.rows.map(row => row.sort_order)) + 10;

  const renderGroup = (label: string, rows: ProjectConstructionProgress[]) => (
    <div className="overflow-x-auto rounded-lg border border-theme-border">
      <h4 className="bg-page/60 px-3 py-2 text-sm font-semibold text-secondary">{label}</h4>
      <div className="min-w-[70rem]">
        <div className={`${gridClass} border-b border-theme-border text-xs text-secondary`}>
          <span>工項 / 狀態</span><span>包商</span><span>進場日期</span><span>完工日期</span><span>完成</span><span>備註</span><span>操作</span>
        </div>
        {rows.map(row => <ConstructionRow key={row.id} row={row} model={model} today={today} />)}
        {!rows.length && <p className="px-3 py-5 text-sm text-secondary">尚無施工工項，可啟用固定工項或新增其他工項。</p>}
      </div>
    </div>
  );

  return <section aria-label="施工工項" className="space-y-3 border-t border-theme-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-primary">施工工項 <span className="ml-2 text-xs font-normal text-secondary">正式進場：{entry ?? '未排程'}</span></h3>
      {model.canEdit && <button type="button" disabled={disabled} onClick={() => setAdding(current => !current)} className="rounded border border-accent/30 px-3 py-1.5 text-sm text-accent disabled:opacity-50">{adding ? '取消新增' : '＋新增其他工項'}</button>}
    </div>
    {model.error && <div role="alert" className="text-sm text-danger">{model.error} <button type="button" disabled={model.busy} onClick={() => void model.reload()}>重新載入</button></div>}
    {model.conflictError && <p role="status" className="text-xs text-secondary">{model.conflictError}</p>}
    {model.loading ? <p className="text-sm text-secondary">施工資料載入中...</p> : <>
      {model.canEdit && <ConstructionWorkTypeControls model={model} />}
      {adding && <NewConstructionRow model={model} nextOrder={nextOrder} onCreated={() => setAdding(false)} />}
      {!!prework.length && renderGroup('前置作業', prework)}
      {renderGroup('施工', construction)}
    </>}
    {model.busy && <p role="status" className="text-xs text-secondary">儲存中...</p>}
  </section>;
}

export function ConstructionWorkTypeControls({ model }: { model: ConstructionProgressModel }) {
  return <div className="flex flex-wrap gap-3 text-xs text-secondary" aria-label="參與施工工項">
    {FIXED_TYPES.map((type, index) => {
      const row = model.rows.find(item => item.work_type === type && !item.deleted_at);
      const enabled = !!row && row.status_override !== 'disabled';
      return <label key={type} className="flex items-center gap-1"><input type="checkbox" checked={enabled} disabled={!model.canEdit || model.busy || model.loading} onChange={event => void model.save(row ?? null, { status_override: event.target.checked ? null : 'disabled' }, { work_type: type, sort_order: index * 10 })} />{CONSTRUCTION_WORK_LABELS[type]}</label>;
    })}
  </div>;
}

function ContractorSelect({ contractors, workType, value, savedName, disabled, onChange }: {
  contractors: Contractor[]; workType: ConstructionWorkType; value: string | null; savedName?: string | null;
  disabled: boolean; onChange: (id: string | null, name: string | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const options = getContractorsForWorkType(contractors, workType, showAll);
  const selected = contractors.find(contractor => contractor.id === value);
  return <div className="space-y-1">
    <select aria-label="包商" className={inputClass} value={value ?? ''} disabled={disabled} onChange={event => {
      const id = event.target.value || null;
      onChange(id, contractors.find(contractor => contractor.id === id)?.name ?? null);
    }}>
      <option value="">未指定</option>
      {value && !options.some(contractor => contractor.id === value) && <option value={value}>{selected?.name ?? savedName ?? '既有包商'}（目前已選）</option>}
      {options.map(contractor => <option key={contractor.id} value={contractor.id}>{contractor.name}</option>)}
    </select>
    {(selected?.contact_person || selected?.phone) && <span className="block text-[11px] text-secondary">{[selected.contact_person, selected.phone].filter(Boolean).join(' / ')}</span>}
    <label className="flex items-center gap-1 text-[11px] text-secondary"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} />顯示全部包商</label>
  </div>;
}

function ConstructionRow({ row, model, today }: { row: ProjectConstructionProgress; model: ConstructionProgressModel; today: string }) {
  const [notes, setNotes] = useState(row.notes ?? '');
  const [name, setName] = useState(row.work_name ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const label = getConstructionWorkLabel(row);
  const disabled = !model.canEdit || model.busy;
  // Grouping is independent of completion; the badge describes the row's current progress.
  const status = classifyConstructionItem(row, null, today);
  const conflict = getConstructionConflict(row, model.conflicts);
  const save = (patch: ConstructionUpdate) => model.save(row, patch);
  return <div className="border-b border-theme-border/50 last:border-b-0"><div className={gridClass}>
    <div>
      {row.work_type === 'other' ? <input aria-label="其他工項名稱" placeholder="其他" className={inputClass} value={name} disabled={disabled} onChange={event => setName(event.target.value)} onBlur={() => {
        if (name === (row.work_name ?? '')) return;
        const error = validateConstructionWorkName(name);
        setNameError(error);
        if (!error) void save({ work_name: name.trim() });
      }} /> : <span className="text-sm font-medium text-primary">{label}</span>}
      {nameError && <span role="alert" className="text-xs text-danger">{nameError}</span>}
      <span className="mt-1 block text-xs text-secondary">{statusLabels[status]}</span>
    </div>
    <ContractorSelect contractors={model.contractors} workType={row.work_type} value={row.contractor_id} savedName={row.contractor_name} disabled={disabled} onChange={(id, name) => void save({ contractor_id: id, contractor_name: name })} />
    <input aria-label={`${label}進場日期`} type="date" className={inputClass} value={row.planned_start_date ?? ''} disabled={disabled} onChange={event => void save({ planned_start_date: event.target.value || null })} />
    <input aria-label={`${label}完工日期`} type="date" className={inputClass} value={getConstructionCompletionDate(row) ?? ''} disabled={disabled} onChange={event => {
      const date = event.target.value || null;
      void save(row.is_completed ? constructionCompletionPatch(true, date, today) : { planned_end_date: date });
    }} />
    <input aria-label={`${label}完成`} type="checkbox" checked={row.is_completed} disabled={disabled} onChange={event => void save(constructionCompletionPatch(event.target.checked, event.target.checked ? row.planned_end_date : row.actual_completed_date, today))} />
    <input aria-label={`${label}備註`} className={inputClass} value={notes} disabled={disabled} onChange={event => setNotes(event.target.value)} onBlur={() => { if (notes !== (row.notes ?? '')) void save({ notes: notes || null }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    {row.work_type === 'other' && model.canEdit ? <div className="text-xs">
      {confirmDelete ? <><button type="button" disabled={disabled} className="text-danger" onClick={() => void model.remove(row.id)}>確認刪除</button><button type="button" onClick={() => setConfirmDelete(false)}>取消</button></> : <button type="button" disabled={disabled} className="text-danger" onClick={() => setConfirmDelete(true)}>刪除</button>}
    </div> : <span />}
  </div>{conflict && <p className="px-3 pb-2 text-xs text-danger">撞期警示：此包商已於「{conflict.projects.project_name}」安排施工（{conflict.planned_start_date} ～ {conflict.planned_end_date}）</p>}</div>;
}

function NewConstructionRow({ model, nextOrder, onCreated }: { model: ConstructionProgressModel; nextOrder: number; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [values, setValues] = useState<ConstructionUpdate>({});
  const [error, setError] = useState<string | null>(null);
  return <form className="space-y-2 rounded-lg border border-accent/30 bg-page/40 p-3" onSubmit={async event => {
    event.preventDefault();
    const nameError = validateConstructionWorkName(name);
    setError(nameError);
    if (nameError) return;
    if (await model.save(null, { ...values, work_name: name.trim() }, { work_type: 'other', sort_order: nextOrder })) onCreated();
  }}>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      <label className="text-xs text-secondary">工項名稱<input required aria-label="新增工項名稱" className={inputClass} value={name} disabled={model.busy} onChange={event => setName(event.target.value)} /></label>
      <ContractorSelect contractors={model.contractors} workType="other" value={values.contractor_id ?? null} disabled={model.busy} onChange={(id, name) => setValues(current => ({ ...current, contractor_id: id, contractor_name: name }))} />
      <label className="text-xs text-secondary">進場日期<input type="date" className={inputClass} disabled={model.busy} onChange={event => setValues(current => ({ ...current, planned_start_date: event.target.value || null }))} /></label>
      <label className="text-xs text-secondary">完工日期<input type="date" className={inputClass} disabled={model.busy} onChange={event => setValues(current => ({ ...current, planned_end_date: event.target.value || null }))} /></label>
      <label className="text-xs text-secondary">備註<input className={inputClass} disabled={model.busy} onChange={event => setValues(current => ({ ...current, notes: event.target.value || null }))} /></label>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <button type="submit" disabled={model.busy} className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50">新增工項</button>
  </form>;
}
