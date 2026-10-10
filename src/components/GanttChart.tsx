"use client";

import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Contractor, Project, ProjectConstructionProgress } from '@/lib/db/types';
import { getConstructionWorkLabel, getConstructionToday } from '@/lib/construction-progress';
import { findContractorOverlaps, getScheduledInterval, type ContractorOverlap } from '@/lib/contractor-schedule';
import { getContractorsForWorkType } from '@/lib/contractors';

interface Props {
  projects: Project[];
  allProjects: Project[];
  contractors: Contractor[];
  rows: ProjectConstructionProgress[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  canEdit: boolean;
  onSave: (row: ProjectConstructionProgress, values: Pick<ProjectConstructionProgress, 'contractor_id' | 'contractor_name' | 'planned_start_date' | 'planned_end_date'>) => Promise<boolean>;
  onRetry: () => void;
  onProjectClick?: (project: Project) => void;
}
const COLORS: Record<string, string> = {
  racking: 'bg-emerald-500 border-emerald-500', electrical: 'bg-blue-500 border-blue-500',
  steel: 'bg-purple-500 border-purple-500', roof_cover: 'bg-orange-500 border-orange-500',
  civil: 'bg-amber-500 border-amber-500', other: 'bg-slate-500 border-slate-500',
};
const dayNumber = (date: string) => Date.parse(date + 'T00:00:00Z') / 86400000;
const dateAt = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
const shortDate = (date: string) => date.replace(/-/g, '/');

export function GanttChart({ projects, allProjects, contractors, rows, loading, error, saving, canEdit, onSave, onRetry, onProjectClick }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ contractorId: string; start: string; end: string } | null>(null);
  const [view, setView] = useState<'week' | 'month'>('week');
  const [saveError, setSaveError] = useState<string | null>(null);
  const projectMap = useMemo(() => new Map(allProjects.map(project => [project.id, project])), [allProjects]);
  const visibleIds = useMemo(() => new Set(projects.map(project => project.id)), [projects]);
  const activeRows = useMemo(() => rows.filter(row => projectMap.has(row.project_id) && !row.deleted_at && row.status_override !== 'disabled'), [rows, projectMap]);
  const intervals = useMemo(() => activeRows.map(getScheduledInterval).filter((item): item is NonNullable<typeof item> => item !== null), [activeRows]);
  const invalidRows = useMemo(() => activeRows.filter(row => visibleIds.has(row.project_id) && row.planned_start_date && !getScheduledInterval(row)), [activeRows, visibleIds]);
  const overlaps = useMemo(() => findContractorOverlaps(activeRows).filter(item => visibleIds.has(item.left.row.project_id) || visibleIds.has(item.right.row.project_id)), [activeRows, visibleIds]);
  const overlapsById = useMemo(() => {
    const map = new Map<string, ContractorOverlap[]>();
    overlaps.forEach(item => {
      for (const id of [item.left.row.id, item.right.row.id]) map.set(id, [...(map.get(id) ?? []), item]);
    });
    return map;
  }, [overlaps]);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof intervals>();
    intervals.filter(item => visibleIds.has(item.row.project_id)).forEach(item => map.set(item.row.project_id, [...(map.get(item.row.project_id) ?? []), item]));
    return Array.from(map.entries()).sort((a, b) => a[1][0].start.localeCompare(b[1][0].start));
  }, [intervals, visibleIds]);
  const { firstDay, dates } = useMemo(() => {
    const today = dayNumber(getConstructionToday());
    const visible = intervals.filter(item => visibleIds.has(item.row.project_id));
    const first = visible.length ? Math.min(...visible.map(item => dayNumber(item.start))) - 3 : today - 3;
    const last = visible.length ? Math.max(...visible.map(item => dayNumber(item.end))) + 7 : today + 7;
    return { firstDay: first, dates: Array.from({ length: Math.max(1, last - first + 1) }, (_, index) => dateAt(first + index)) };
  }, [intervals, visibleIds]);
  const dayWidth = view === 'week' ? 40 : 16;
  const selected = activeRows.find(row => row.id === editingId);
  const beginEdit = (row: ProjectConstructionProgress) => {
    if (!canEdit) return;
    setEditingId(row.id);
    setDraft({ contractorId: row.contractor_id ?? '', start: row.planned_start_date ?? '', end: row.planned_end_date ?? '' });
    setSaveError(null);
  };
  const save = async () => {
    if (!selected || !draft || saving) return;
    if (draft.end && !draft.start) { setSaveError('請先填寫預計進場日期'); return; }
    if (draft.start && draft.end && draft.end < draft.start) { setSaveError('預計完工日期不可早於進場日期'); return; }
    const contractor = contractors.find(item => item.id === draft.contractorId);
    if (draft.contractorId && !contractor && draft.contractorId !== selected.contractor_id) { setSaveError('無法辨識包商'); return; }
    const ok = await onSave(selected, {
      contractor_id: draft.contractorId || null,
      contractor_name: contractor?.name ?? (draft.contractorId === selected.contractor_id ? selected.contractor_name : null),
      planned_start_date: draft.start || null,
      planned_end_date: draft.end || null,
    });
    if (ok) { setEditingId(null); setDraft(null); setSaveError(null); }
    else setSaveError('儲存失敗，請重新載入後再試');
  };
  const conflictText = (item: ContractorOverlap) => {
    const { left, right } = item;
    const vendor = contractors.find(c => c.id === left.row.contractor_id)?.name ?? left.row.contractor_name ?? left.row.contractor_id;
    const line = (work: typeof left) => `${projectMap.get(work.row.project_id)?.name ?? work.row.project_id}／${getConstructionWorkLabel(work.row as ProjectConstructionProgress)}：${shortDate(work.start)}～${shortDate(work.end)}${work.provisional ? '（暫估）' : ''}`;
    return `包商撞期：${vendor}\n${line(left)}\n${line(right)}\n重疊：${shortDate(item.start)}～${shortDate(item.end)}`;
  };
  return <div className="flex h-full flex-col overflow-hidden">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-secondary">預計施工期間・無完工日暫估至進場月份月底</span>
      <div className="flex rounded border border-theme-border" aria-label="時間檢視">
        {(['week', 'month'] as const).map(option => <button key={option} type="button" aria-pressed={view === option} className={`px-3 py-1 ${view === option ? 'bg-accent text-white' : 'text-secondary'}`} onClick={() => setView(option)}>{option === 'week' ? '週' : '月'}</button>)}
      </div>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-danger">{error} <button type="button" className="underline" onClick={onRetry}>重試</button></p>}
    {saveError && <p role="alert" className="mb-3 text-sm text-danger">{saveError}</p>}
    {!loading && invalidRows.length > 0 && <div role="alert" className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">下列工項的預計完工日早於進場日，請修正後再排入時間軸：{invalidRows.map(row => <button key={row.id} type="button" disabled={!canEdit} className="ml-2 underline disabled:no-underline" onClick={() => beginEdit(row)}>{projectMap.get(row.project_id)?.name}／{getConstructionWorkLabel(row)}</button>)}</div>}
    {!loading && overlaps.length > 0 && <div className="mb-3 rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-300">
      <strong className="flex items-center gap-1"><AlertTriangle size={16} />包商撞期警示（{overlaps.length} 組）</strong>
      <div className="mt-2 flex flex-wrap gap-2">{overlaps.map(item => <span key={item.left.row.id + ':' + item.right.row.id} className="rounded border border-red-500/30 px-2 py-1" title={conflictText(item)}>{contractors.find(c => c.id === item.left.row.contractor_id)?.name ?? item.left.row.contractor_name ?? '包商'}：{projectMap.get(item.left.row.project_id)?.name}／{getConstructionWorkLabel(item.left.row)} × {projectMap.get(item.right.row.project_id)?.name}／{getConstructionWorkLabel(item.right.row)}（{shortDate(item.start)}～{shortDate(item.end)}）</span>)}</div>
    </div>}
    {loading ? <div className="p-8 text-center text-secondary">施工資料載入中…</div> : <>
      {canEdit && activeRows.some(row => visibleIds.has(row.project_id) && !row.planned_start_date) && <div className="mb-3 flex flex-wrap gap-2 text-xs">{activeRows.filter(row => visibleIds.has(row.project_id) && !row.planned_start_date).map(row => <button key={row.id} type="button" className="rounded border border-theme-border px-2 py-1 text-secondary hover:text-primary" onClick={() => beginEdit(row)}>＋ {projectMap.get(row.project_id)?.name}／{getConstructionWorkLabel(row)} 安排施工</button>)}</div>}
      <div ref={scrollRef} className="relative flex-1 overflow-auto rounded-xl border border-theme-border/50 bg-card/20 shadow-xl">
        {grouped.length === 0 ? <div className="p-8 text-center text-secondary">目前沒有已安排施工日期的工項</div> : <div className="inline-flex min-w-full flex-col">
          <div className="sticky top-0 z-20 flex border-b border-theme-border/50 bg-card">
            <div className="sticky left-0 z-30 w-48 shrink-0 border-r border-theme-border/50 bg-card p-3 font-medium text-primary">案場／施工日期</div>
            <div className="flex" style={{ width: dates.length * dayWidth }}>{dates.map((date, index) => <div key={date} className={`shrink-0 border-r border-theme-border/20 text-center text-[10px] ${date === getConstructionToday() ? 'bg-success/20 text-success' : 'text-secondary'}`} style={{ width: dayWidth }} title={date}>{view === 'week' || index === 0 || date.endsWith('-01') ? date.slice(5).replace('-', '/') : ''}</div>)}</div>
          </div>
          {grouped.map(([projectId, items]) => {
            const project = projectMap.get(projectId)!;
            return <div key={projectId} id={`gantt-project-${projectId}`} className="relative flex border-b border-theme-border/30 hover:bg-card/60">
              <div className="sticky left-0 z-10 w-48 shrink-0 border-r border-theme-border/50 bg-card/95 p-3 text-primary backdrop-blur">
                <button type="button" className="block w-full truncate text-left font-medium hover:text-emerald-400" title={project.name} onClick={() => scrollRef.current?.scrollTo({ left: Math.max(0, (Math.min(...items.map(item => dayNumber(item.start))) - firstDay) * dayWidth - 120), behavior: 'smooth' })}>{project.name}</button>
                <div className="truncate text-xs text-secondary">{project.capacity ? `${project.capacity} kWp` : project.manager || '未填容量'}</div>
                {onProjectClick && <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => onProjectClick(project)}>查看案場</button>}
              </div>
              <div className="relative flex" style={{ width: dates.length * dayWidth, height: items.length * 30 + 16 }}>
                {dates.map(date => <div key={date} className={`shrink-0 border-r border-theme-border/10 ${date === getConstructionToday() ? 'bg-success/10' : ''}`} style={{ width: dayWidth }} />)}
                {items.map((item, index) => {
                  const conflicts = overlapsById.get(item.row.id) ?? [];
                  const vendor = contractors.find(c => c.id === item.row.contractor_id)?.name ?? item.row.contractor_name ?? '未指定包商';
                  const title = `${getConstructionWorkLabel(item.row)}（${vendor}）\n${shortDate(item.start)}～${shortDate(item.end)}${item.provisional ? '（暫估至月底）' : ''}${conflicts.length ? '\n\n' + conflicts.map(conflictText).join('\n\n') : ''}`;
                  return <button key={item.row.id} type="button" title={title} aria-label={`${project.name} ${getConstructionWorkLabel(item.row)} ${vendor}${conflicts.length ? ' 包商撞期' : ''}`} disabled={!canEdit} onClick={() => beginEdit(item.row)} className={`absolute z-[1] flex h-6 items-center overflow-hidden rounded-md border px-2 text-xs text-white shadow-sm ${conflicts.length ? 'border-2 border-red-400 bg-red-600' : COLORS[item.row.work_type]} ${canEdit ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}`} style={{ left: (dayNumber(item.start) - firstDay) * dayWidth, width: (dayNumber(item.end) - dayNumber(item.start) + 1) * dayWidth, top: 8 + index * 30 }}>
                    {conflicts.length > 0 && <AlertTriangle size={12} className="mr-1 shrink-0" />}<span className="truncate font-medium">{getConstructionWorkLabel(item.row)}{item.provisional ? ' 暫估' : ''}</span><span className="ml-1 truncate opacity-80">－{vendor}</span>
                  </button>;
                })}
              </div>
            </div>;
          })}
        </div>}
      </div>
    </>}
    {selected && draft && <div className="mt-3 rounded-xl border border-theme-border bg-card p-3 text-sm" aria-label="編輯施工排程">
      <div className="mb-2 font-medium text-primary">{projectMap.get(selected.project_id)?.name}／{getConstructionWorkLabel(selected)}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-secondary">包商<select className="block min-w-40 rounded border border-theme-border bg-page p-2 text-primary" value={draft.contractorId} disabled={saving} onChange={event => setDraft({ ...draft, contractorId: event.target.value })}><option value="">未指定</option>{selected.contractor_id && !getContractorsForWorkType(contractors, selected.work_type, false, selected.work_name).some(c => c.id === selected.contractor_id) && <option value={selected.contractor_id}>{contractors.find(c => c.id === selected.contractor_id)?.name ?? selected.contractor_name ?? '既有包商'}</option>}{getContractorsForWorkType(contractors, selected.work_type, false, selected.work_name).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="text-xs text-secondary">預計進場<input className="block rounded border border-theme-border bg-page p-2 text-primary" type="date" value={draft.start} disabled={saving} onChange={event => setDraft({ ...draft, start: event.target.value })} /></label>
        <label className="text-xs text-secondary">預計完工<input className="block rounded border border-theme-border bg-page p-2 text-primary" type="date" value={draft.end} disabled={saving} onChange={event => setDraft({ ...draft, end: event.target.value })} /></label>
        <button type="button" disabled={saving} className="rounded bg-accent px-3 py-2 text-white disabled:opacity-50" onClick={() => void save()}>{saving ? '儲存中…' : '儲存'}</button>
        <button type="button" disabled={saving} className="rounded border border-theme-border px-3 py-2 text-secondary" onClick={() => { setEditingId(null); setDraft(null); setSaveError(null); }}>取消</button>
      </div>
    </div>}
  </div>;
}
