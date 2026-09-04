"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, ListChecks, Plus, Trash2, X } from 'lucide-react';
import { dbAdapter } from '@/lib/db';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import type {
  ProjectMilestone,
  ProjectMilestoneStatus,
  ProjectWorkflow as ProjectWorkflowData,
  WorkflowPhase,
  WorkflowType,
} from '@/lib/db/types';
import {
  getCurrentAndNextMilestones,
  getCustomInsertSortOrder,
  getMilestoneCapabilities,
  normalizeMilestoneCompletion,
  sortWorkflowMilestones,
} from '@/lib/project-workflow';

const STATUS_OPTIONS: { value: ProjectMilestoneStatus; label: string }[] = [
  { value: 'NOT_STARTED', label: '未開始' },
  { value: 'IN_PROGRESS', label: '進行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'BLOCKED', label: '卡住' },
];

const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(option => [option.value, option.label])) as Record<ProjectMilestoneStatus, string>;

type MilestoneDraft = Pick<ProjectMilestone,
  'label' | 'source_phase_id' | 'source_type_id' | 'planned_date' | 'actual_date' | 'notes' | 'status' | 'is_applicable'
> & { after_milestone_id: string | null };

function createDraft(milestone: ProjectMilestone, ordered: ProjectMilestone[]): MilestoneDraft {
  const index = ordered.findIndex(row => row.id === milestone.id);
  return {
    label: milestone.label,
    source_phase_id: milestone.source_phase_id,
    source_type_id: milestone.source_type_id,
    planned_date: milestone.planned_date,
    actual_date: milestone.actual_date,
    notes: milestone.notes,
    status: milestone.status,
    is_applicable: milestone.is_applicable,
    after_milestone_id: index > 0 ? ordered[index - 1].id : null,
  };
}

export function ProjectWorkflow({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [workflow, setWorkflow] = useState<ProjectWorkflowData>({ instance: null, milestones: [] });
  const [phases, setPhases] = useState<WorkflowPhase[]>([]);
  const [types, setTypes] = useState<WorkflowType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MilestoneDraft | null>(null);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWorkflow = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [workflowResult, phaseResult, typeResult] = await Promise.all([
        dbAdapter.getProjectWorkflow(projectId),
        dbAdapter.getWorkflowPhases(),
        dbAdapter.getWorkflowTypes(),
      ]);
      setWorkflow(workflowResult as ProjectWorkflowData);
      setPhases(phaseResult as WorkflowPhase[]);
      setTypes(typeResult as WorkflowType[]);
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '無法載入專案流程'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);

  const orderedMilestones = useMemo(
    () => sortWorkflowMilestones(workflow.milestones),
    [workflow.milestones],
  );
  const visibleMilestones = hideCompleted
    ? orderedMilestones.filter(milestone => milestone.status !== 'COMPLETED')
    : orderedMilestones;
  const summary = useMemo(() => getCurrentAndNextMilestones(orderedMilestones), [orderedMilestones]);

  const initialize = async () => {
    setIsInitializing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await dbAdapter.initializeProjectWorkflow(projectId);
      setNotice(result.result === 'already_initialized' ? '專案流程已存在，已重新載入。' : '專案流程已建立。');
      await loadWorkflow();
    } catch (initializeError) {
      setError(getDatabaseErrorMessage(initializeError, '建立專案流程失敗'));
    } finally {
      setIsInitializing(false);
    }
  };

  const openEditor = (milestone: ProjectMilestone) => {
    if (!canEdit) return;
    if (expandedId === milestone.id) {
      setExpandedId(null);
      setDraft(null);
      return;
    }
    setExpandedId(milestone.id);
    setDraft(createDraft(milestone, orderedMilestones));
    setError(null);
    setNotice(null);
  };

  const saveMilestone = async (milestone: ProjectMilestone) => {
    if (!draft) return;
    setSavingId(milestone.id);
    setError(null);
    setNotice(null);
    try {
      const completion = normalizeMilestoneCompletion(draft.status, draft.actual_date);
      const capabilities = getMilestoneCapabilities(milestone.origin);
      await dbAdapter.updateProjectMilestone(milestone.id, {
        is_applicable: draft.is_applicable,
        status: completion.status,
        planned_date: draft.planned_date || null,
        actual_date: completion.actual_date,
        notes: draft.notes?.trim() || null,
        ...(capabilities.editIdentity ? {
          label: draft.label.trim(),
          source_phase_id: draft.source_phase_id,
          source_type_id: draft.source_type_id,
          sort_order: getCustomInsertSortOrder(
            orderedMilestones.filter(row => row.id !== milestone.id),
            draft.after_milestone_id,
          ),
        } : {}),
      });
      setExpandedId(null);
      setDraft(null);
      setNotice('流程項目已儲存。');
      await loadWorkflow();
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '儲存流程項目失敗'));
    } finally {
      setSavingId(null);
    }
  };

  const softDelete = async (milestone: ProjectMilestone) => {
    if (!window.confirm(`確定刪除臨時項目「${milestone.label}」嗎？`)) return;
    setSavingId(milestone.id);
    setError(null);
    try {
      await dbAdapter.softDeleteProjectCustomMilestone(milestone.id);
      setExpandedId(null);
      setDraft(null);
      setNotice('臨時項目已刪除。');
      await loadWorkflow();
    } catch (deleteError) {
      setError(getDatabaseErrorMessage(deleteError, '刪除臨時項目失敗'));
    } finally {
      setSavingId(null);
    }
  };

  if (isLoading) return <div className="py-16 text-center text-secondary">專案流程載入中...</div>;

  if (!workflow.instance) {
    return (
      <div className="flex min-h-[22rem] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-dashed border-theme-border bg-page/30 p-8 text-center">
          <ListChecks className="mx-auto mb-3 text-secondary" size={32} />
          <h3 className="font-semibold text-primary">此案場尚未建立專案流程</h3>
          <p className="mt-2 text-sm text-secondary">建立後會從目前的預設範本產生獨立快照，之後不會被範本修改覆蓋。</p>
          {error && <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>}
          {canEdit ? (
            <button type="button" onClick={() => void initialize()} disabled={isInitializing} className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">
              {isInitializing ? '建立中...' : '建立專案流程'}
            </button>
          ) : <p className="mt-4 text-xs text-secondary">請由可編輯成員建立流程。</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="目前" milestone={summary.current} />
        <SummaryCard label="接下來" milestone={summary.next} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-border bg-page/30 px-4 py-3">
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input type="checkbox" checked={hideCompleted} onChange={event => setHideCompleted(event.target.checked)} className="h-4 w-4 accent-accent" />
          隱藏已完成
        </label>
        {canEdit && (
          <button type="button" onClick={() => setShowCreate(true)} disabled={!phases.length || !types.length} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">
            <Plus size={16} />新增臨時項目
          </button>
        )}
      </div>

      {error && <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"><CircleAlert size={17} className="mt-0.5 shrink-0" />{error}</div>}
      {notice && <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">{notice}</div>}

      <div className="overflow-hidden rounded-xl border border-theme-border bg-card/40">
        {visibleMilestones.length === 0 ? (
          <div className="p-10 text-center text-sm text-secondary">目前篩選下沒有流程項目。</div>
        ) : <>
          <div className="grid grid-cols-[minmax(12rem,1fr)_7rem_7rem_8rem_8rem_5rem_1.5rem] gap-3 border-b border-theme-border bg-card px-4 py-2 text-xs font-semibold text-secondary">
            <span>項目</span><span>Type</span><span>狀態</span><span>預計日期</span><span>完成日期</span><span>適用</span><span />
          </div>
          {visibleMilestones.map((milestone, index) => {
          const previous = visibleMilestones[index - 1];
          const showPhase = !previous || previous.phase_key_snapshot !== milestone.phase_key_snapshot;
          const isExpanded = expandedId === milestone.id && draft;
          const capabilities = getMilestoneCapabilities(milestone.origin);
          return (
            <div key={milestone.id}>
              {showPhase && <div className="border-b border-theme-border bg-page/60 px-4 py-2 text-xs font-bold uppercase tracking-wider text-secondary">{milestone.phase_name_snapshot}</div>}
              <div className={`${milestone.is_applicable ? '' : 'opacity-55'} border-b border-theme-border/60 last:border-b-0`}>
                <button type="button" onClick={() => openEditor(milestone)} className={`grid w-full grid-cols-[minmax(12rem,1fr)_7rem_7rem_8rem_8rem_5rem_1.5rem] items-center gap-3 px-4 py-3 text-left ${canEdit ? 'hover:bg-page/50' : 'cursor-default'}`}>
                  <span className="truncate font-medium text-primary">{milestone.label}</span>
                  <span className="w-fit rounded-full border border-accent/25 bg-accent/10 px-2 py-1 text-xs text-accent">{milestone.type_name_snapshot}</span>
                  <span className="text-sm text-secondary">{STATUS_LABEL[milestone.status]}</span>
                  <span className="text-sm text-secondary">{milestone.planned_date || '—'}</span>
                  <span className="text-sm text-secondary">{milestone.actual_date || '—'}</span>
                  <span className="text-xs text-secondary">{milestone.is_applicable ? '適用' : '不適用'}</span>
                  {canEdit ? (isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : <span />}
                </button>

                {isExpanded && (
                  <div className="border-t border-theme-border/60 bg-page/25 p-4">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      {capabilities.editIdentity && <TextField label="項目名稱" value={draft.label} onChange={value => setDraft({ ...draft, label: value })} />}
                      {capabilities.editIdentity && <SelectField label="Phase" value={draft.source_phase_id} onChange={value => setDraft({ ...draft, source_phase_id: value })} options={phases.map(phase => ({ value: phase.id, label: phase.name }))} />}
                      {capabilities.editIdentity && <SelectField label="Type" value={draft.source_type_id} onChange={value => setDraft({ ...draft, source_type_id: value })} options={types.map(type => ({ value: type.id, label: type.name }))} />}
                      {capabilities.changePosition && <SelectField label="插入位置" value={draft.after_milestone_id ?? ''} onChange={value => setDraft({ ...draft, after_milestone_id: value || null })} options={[{ value: '', label: '最前面' }, ...orderedMilestones.filter(row => row.id !== milestone.id).map(row => ({ value: row.id, label: `在「${row.label}」之後` }))]} />}
                      <SelectField label="狀態" value={draft.status} onChange={value => {
                        const normalized = normalizeMilestoneCompletion(value as ProjectMilestoneStatus, draft.actual_date);
                        setDraft({ ...draft, ...normalized });
                      }} options={STATUS_OPTIONS} />
                      <TextField type="date" label="預計日期" value={draft.planned_date || ''} onChange={value => setDraft({ ...draft, planned_date: value || null })} />
                      <TextField type="date" label="實際完成日期" value={draft.actual_date || ''} onChange={value => setDraft({ ...draft, actual_date: value || null, status: !value && draft.status === 'COMPLETED' ? 'IN_PROGRESS' : draft.status })} disabled={draft.status !== 'COMPLETED'} />
                      <label className="flex items-end gap-2 pb-2 text-sm text-secondary"><input type="checkbox" checked={draft.is_applicable} onChange={event => setDraft({ ...draft, is_applicable: event.target.checked })} className="h-4 w-4 accent-accent" />適用於本案</label>
                      <label className="col-span-2 text-xs text-secondary md:col-span-4">備註<textarea value={draft.notes || ''} onChange={event => setDraft({ ...draft, notes: event.target.value })} className="mt-1 min-h-20 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent" /></label>
                    </div>
                    <div className="mt-4 flex justify-between gap-3">
                      <div>{capabilities.softDelete && <button type="button" onClick={() => void softDelete(milestone)} disabled={savingId === milestone.id} className="flex items-center gap-1 rounded-lg border border-danger/30 px-3 py-2 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"><Trash2 size={15} />刪除臨時項目</button>}</div>
                      <div className="flex gap-2"><button type="button" onClick={() => { setExpandedId(null); setDraft(null); }} className="rounded-lg border border-theme-border px-3 py-2 text-sm text-secondary hover:bg-card">取消</button><button type="button" onClick={() => void saveMilestone(milestone)} disabled={savingId === milestone.id || !draft.label.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">{savingId === milestone.id ? '儲存中...' : '儲存'}</button></div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
          })}
        </>}
      </div>

      {showCreate && <CreateCustomMilestoneDialog projectId={projectId} milestones={orderedMilestones} phases={phases} types={types} onClose={() => setShowCreate(false)} onCreated={async () => { setShowCreate(false); setNotice('臨時項目已新增。'); await loadWorkflow(); }} onError={setError} />}
    </div>
  );
}

function SummaryCard({ label, milestone }: { label: string; milestone: ProjectMilestone | null }) {
  return <div className="rounded-xl border border-theme-border bg-page/30 p-3"><div className="text-xs font-semibold text-secondary">{label}</div><div className="mt-1 truncate text-sm font-medium text-primary">{milestone?.label ?? '—'}</div>{milestone && <div className="mt-1 text-xs text-secondary">{STATUS_LABEL[milestone.status]} · {milestone.phase_name_snapshot}</div>}</div>;
}

function TextField({ label, value, onChange, type = 'text', disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean }) {
  return <label className="text-xs text-secondary">{label}<input type={type} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent disabled:opacity-50" /></label>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return <label className="text-xs text-secondary">{label}<select value={value} onChange={event => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent">{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function CreateCustomMilestoneDialog({ projectId, milestones, phases, types, onClose, onCreated, onError }: { projectId: string; milestones: ProjectMilestone[]; phases: WorkflowPhase[]; types: WorkflowType[]; onClose: () => void; onCreated: () => Promise<void>; onError: (message: string) => void }) {
  const [label, setLabel] = useState('');
  const [phaseId, setPhaseId] = useState(phases[0]?.id ?? '');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [afterId, setAfterId] = useState<string | null>(milestones.at(-1)?.id ?? null);
  const [plannedDate, setPlannedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    onError('');
    try {
      await dbAdapter.createProjectCustomMilestone({
        project_id: projectId,
        label: label.trim(),
        source_phase_id: phaseId,
        source_type_id: typeId,
        sort_order: getCustomInsertSortOrder(milestones, afterId),
        planned_date: plannedDate || null,
        notes: notes.trim() || null,
      });
      await onCreated();
    } catch (createError) {
      onError(getDatabaseErrorMessage(createError, '新增臨時項目失敗'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-page/80 p-4 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-xl rounded-2xl border border-theme-border bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between"><h3 className="text-lg font-bold text-primary">新增臨時項目</h3><button type="button" onClick={onClose} className="rounded-full p-2 text-secondary hover:bg-page"><X size={20} /></button></div>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><TextField label="項目名稱" value={label} onChange={setLabel} /></div>
          <SelectField label="Phase" value={phaseId} onChange={setPhaseId} options={phases.map(phase => ({ value: phase.id, label: phase.name }))} />
          <SelectField label="Type" value={typeId} onChange={setTypeId} options={types.map(type => ({ value: type.id, label: type.name }))} />
          <div className="col-span-2"><SelectField label="插入位置" value={afterId ?? ''} onChange={value => setAfterId(value || null)} options={[{ value: '', label: '最前面' }, ...milestones.map(row => ({ value: row.id, label: `在「${row.label}」之後` }))]} /></div>
          <TextField type="date" label="預計日期（可空）" value={plannedDate} onChange={setPlannedDate} />
          <div />
          <label className="col-span-2 text-xs text-secondary">備註（可空）<textarea value={notes} onChange={event => setNotes(event.target.value)} className="mt-1 min-h-24 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent" /></label>
        </div>
        <div className="mt-5 flex justify-end gap-3 border-t border-theme-border pt-4"><button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-4 py-2 text-sm text-secondary hover:bg-page">取消</button><button type="submit" disabled={isSaving || !label.trim() || !phaseId || !typeId} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">{isSaving ? '新增中...' : '新增'}</button></div>
      </form>
    </div>
  );
}
