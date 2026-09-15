"use client";

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, History, Loader2, MapPin, Trash2, Users, X } from 'lucide-react';
import type { ActivityLog, Project, ScheduleTask, ScheduleTaskMember, User, WorkGroup } from '@/lib/db/types';
import type { WeatherDisplay } from '@/lib/weather';
import { formatScheduleTaskTime } from '@/lib/schedule-selectors';
import { getScheduleCreationSourceLabel, getScheduleTaskPresentation } from '@/lib/schedule-presentation';
import { formatScheduleAuditValue, getScheduleAuditPresentation, getScheduleHistoryEntries } from '@/lib/schedule-audit';

export function ScheduleTaskDetail({
  task,
  projects,
  users,
  members,
  workGroups = [],
  activityLogs = [],
  weather,
  canMutate = false,
  actionPending = false,
  onComplete,
  onReschedule,
  onDelete,
  onClose,
}: {
  task: ScheduleTask;
  projects: Project[];
  users: User[];
  members: ScheduleTaskMember[];
  workGroups?: WorkGroup[];
  activityLogs?: ActivityLog[];
  weather: WeatherDisplay | null;
  canMutate?: boolean;
  actionPending?: boolean;
  onComplete?: () => void;
  onReschedule?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const display = getScheduleTaskPresentation(task, projects, users, members, workGroups);
  const formattedTime = formatScheduleTaskTime(task);
  const detailHeading = display.projectName || display.cardDetail;
  const detailSubtitle = display.projectName ? display.cardDetail : '';
  const audit = getScheduleAuditPresentation(task, activityLogs);
  const historyEntries = useMemo(() => getScheduleHistoryEntries(task, activityLogs), [activityLogs, task]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(Math.max(historyEntries.length - 1, 0));
  const currentHistory = historyEntries[historyIndex] || null;
  const formatAuditTime=(value:string)=>new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));

  const openHistory = () => {
    setHistoryIndex(Math.max(historyEntries.length - 1, 0));
    setHistoryOpen(true);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (historyOpen) setHistoryOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyOpen, onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="排程完整資訊">
      <section className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--modal-bg)] text-[var(--modal-text)] shadow-2xl sm:max-h-[92vh] sm:max-w-2xl sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--accent)]">排程完整資訊</p>
            <h2 className="mt-1 break-words text-xl font-bold">{detailHeading}</h2>
            {detailSubtitle && <p className="mt-1 break-words text-sm text-[var(--modal-muted)]">{detailSubtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--surface-secondary)]" aria-label="關閉排程完整資訊"><X size={22} /></button>
        </header>

        <div className="overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <DetailRow icon={<CalendarDays size={17} />} label="日期" value={task.task_date} />
            {formattedTime && <DetailRow icon={<Clock3 size={17} />} label="時間" value={formattedTime} />}
            {display.mainAssigneeName && <DetailRow label="主要負責人" value={display.mainAssigneeName} />}
            {display.collaboratorNames.length > 0 && <DetailRow icon={<Users size={17} />} label="協同人員" value={display.collaboratorNames.join('、')} />}
            <DetailRow label="天氣" value={weather ? `${weather.icon} ${weather.label}` : '無可用天氣資料'} />
            <DetailRow label="狀態" value={task.status || '未設定'} />
            <DetailRow label="排程群組" value={display.workGroupName} />
          </dl>

          {display.mapUrl && <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-4">
            <div className="flex items-start gap-2 text-sm">
              <MapPin className="mt-0.5 shrink-0 text-[var(--accent)]" size={17} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">地址</div>
                <div className="mt-1 break-words text-[var(--modal-muted)]">{display.searchAddress}</div>
                <a href={display.mapUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-[var(--accent)] px-4 text-sm font-bold text-[var(--accent)] hover:bg-[var(--surface-secondary)]">MAP</a>
              </div>
            </div>
          </div>}

          <div className="mt-4 rounded-xl border border-[var(--border)] p-4 text-sm">
            <div className="font-semibold">說明</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-[var(--modal-muted)]">{task.description?.trim() || '無'}</div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-4 py-3 text-xs text-[var(--modal-muted)]">
            <dl className="grid gap-x-5 gap-y-1 sm:grid-cols-2">
              <SecondaryRow label="建立" value={`${audit.creatorName} · ${formatAuditTime(audit.createdAt)}`} />
              <SecondaryRow label="來源" value={getScheduleCreationSourceLabel(task.creation_source)} />
              <SecondaryRow label="最後修改" value={audit.lastBusinessModifiedAt ? `${audit.lastBusinessModifiedBy} · ${formatAuditTime(audit.lastBusinessModifiedAt)} · ${audit.lastBusinessModifiedAction}` : '尚無建立後的業務異動'} />
            </dl>
            <button type="button" onClick={openHistory} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 font-bold text-[var(--modal-text)] hover:bg-[var(--surface-secondary)]">
              <History size={16} />歷程
            </button>
          </div>
        </div>

        {onComplete || onReschedule || onDelete ? (
          <footer className="grid grid-cols-3 gap-2 border-t border-[var(--border)] px-4 py-3 sm:flex sm:justify-end sm:px-6">
            <button type="button" onClick={onComplete} disabled={!canMutate || actionPending || task.status === '完成' || task.status === '已完成'} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-sm font-bold text-[var(--accent-text)] disabled:opacity-45">
              {actionPending ? <Loader2 className="animate-spin" size={17} /> : <CheckCircle2 size={17} />}完成
            </button>
            <button type="button" onClick={onReschedule} disabled={!canMutate || actionPending} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-bold hover:bg-[var(--surface-secondary)] disabled:opacity-45">
              <CalendarClock size={17} />改期
            </button>
            <button type="button" onClick={onDelete} disabled={!canMutate || actionPending} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--danger)]/50 px-3 text-sm font-bold text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:opacity-45">
              <Trash2 size={17} />刪除
            </button>
          </footer>
        ) : null}
      </section>

      {historyOpen && currentHistory ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label="排程異動歷程">
          <section className="flex max-h-[80dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--modal-bg)] text-[var(--modal-text)] shadow-2xl">
            <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
              <div>
                <div className="flex items-center gap-2 font-bold"><History size={17} className="text-[var(--accent)]" />{currentHistory.actionLabel}</div>
                <div className="mt-1 text-xs text-[var(--modal-muted)]">{currentHistory.actorName}</div>
                <div className="text-xs text-[var(--modal-muted)]">{formatAuditTime(currentHistory.occurredAt)}</div>
              </div>
              <button type="button" onClick={() => setHistoryOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--surface-secondary)]" aria-label="關閉歷程"><X size={20} /></button>
            </header>

            <div className="min-h-32 flex-1 overflow-y-auto p-4">
              {currentHistory.changes.length > 0 ? (
                <dl className="space-y-3">
                  {currentHistory.changes.map(change => (
                    <div key={change.field} className="rounded-xl border border-[var(--border)] p-3 text-sm">
                      <dt className="text-xs font-bold text-[var(--modal-muted)]">{change.label}</dt>
                      {currentHistory.action === 'CREATE_TASK' ? (
                        <dd className="mt-1 whitespace-pre-wrap break-words font-medium">{formatScheduleAuditValue(change.after)}</dd>
                      ) : (
                        <dd className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                          <span className="whitespace-pre-wrap break-words text-[var(--modal-muted)]">{formatScheduleAuditValue(change.before)}</span>
                          <span aria-hidden="true">→</span>
                          <span className="whitespace-pre-wrap break-words font-medium text-[var(--modal-text)]">{formatScheduleAuditValue(change.after)}</span>
                        </dd>
                      )}
                    </div>
                  ))}
                </dl>
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--modal-muted)]">
                  {currentHistory.action === 'CREATE_TASK' ? '建立排程（這筆早期紀錄未保留初始欄位快照）' : '這筆早期紀錄沒有可顯示的欄位差異。'}
                </div>
              )}
            </div>

            <footer className="grid grid-cols-[1fr_auto_1fr] items-center border-t border-[var(--border)] px-4 py-3">
              <button type="button" onClick={() => setHistoryIndex(index => Math.max(0, index - 1))} disabled={historyIndex === 0} className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] disabled:opacity-35" aria-label="上一筆歷程"><ChevronLeft size={20} /></button>
              <span className="text-sm font-semibold">{historyIndex + 1} / {historyEntries.length}</span>
              <button type="button" onClick={() => setHistoryIndex(index => Math.min(historyEntries.length - 1, index + 1))} disabled={historyIndex === historyEntries.length - 1} className="ml-auto flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] disabled:opacity-35" aria-label="下一筆歷程"><ChevronRight size={20} /></button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SecondaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex gap-2"><dt className="font-semibold text-[var(--modal-text)]">{label}：</dt><dd>{value}</dd></div>;
}

function DetailRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-3">
      <dt className="flex items-center gap-2 text-xs font-semibold text-[var(--modal-muted)]">{icon}{label}</dt>
      <dd className="mt-1 break-words font-medium">{value}</dd>
    </div>
  );
}
