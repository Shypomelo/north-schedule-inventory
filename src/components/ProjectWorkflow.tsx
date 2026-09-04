"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, GripVertical, ListChecks, MoreHorizontal, Play, Plus, X } from 'lucide-react';
import { dbAdapter } from '@/lib/db';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import type {
  ActivityActionType,
  ProjectMilestone,
  ProjectMilestoneStatus,
  ProjectMilestoneUpdate,
  ProjectWorkflow as ProjectWorkflowData,
  WorkflowPhase,
  WorkflowType,
} from '@/lib/db/types';
import {
  buildWorkflowActivityLog,
  getCurrentAndNextMilestones,
  getCustomInsertSortOrder,
  getMilestoneCapabilities,
  getVisibleWorkflowMilestones,
  normalizeMilestoneCompletion,
  reorderWorkflowMilestones,
  sortWorkflowMilestones,
} from '@/lib/project-workflow';
import { logWorkflowActivitySafely } from '@/lib/workflow-activity';

const STATUS_OPTIONS: { value: ProjectMilestoneStatus; label: string }[] = [
  { value: 'NOT_STARTED', label: '未開始' },
  { value: 'IN_PROGRESS', label: '進行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'BLOCKED', label: '卡住' },
];

const STATUS_LABEL = Object.fromEntries(
  STATUS_OPTIONS.map(option => [option.value, option.label]),
) as Record<ProjectMilestoneStatus, string>;

interface ProjectWorkflowProps {
  projectId: string;
  projectName: string;
  canEdit: boolean;
  actor: { id: string; name: string } | null;
}

type WorkflowMutationAction = Extract<ActivityActionType, `WORKFLOW_${string}`>;

export function ProjectWorkflow({ projectId, projectName, canEdit, actor }: ProjectWorkflowProps) {
  const [workflow, setWorkflow] = useState<ProjectWorkflowData>({ instance: null, milestones: [] });
  const [phases, setPhases] = useState<WorkflowPhase[]>([]);
  const [types, setTypes] = useState<WorkflowType[]>([]);
  const [notesDrafts, setNotesDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [editingCustom, setEditingCustom] = useState<ProjectMilestone | null>(null);
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
      const nextWorkflow = workflowResult as ProjectWorkflowData;
      setWorkflow(nextWorkflow);
      setPhases(phaseResult as WorkflowPhase[]);
      setTypes(typeResult as WorkflowType[]);
      setNotesDrafts(Object.fromEntries(
        nextWorkflow.milestones.map(milestone => [milestone.id, milestone.notes ?? '']),
      ));
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '無法載入專案流程'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);

  useEffect(() => {
    if (!menuId) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuId(null);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuId]);

  const orderedMilestones = useMemo(
    () => sortWorkflowMilestones(workflow.milestones),
    [workflow.milestones],
  );
  const visibleMilestones = useMemo(
    () => getVisibleWorkflowMilestones(orderedMilestones, hideCompleted),
    [hideCompleted, orderedMilestones],
  );
  const summary = useMemo(
    () => getCurrentAndNextMilestones(orderedMilestones),
    [orderedMilestones],
  );

  const activityLog = (
    action: WorkflowMutationAction,
    targetType: 'PROJECT_WORKFLOW' | 'PROJECT_MILESTONE',
    targetId: string,
    targetLabel: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) => buildWorkflowActivityLog({
    action,
    targetType,
    targetId,
    targetLabel,
    projectId,
    projectName,
    actorUserId: actor?.id ?? 'system',
    actorName: actor?.name ?? 'System',
    before,
    after,
  });

  const initialize = async () => {
    setIsInitializing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await dbAdapter.initializeProjectWorkflow(projectId);
      setNotice(result.result === 'already_initialized' ? '專案流程已存在，已重新載入。' : '專案流程已建立。');
      if (result.result === 'created') {
        void logWorkflowActivitySafely(activityLog(
          'WORKFLOW_INITIALIZED', 'PROJECT_WORKFLOW', result.workflow_instance_id, '專案流程',
          null, { milestones_created: result.milestones_created },
        ));
      }
      await loadWorkflow();
    } catch (initializeError) {
      setError(getDatabaseErrorMessage(initializeError, '建立專案流程失敗'));
    } finally {
      setIsInitializing(false);
    }
  };

  const persistMilestone = async (
    milestone: ProjectMilestone,
    updates: ProjectMilestoneUpdate,
    action: WorkflowMutationAction,
  ): Promise<boolean> => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const source = milestone as unknown as Record<string, unknown>;
    Object.entries(updates).forEach(([key, value]) => {
      if (source[key] !== value) {
        before[key] = source[key];
        after[key] = value;
      }
    });
    if (Object.keys(after).length === 0) return true;

    setSavingId(milestone.id);
    setError(null);
    setNotice(null);
    setWorkflow(current => ({
      ...current,
      milestones: current.milestones.map(row => (
        row.id === milestone.id ? { ...row, ...updates } as ProjectMilestone : row
      )),
    }));

    try {
      const updated = await dbAdapter.updateProjectMilestone(milestone.id, updates);
      setWorkflow(current => ({
        ...current,
        milestones: current.milestones.map(row => row.id === milestone.id ? updated : row),
      }));
      setNotesDrafts(current => ({ ...current, [milestone.id]: updated.notes ?? '' }));
      setNotice('流程項目已更新。');
      void logWorkflowActivitySafely(activityLog(
        action, 'PROJECT_MILESTONE', milestone.id, updated.label, before, after,
      ));
      return true;
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '更新流程項目失敗'));
      await loadWorkflow();
      return false;
    } finally {
      setSavingId(null);
    }
  };

  const changeStatus = async (milestone: ProjectMilestone, status: ProjectMilestoneStatus) => {
    const completion = normalizeMilestoneCompletion(status, milestone.actual_date);
    await persistMilestone(milestone, completion, 'WORKFLOW_STATUS_CHANGED');
  };

  const changeActualDate = async (milestone: ProjectMilestone, actualDate: string | null) => {
    const updates: ProjectMilestoneUpdate = actualDate
      ? { actual_date: actualDate, status: 'COMPLETED' }
      : { actual_date: null, ...(milestone.status === 'COMPLETED' ? { status: 'IN_PROGRESS' as const } : {}) };
    await persistMilestone(milestone, updates, 'WORKFLOW_ACTUAL_DATE_CHANGED');
  };

  const saveNotes = async (milestone: ProjectMilestone) => {
    const notes = notesDrafts[milestone.id]?.trim() || null;
    await persistMilestone(milestone, { notes }, 'WORKFLOW_NOTES_CHANGED');
  };

  const saveCustomIdentity = async (
    milestone: ProjectMilestone,
    values: Pick<ProjectMilestoneUpdate, 'label' | 'source_phase_id' | 'source_type_id'>,
  ) => {
    const updates: ProjectMilestoneUpdate = { ...values };
    if (values.source_phase_id !== milestone.source_phase_id) {
      const targetPhase = orderedMilestones.filter(row => (
        row.id !== milestone.id && row.source_phase_id === values.source_phase_id
      ));
      const lastInTargetPhase = targetPhase.at(-1);
      updates.sort_order = getCustomInsertSortOrder(
        orderedMilestones.filter(row => row.id !== milestone.id),
        lastInTargetPhase?.id ?? orderedMilestones.at(-1)?.id ?? null,
      );
    }
    const saved = await persistMilestone(milestone, updates, 'WORKFLOW_CUSTOM_UPDATED');
    if (saved) setEditingCustom(null);
  };

  const softDelete = async (milestone: ProjectMilestone) => {
    setMenuId(null);
    if (!window.confirm('確定刪除此臨時項目？')) return;
    setSavingId(milestone.id);
    setError(null);
    setWorkflow(current => ({
      ...current,
      milestones: current.milestones.filter(row => row.id !== milestone.id),
    }));
    try {
      await dbAdapter.softDeleteProjectCustomMilestone(milestone.id);
      setNotice('臨時項目已刪除。');
      void logWorkflowActivitySafely(activityLog(
        'WORKFLOW_CUSTOM_DELETED', 'PROJECT_MILESTONE', milestone.id, milestone.label,
        { deleted_at: null }, { deleted_at: 'soft_deleted' },
      ));
    } catch (deleteError) {
      setError(getDatabaseErrorMessage(deleteError, '刪除臨時項目失敗'));
      await loadWorkflow();
    } finally {
      setSavingId(null);
    }
  };

  const dropMilestone = async (targetId: string) => {
    if (!draggedId || draggedId === targetId || isReordering) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const beforeOrder = orderedMilestones.map(milestone => milestone.id);
    let reordered: ProjectMilestone[];
    try {
      reordered = reorderWorkflowMilestones(orderedMilestones, draggedId, targetId);
    } catch (dragError) {
      setError(dragError instanceof Error ? dragError.message : '流程排序失敗');
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const changed = reordered.filter(milestone => (
      milestone.sort_order !== orderedMilestones.find(row => row.id === milestone.id)?.sort_order
    ));
    setWorkflow(current => ({ ...current, milestones: reordered }));
    setDraggedId(null);
    setDragOverId(null);
    setIsReordering(true);
    setError(null);

    try {
      await dbAdapter.reorderProjectMilestones(
        changed.map(milestone => ({ id: milestone.id, sort_order: milestone.sort_order })),
      );
      setNotice('流程順序已調整。');
      if (workflow.instance) {
        void logWorkflowActivitySafely(activityLog(
          'WORKFLOW_REORDERED', 'PROJECT_WORKFLOW', workflow.instance.id, '專案流程',
          { order: beforeOrder }, { order: reordered.map(milestone => milestone.id) },
        ));
      }
    } catch (reorderError) {
      setError(getDatabaseErrorMessage(reorderError, '流程排序失敗，已重新載入目前順序'));
      await loadWorkflow();
    } finally {
      setIsReordering(false);
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
          {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-border bg-page/30 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <SummaryItem label="目前" milestone={summary.current} />
          <SummaryItem label="接下來" milestone={summary.next} />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input type="checkbox" checked={hideCompleted} onChange={event => setHideCompleted(event.target.checked)} className="h-4 w-4 accent-accent" />
            隱藏已完成
          </label>
          {canEdit ? (
            <button type="button" onClick={() => setShowCreate(true)} disabled={!phases.length || !types.length} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">
              <Plus size={16} />新增臨時項目
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"><CircleAlert size={17} className="mt-0.5 shrink-0" />{error}</div> : null}
      {notice ? <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">{notice}</div> : null}

      <div className="overflow-x-auto rounded-xl border border-theme-border bg-card/40">
        {visibleMilestones.length === 0 ? (
          <div className="p-10 text-center text-sm text-secondary">目前篩選下沒有流程項目。</div>
        ) : (
          <div className="min-w-[64rem]">
            <div className="grid grid-cols-[2rem_minmax(12rem,1fr)_5.5rem_10rem_8.5rem_8.5rem_minmax(11rem,1fr)_3rem] gap-2 border-b border-theme-border bg-card px-3 py-2 text-xs font-semibold text-secondary">
              <span /><span>項目</span><span>類型</span><span>狀態</span><span>預計日期</span><span>實際日期</span><span>備註</span><span>操作</span>
            </div>
            {visibleMilestones.map((milestone, index) => {
              const previous = visibleMilestones[index - 1];
              const showPhase = !previous || previous.phase_key_snapshot !== milestone.phase_key_snapshot;
              const isSaving = savingId === milestone.id;
              const capabilities = getMilestoneCapabilities(milestone.origin);
              const dragged = orderedMilestones.find(row => row.id === draggedId);
              const canDrop = dragged?.phase_key_snapshot === milestone.phase_key_snapshot;
              return (
                <div key={milestone.id}>
                  {showPhase ? <div className="border-b border-theme-border bg-page/60 px-3 py-1.5 text-xs font-bold tracking-wide text-secondary">{milestone.phase_name_snapshot}</div> : null}
                  <div
                    onDragOver={event => {
                      if (canDrop) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDragOverId(milestone.id);
                      }
                    }}
                    onDragLeave={() => setDragOverId(current => current === milestone.id ? null : current)}
                    onDrop={event => { event.preventDefault(); void dropMilestone(milestone.id); }}
                    className={`${milestone.is_applicable ? '' : 'opacity-55'} ${dragOverId === milestone.id && canDrop ? 'bg-accent/10' : ''} grid grid-cols-[2rem_minmax(12rem,1fr)_5.5rem_10rem_8.5rem_8.5rem_minmax(11rem,1fr)_3rem] items-center gap-2 border-b border-theme-border/60 px-3 py-2 last:border-b-0`}
                  >
                    <button
                      type="button"
                      draggable={canEdit && !isReordering}
                      onDragStart={event => {
                        event.dataTransfer.effectAllowed = 'move';
                        setDraggedId(milestone.id);
                        setNotice(null);
                        setError(null);
                      }}
                      onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                      disabled={!canEdit || isReordering}
                      aria-label={`拖曳排序：${milestone.label}`}
                      title="只可在同一階段內拖曳排序"
                      className="cursor-grab rounded p-1 text-secondary hover:bg-page hover:text-primary disabled:cursor-default disabled:opacity-40 active:cursor-grabbing"
                    >
                      <GripVertical size={17} />
                    </button>
                    <span className="truncate font-medium text-primary" title={milestone.label}>{milestone.label}</span>
                    <span className="w-fit rounded-full border border-accent/25 bg-accent/10 px-2 py-1 text-xs text-accent">{milestone.type_name_snapshot}</span>
                    <div className="flex items-center gap-1">
                      <select value={milestone.status} onChange={event => void changeStatus(milestone, event.target.value as ProjectMilestoneStatus)} disabled={!canEdit || isSaving} aria-label={`${milestone.label}狀態`} className="min-w-0 flex-1 rounded-md border border-theme-border bg-page px-2 py-1.5 text-xs text-primary outline-none focus:border-accent disabled:opacity-50">
                        {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                      {milestone.status === 'NOT_STARTED' ? (
                        <button type="button" onClick={() => void changeStatus(milestone, 'IN_PROGRESS')} disabled={!canEdit || isSaving} aria-label={`開始${milestone.label}`} title="開始" className="rounded-md border border-accent/30 p-1.5 text-accent hover:bg-accent/10 disabled:opacity-50"><Play size={14} /></button>
                      ) : milestone.status === 'IN_PROGRESS' ? (
                        <button type="button" onClick={() => void changeStatus(milestone, 'COMPLETED')} disabled={!canEdit || isSaving} aria-label={`完成${milestone.label}`} title="完成" className="rounded-md border border-success/30 p-1.5 text-success hover:bg-success/10 disabled:opacity-50"><Check size={14} /></button>
                      ) : null}
                    </div>
                    <input type="date" value={milestone.planned_date ?? ''} onChange={event => void persistMilestone(milestone, { planned_date: event.target.value || null }, 'WORKFLOW_PLANNED_DATE_CHANGED')} disabled={!canEdit || isSaving} aria-label={`${milestone.label}預計日期`} className="w-full rounded-md border border-theme-border bg-page px-2 py-1.5 text-xs text-primary outline-none focus:border-accent disabled:opacity-50" />
                    <input type="date" value={milestone.actual_date ?? ''} onChange={event => void changeActualDate(milestone, event.target.value || null)} disabled={!canEdit || isSaving} aria-label={`${milestone.label}實際日期`} className="w-full rounded-md border border-theme-border bg-page px-2 py-1.5 text-xs text-primary outline-none focus:border-accent disabled:opacity-50" />
                    <input type="text" value={notesDrafts[milestone.id] ?? ''} onChange={event => setNotesDrafts(current => ({ ...current, [milestone.id]: event.target.value }))} onBlur={() => void saveNotes(milestone)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} disabled={!canEdit || isSaving} aria-label={`${milestone.label}備註`} placeholder="輸入備註" className="w-full rounded-md border border-theme-border bg-page px-2 py-1.5 text-xs text-primary outline-none focus:border-accent disabled:opacity-50" />
                    <div ref={menuId === milestone.id ? menuRef : undefined} className="relative flex justify-end">
                      {canEdit ? <button type="button" onClick={() => setMenuId(current => current === milestone.id ? null : milestone.id)} aria-label={`${milestone.label}操作`} aria-haspopup="menu" aria-expanded={menuId === milestone.id} className="rounded-md p-1.5 text-secondary hover:bg-page hover:text-primary"><MoreHorizontal size={17} /></button> : null}
                      {menuId === milestone.id ? (
                        <div role="menu" className="absolute right-0 top-8 z-30 w-44 rounded-lg border border-theme-border bg-card p-1 shadow-xl">
                          <button type="button" onClick={() => { setMenuId(null); void persistMilestone(milestone, { is_applicable: !milestone.is_applicable }, 'WORKFLOW_APPLICABILITY_CHANGED'); }} className="w-full rounded-md px-3 py-2 text-left text-sm text-primary hover:bg-page">設為{milestone.is_applicable ? '不適用' : '適用'}</button>
                          {capabilities.editIdentity ? <button type="button" onClick={() => { setMenuId(null); setEditingCustom(milestone); }} className="w-full rounded-md px-3 py-2 text-left text-sm text-primary hover:bg-page">編輯臨時項目</button> : null}
                          {capabilities.softDelete ? <button type="button" onClick={() => void softDelete(milestone)} className="w-full rounded-md px-3 py-2 text-left text-sm text-danger hover:bg-danger/10">刪除臨時項目</button> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showCreate ? (
        <CreateCustomMilestoneDialog projectId={projectId} milestones={orderedMilestones} phases={phases} types={types} onClose={() => setShowCreate(false)} onCreated={async created => {
          setShowCreate(false);
          setNotice('臨時項目已新增。');
          void logWorkflowActivitySafely(activityLog(
            'WORKFLOW_CUSTOM_CREATED', 'PROJECT_MILESTONE', created.id, created.label, null,
            { label: created.label, phase: created.phase_name_snapshot, type: created.type_name_snapshot },
          ));
          await loadWorkflow();
        }} onError={setError} />
      ) : null}

      {editingCustom ? <EditCustomMilestoneDialog milestone={editingCustom} phases={phases} types={types} isSaving={savingId === editingCustom.id} onClose={() => setEditingCustom(null)} onSave={values => saveCustomIdentity(editingCustom, values)} /> : null}
    </div>
  );
}

function SummaryItem({ label, milestone }: { label: string; milestone: ProjectMilestone | null }) {
  return <span className="min-w-0 text-secondary"><span className="font-semibold">{label}：</span><span className="font-medium text-primary">{milestone?.label ?? '—'}</span>{milestone ? <span className="ml-1 text-xs">({STATUS_LABEL[milestone.status]})</span> : null}</span>;
}

function TextField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <label className="text-xs text-secondary">{label}<input type={type} value={value} onChange={event => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent" /></label>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return <label className="text-xs text-secondary">{label}<select value={value} onChange={event => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent">{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

interface CreateDialogProps {
  projectId: string;
  milestones: ProjectMilestone[];
  phases: WorkflowPhase[];
  types: WorkflowType[];
  onClose: () => void;
  onCreated: (milestone: ProjectMilestone) => Promise<void>;
  onError: (message: string) => void;
}

function CreateCustomMilestoneDialog({ projectId, milestones, phases, types, onClose, onCreated, onError }: CreateDialogProps) {
  const [label, setLabel] = useState('');
  const [phaseId, setPhaseId] = useState(phases[0]?.id ?? '');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [plannedDate, setPlannedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    onError('');
    try {
      const phaseRows = milestones.filter(milestone => milestone.source_phase_id === phaseId);
      const lastInPhase = phaseRows.at(-1);
      const created = await dbAdapter.createProjectCustomMilestone({
        project_id: projectId,
        label: label.trim(),
        source_phase_id: phaseId,
        source_type_id: typeId,
        sort_order: getCustomInsertSortOrder(milestones, lastInPhase?.id ?? milestones.at(-1)?.id ?? null),
        planned_date: plannedDate || null,
        notes: notes.trim() || null,
      });
      await onCreated(created);
    } catch (createError) {
      onError(getDatabaseErrorMessage(createError, '新增臨時項目失敗'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-page/80 p-4 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-xl rounded-2xl border border-theme-border bg-card p-6 shadow-2xl">
        <DialogHeader title="新增臨時項目" onClose={onClose} />
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><TextField label="項目名稱" value={label} onChange={setLabel} /></div>
          <SelectField label="階段" value={phaseId} onChange={setPhaseId} options={phases.map(phase => ({ value: phase.id, label: phase.name }))} />
          <SelectField label="類型" value={typeId} onChange={setTypeId} options={types.map(type => ({ value: type.id, label: type.name }))} />
          <TextField type="date" label="預計日期（可空）" value={plannedDate} onChange={setPlannedDate} />
          <div />
          <label className="col-span-2 text-xs text-secondary">備註（可空）<textarea value={notes} onChange={event => setNotes(event.target.value)} className="mt-1 min-h-24 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent" /></label>
        </div>
        <DialogActions onClose={onClose} isSaving={isSaving} submitLabel="新增" disabled={!label.trim() || !phaseId || !typeId} />
      </form>
    </div>
  );
}

interface EditDialogProps {
  milestone: ProjectMilestone;
  phases: WorkflowPhase[];
  types: WorkflowType[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (updates: Pick<ProjectMilestoneUpdate, 'label' | 'source_phase_id' | 'source_type_id'>) => Promise<void>;
}

function EditCustomMilestoneDialog({ milestone, phases, types, isSaving, onClose, onSave }: EditDialogProps) {
  const [label, setLabel] = useState(milestone.label);
  const [phaseId, setPhaseId] = useState(milestone.source_phase_id);
  const [typeId, setTypeId] = useState(milestone.source_type_id);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onSave({ label: label.trim(), source_phase_id: phaseId, source_type_id: typeId });
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-page/80 p-4 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-theme-border bg-card p-6 shadow-2xl">
        <DialogHeader title="編輯臨時項目" onClose={onClose} />
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><TextField label="項目名稱" value={label} onChange={setLabel} /></div>
          <SelectField label="階段" value={phaseId} onChange={setPhaseId} options={phases.map(phase => ({ value: phase.id, label: phase.name }))} />
          <SelectField label="類型" value={typeId} onChange={setTypeId} options={types.map(type => ({ value: type.id, label: type.name }))} />
        </div>
        <DialogActions onClose={onClose} isSaving={isSaving} submitLabel="儲存" disabled={!label.trim()} />
      </form>
    </div>
  );
}

function DialogHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return <div className="mb-5 flex items-center justify-between"><h3 className="text-lg font-bold text-primary">{title}</h3><button type="button" onClick={onClose} aria-label="關閉" className="rounded-full p-2 text-secondary hover:bg-page"><X size={20} /></button></div>;
}

function DialogActions({ onClose, isSaving, submitLabel, disabled = false }: { onClose: () => void; isSaving: boolean; submitLabel: string; disabled?: boolean }) {
  return <div className="mt-5 flex justify-end gap-3 border-t border-theme-border pt-4"><button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-4 py-2 text-sm text-secondary hover:bg-page">取消</button><button type="submit" disabled={isSaving || disabled} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">{isSaving ? '儲存中...' : submitLabel}</button></div>;
}
