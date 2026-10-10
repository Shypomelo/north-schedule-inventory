"use client";

import { type ReactNode, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import type { Contractor, ConstructionWorkType, ProjectConstructionProgress } from '@/lib/db/types';
import type { ConstructionProgressModel } from './useConstructionProgress';
import type { ConstructionUpdate } from '@/lib/db/construction-progress';
import {
  CONSTRUCTION_WORK_LABELS, classifyConstructionItem, constructionCompletionPatch,
  getConstructionEndDate, getConstructionToday, getConstructionWorkLabel, getProjectEntryDate,
  getConstructionConflict, getConstructionWorkNameConflict,
  sortConstructionRows,
  validateActualCompletionDate, validateConstructionWorkName,
} from '@/lib/construction-progress';
import { QuickBusinessDateInput } from './QuickBusinessDateInput';
import { getContractorsForWorkType } from '@/lib/contractors';
import { WORKFLOW_GRID_CLASS, WORKFLOW_GRID_STYLE } from '@/lib/workflow-table';

const FIXED_TYPES: ConstructionWorkType[] = ['racking', 'electrical', 'steel', 'roof_cover', 'civil'];
const inputClass = 'w-full min-w-0 rounded border border-theme-border bg-page px-2 py-1.5 text-xs text-primary disabled:opacity-50';
const gridClass = `${WORKFLOW_GRID_CLASS} px-3 py-2`;
const statusLabels = { COMPLETED: '已完工', UNSCHEDULED: '未排程', SCHEDULED: '預計進場', IN_PROGRESS: '施工中', PREWORK: '前置作業' };

function ConstructionCompletionDateInput({ value, today, isCompleted, disabled, onCommit }: {
  value: string | null;
  today: string;
  isCompleted: boolean;
  disabled: boolean;
  onCommit: (value: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return <div><QuickBusinessDateInput value={value} today={today} label={isCompleted ? '實際完工日期' : '預計完工日期'} disabled={disabled} onCommit={date => {
    const validationError = isCompleted ? validateActualCompletionDate(date, today) : null;
    setError(validationError);
    if (!validationError) onCommit(date);
  }} />
    {error && <span role="alert" className="block text-[11px] text-danger">{error}</span>}
  </div>;
}

export function ConstructionProgressSection({ model, embedded = false, controlsOnly = false }: { model: ConstructionProgressModel; embedded?: boolean; controlsOnly?: boolean }) {
  const [adding, setAdding] = useState(false);
  const activeRows = model.rows.filter(row => !row.deleted_at && row.status_override !== 'disabled');
  const newRoof = activeRows.some(row => row.work_type === 'steel' || row.work_type === 'roof_cover');
  const entry = getProjectEntryDate(activeRows, newRoof);
  const today = getConstructionToday();
  const sorted = sortConstructionRows(activeRows);
  const disabled = !model.canEdit || model.busy || model.loading;
  const nextOrder = Math.max(0, ...model.rows.map(row => row.sort_order)) + 10;

  const renderGroup = (rows: ProjectConstructionProgress[]) => (
    <div className="border-t border-theme-border">
      <div className="min-w-[80rem]">
        {!embedded && <div style={WORKFLOW_GRID_STYLE} className={`${gridClass} border-b border-theme-border text-xs text-secondary`}>
          <span /><span>工項</span><span>類型</span><span>狀態</span><span>預計日期</span><span>實際日期</span><span>備註</span><span>操作</span>
        </div>}
        {rows.map(row => <ConstructionRow key={row.id} row={row} model={model} today={today} />)}
        {!rows.length && <p className="px-3 py-5 text-sm text-secondary">尚無施工工項，可啟用固定工項或新增其他工項。</p>}
      </div>
    </div>
  );

  return <section aria-label="施工工項" className="space-y-3 border-t border-theme-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-secondary">正式進場：{entry ?? '未排程'}</p>
      {model.canEdit && <button type="button" disabled={disabled} onClick={() => setAdding(current => !current)} className="rounded border border-accent/30 px-3 py-1.5 text-sm text-accent disabled:opacity-50">{adding ? '取消新增' : '＋新增其他工項'}</button>}
    </div>
    {model.error && <div role="alert" className="text-sm text-danger">{model.error} <button type="button" disabled={model.busy} onClick={() => void model.reload()}>重新載入</button></div>}
    {model.conflictError && <p role="status" className="text-xs text-secondary">{model.conflictError}</p>}
    {model.loading ? <p className="text-sm text-secondary">施工資料載入中...</p> : <>
      {model.canEdit && <ConstructionWorkTypeControls model={model} />}
      {adding && <NewConstructionRow model={model} nextOrder={nextOrder} onCreated={() => setAdding(false)} />}
      {!controlsOnly && renderGroup(sorted)}
    </>}
    {model.busy && <p role="status" className="text-xs text-secondary">儲存中...</p>}
  </section>;
}

export function ConstructionWorkTypeControls({ model }: { model: ConstructionProgressModel }) {
  return <div className="flex flex-wrap gap-3 text-xs text-secondary" aria-label="參與施工工項">
    {FIXED_TYPES.map((type, index) => {
      const row = model.rows.find(item => item.work_type === type && !item.deleted_at);
      const enabled = row ? row.status_override !== 'disabled' : type === 'racking' || type === 'electrical';
      return <label key={type} className="flex items-center gap-1"><input type="checkbox" checked={enabled} disabled={!model.canEdit || model.busy || model.loading} onChange={event => void model.save(row ?? null, { status_override: event.target.checked ? null : 'disabled' }, { work_type: type, sort_order: index * 10 })} />{CONSTRUCTION_WORK_LABELS[type]}</label>;
    })}
  </div>;
}

export function ConstructionTradesEditor({ model }: { model: ConstructionProgressModel }) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const rows = model.rows.filter(row => !row.deleted_at);
  const disabled = !model.canEdit || model.busy || model.loading;
  const nextOrder = Math.max(0, ...rows.map(row => row.sort_order)) + 10;
  const addOther = async () => {
    const normalized = name.trim();
    const validation = getConstructionWorkNameConflict(normalized, rows);
    const existing = rows.find(row => row.work_type === 'other' && row.work_name?.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase());
    if (validation || (existing && existing.status_override !== 'disabled')) {
      setNameError(validation || '此施工工種已存在');
      return;
    }
    const saved = existing
      ? await model.save(existing, { status_override: null })
      : await model.save(null, { work_name: normalized }, { work_type: 'other', sort_order: nextOrder });
    if (saved) { setName(''); setNameError(null); }
  };
  const renameOther = async (row: ProjectConstructionProgress) => {
    const normalized = editingName.trim();
    const validation = getConstructionWorkNameConflict(normalized, rows, row.id);
    if (validation) { setNameError(validation); return; }
    if (await model.save(row, { work_name: normalized })) { setEditingId(null); setNameError(null); }
  };
  const deleteOther = async (row: ProjectConstructionProgress) => {
    const hasHistory = Boolean(row.planned_start_date || row.planned_end_date || row.actual_completed_date || row.completed_date || row.is_completed || row.notes || row.contractor_id);
    if (!window.confirm(hasHistory ? `「${row.work_name}」已有施工紀錄，確定停用並保留歷史嗎？` : `確定刪除「${row.work_name}」嗎？`)) return;
    if (hasHistory) await model.save(row, { status_override: 'disabled' });
    else await model.remove(row.id);
  };
  return <div className="space-y-3" aria-label="參與工種與包商">
    {[...FIXED_TYPES.map((type, index) => ({ type, label: CONSTRUCTION_WORK_LABELS[type], row: rows.find(item => item.work_type === type), order: index * 10 })),
      ...rows.filter(row => row.work_type === 'other').map(row => ({ type: 'other' as const, label: row.work_name || '其他工項', row, order: row.sort_order }))].map(({ type, label, row, order }) => {
      const enabled = row ? row.status_override !== 'disabled' : type === 'racking' || type === 'electrical';
      return <div key={row?.id || type} className="flex flex-wrap items-center gap-3 rounded-lg border border-theme-border bg-card/40 p-2 text-sm">
        <label className="flex min-w-32 flex-1 items-center gap-2"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => void model.save(row ?? null, { status_override: event.target.checked ? null : 'disabled' }, { work_type: type, sort_order: order, ...(type === 'other' ? { work_name: label } : {}) })} /><span className="text-primary">{label}</span></label>
        {type === 'other' && row && <div className="flex items-center gap-1">{editingId === row.id ? <><input aria-label={`${label}新名稱`} value={editingName} onChange={event => setEditingName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void renameOther(row); }} className={`${inputClass} w-32`} /><button type="button" aria-label={`儲存${label}名稱`} disabled={disabled} onClick={() => void renameOther(row)} className="rounded p-1 text-success"><Check size={16} /></button><button type="button" aria-label="取消改名" onClick={() => setEditingId(null)} className="rounded p-1 text-secondary"><X size={16} /></button></> : <><button type="button" aria-label={`修改${label}名稱`} title="修改名稱" disabled={disabled} onClick={() => { setEditingId(row.id); setEditingName(row.work_name || ''); setNameError(null); }} className="rounded p-1 text-secondary hover:text-accent disabled:opacity-50"><Pencil size={16} /></button><button type="button" aria-label={`刪除或停用${label}`} title="刪除或停用" disabled={disabled} onClick={() => void deleteOther(row)} className="rounded p-1 text-secondary hover:text-danger disabled:opacity-50"><Trash2 size={16} /></button></>}</div>}
        <div className="min-w-44 flex-1"><ContractorSelect contractors={model.contractors} workType={type} workName={row?.work_name} value={row?.contractor_id ?? null} savedName={row?.contractor_name} disabled={disabled || !enabled} onChange={(id, contractorName) => { void model.save(row ?? null, { contractor_id: id, contractor_name: contractorName }, { work_type: type, sort_order: order }); }} /></div>
      </div>;
    })}
    {model.canEdit && <div className="flex flex-wrap gap-2"><input aria-label="自訂施工工種名稱" value={name} onChange={event => { setName(event.target.value); setNameError(null); }} onKeyDown={event => { if (event.key === 'Enter') void addOther(); }} placeholder="自訂施工工種" className={`${inputClass} max-w-xs`} /><button type="button" disabled={disabled || !name.trim()} onClick={() => void addOther()} className="rounded border border-accent/30 px-3 py-1.5 text-sm text-accent disabled:opacity-50">＋新增自訂工種</button></div>}
    {nameError && <p role="alert" className="text-xs text-danger">{nameError}</p>}
    {model.error && <p role="alert" className="text-xs text-danger">{model.error}</p>}
  </div>;
}

function ContractorSelect({ contractors, workType, workName, value, savedName, disabled, onChange }: {
  contractors: Contractor[]; workType: ConstructionWorkType; workName?: string | null; value: string | null; savedName?: string | null;
  disabled: boolean; onChange: (id: string | null, name: string | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const options = getContractorsForWorkType(contractors, workType, showAll, workName);
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

export function ConstructionRow({ row, model, today, dragHandle }: { row: ProjectConstructionProgress; model: ConstructionProgressModel; today: string; dragHandle?: ReactNode }) {
  const [notes, setNotes] = useState(row.notes ?? '');
  const label = getConstructionWorkLabel(row);
  const disabled = !model.canEdit || model.busy;
  // Grouping is independent of completion; the badge describes the row's current progress.
  const status = classifyConstructionItem(row, null, today);
  const conflict = getConstructionConflict(row, model.conflicts);
  const save = (patch: ConstructionUpdate) => model.save(row, patch);
  return <div className="border-b border-theme-border/50 last:border-b-0"><div style={WORKFLOW_GRID_STYLE} className={gridClass}>
    <span>{dragHandle}</span>
    <span className="text-sm font-medium text-primary">{label}</span>
    <span className="w-fit rounded-full border border-accent/25 bg-accent/10 px-2 py-1 text-xs text-accent">施工</span>
    <label className="flex items-center gap-2 text-xs text-secondary"><input aria-label={`${label}人工完工`} title="人工完工" type="checkbox" checked={row.is_completed} disabled={disabled} onChange={event => void save(constructionCompletionPatch(event.target.checked, event.target.checked ? null : row.actual_completed_date, today))} />{statusLabels[status]}</label>
    <QuickBusinessDateInput label={`${label}進場日期`} today={today} value={row.planned_start_date} disabled={disabled} onCommit={date => {
      void save(date && date > today && row.is_completed
        ? { planned_start_date: date, is_completed: false, actual_completed_date: null }
        : { planned_start_date: date });
    }} />
    <ConstructionCompletionDateInput value={getConstructionEndDate(row)} today={today} isCompleted={row.is_completed} disabled={disabled} onCommit={date => {
      void save(row.is_completed ? constructionCompletionPatch(true, date, today) : { planned_end_date: date });
    }} />
    <input aria-label={`${label}備註`} className={inputClass} value={notes} disabled={disabled} onChange={event => setNotes(event.target.value)} onBlur={() => { if (notes !== (row.notes ?? '')) void save({ notes: notes || null }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <span />
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
      <ContractorSelect contractors={model.contractors} workType="other" workName={name} value={values.contractor_id ?? null} disabled={model.busy} onChange={(id, name) => setValues(current => ({ ...current, contractor_id: id, contractor_name: name }))} />
      <label className="text-xs text-secondary">進場日期<input type="date" className={inputClass} disabled={model.busy} onChange={event => setValues(current => ({ ...current, planned_start_date: event.target.value || null }))} /></label>
      <label className="text-xs text-secondary">完工日期<input type="date" className={inputClass} disabled={model.busy} onChange={event => setValues(current => ({ ...current, planned_end_date: event.target.value || null }))} /></label>
      <label className="text-xs text-secondary">備註<input className={inputClass} disabled={model.busy} onChange={event => setValues(current => ({ ...current, notes: event.target.value || null }))} /></label>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <button type="submit" disabled={model.busy} className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50">新增工項</button>
  </form>;
}
