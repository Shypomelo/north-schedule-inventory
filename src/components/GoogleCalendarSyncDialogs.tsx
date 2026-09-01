"use client";

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import type { Project } from '@/lib/db/types';

export type GoogleCalendarSyncFailure = {
  eventId: string;
  title: string;
  message: string;
};

export type GoogleCalendarUnmatchedEvent = {
  eventId: string;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  isAllDay: boolean;
  location: string | null;
  notes: string | null;
  reason: 'no_project_match' | 'ambiguous_project_match';
  suggestions: Array<{ id: string; name: string }>;
};

export type GoogleCalendarSyncDecision = {
  eventId: string;
  action: 'import_with_project' | 'import_without_project' | 'skip';
  projectId?: string;
};

export type GoogleCalendarSyncSummary = {
  matchedImportedOrUpdated: number;
  unmatchedImported: number;
  skippedThisRun: number;
  failed: number;
  failures: GoogleCalendarSyncFailure[];
};

type DecisionDraft = {
  action: '' | GoogleCalendarSyncDecision['action'];
  projectId: string;
};

export function GoogleCalendarUnmatchedDialog({
  events,
  projects,
  isSubmitting,
  onConfirm,
  onClose,
}: {
  events: GoogleCalendarUnmatchedEvent[];
  projects: Project[];
  isSubmitting: boolean;
  onConfirm: (decisions: GoogleCalendarSyncDecision[]) => Promise<void>;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>(() =>
    Object.fromEntries(events.map(event => [event.eventId, { action: '', projectId: '' }])),
  );

  const activeProjects = useMemo(
    () => projects.filter(project => project.is_active).sort((a, b) => a.name.localeCompare(b.name, 'zh-TW')),
    [projects],
  );
  const isComplete = events.every((event) => {
    const draft = drafts[event.eventId];
    return !!draft?.action && (draft.action !== 'import_with_project' || !!draft.projectId);
  });

  const updateDraft = (eventId: string, updates: Partial<DecisionDraft>) => {
    setDrafts(current => ({
      ...current,
      [eventId]: { ...current[eventId], ...updates },
    }));
  };

  const handleConfirm = async () => {
    if (!isComplete) return;
    await onConfirm(events.map((event) => {
      const draft = drafts[event.eventId];
      return {
        eventId: event.eventId,
        action: draft.action as GoogleCalendarSyncDecision['action'],
        ...(draft.action === 'import_with_project' ? { projectId: draft.projectId } : {}),
      };
    }));
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--modal-bg)] text-[var(--modal-text)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] p-5">
          <div>
            <h2 className="text-xl font-bold">確認未匹配的 Google Calendar 活動</h2>
            <p className="mt-1 text-sm text-[var(--modal-muted)]">
              已匹配的活動已先完成同步。以下 {events.length} 筆請逐筆選擇處理方式；建議案場不會自動綁定。
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={isSubmitting} aria-label="關閉"
            className="rounded p-1 text-[var(--modal-muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-50">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {events.map((event) => {
            const draft = drafts[event.eventId];
            const suggestionIds = new Set(event.suggestions.map(suggestion => suggestion.id));
            return (
              <section key={event.eventId} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
                  <div className="min-w-0 space-y-2">
                    <h3 className="break-words font-bold text-[var(--text-primary)]">{event.title}</h3>
                    <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-sm">
                      <dt className="text-[var(--text-muted)]">日期</dt><dd>{event.date || '—'}</dd>
                      <dt className="text-[var(--text-muted)]">時間</dt>
                      <dd>{event.isAllDay ? '全天' : `${event.startTime || '—'}–${event.endTime || '—'}`}</dd>
                      <dt className="text-[var(--text-muted)]">地點</dt><dd className="break-words">{event.location || '—'}</dd>
                      <dt className="text-[var(--text-muted)]">備註</dt><dd className="whitespace-pre-wrap break-words">{event.notes || '—'}</dd>
                      <dt className="text-[var(--text-muted)]">建議案場</dt>
                      <dd>{event.suggestions.length > 0 ? event.suggestions.map(item => item.name).join('、') : '無'}</dd>
                    </dl>
                  </div>

                  <div className="space-y-2 text-sm">
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] p-2">
                      <input type="radio" name={`action-${event.eventId}`}
                        checked={draft.action === 'import_with_project'}
                        onChange={() => updateDraft(event.eventId, { action: 'import_with_project' })} />
                      <span>選擇現有案場後匯入</span>
                    </label>
                    {draft.action === 'import_with_project' && (
                      <select value={draft.projectId}
                        onChange={e => updateDraft(event.eventId, { projectId: e.target.value })}
                        className="w-full rounded border border-[var(--input-border)] bg-[var(--input-bg)] p-2 text-[var(--input-text)]">
                        <option value="">請選擇案場</option>
                        {activeProjects.map(project => (
                          <option key={project.id} value={project.id}>
                            {suggestionIds.has(project.id) ? `建議｜${project.name}` : project.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] p-2">
                      <input type="radio" name={`action-${event.eventId}`}
                        checked={draft.action === 'import_without_project'}
                        onChange={() => updateDraft(event.eventId, { action: 'import_without_project', projectId: '' })} />
                      <span>不綁定案場，仍直接匯入</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] p-2">
                      <input type="radio" name={`action-${event.eventId}`}
                        checked={draft.action === 'skip'}
                        onChange={() => updateDraft(event.eventId, { action: 'skip', projectId: '' })} />
                      <span>本次略過</span>
                    </label>
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] p-5">
          <p className="text-sm text-[var(--modal-muted)]">關閉視窗不會刪除活動，下次重新同步仍會再次詢問。</p>
          <button type="button" onClick={handleConfirm} disabled={!isComplete || isSubmitting}
            className="shrink-0 rounded-lg bg-[var(--accent)] px-5 py-2 font-semibold text-[var(--accent-text)] disabled:opacity-50">
            {isSubmitting ? '處理中…' : '確認並完成同步'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GoogleCalendarSyncSummaryDialog({
  summary,
  onClose,
}: {
  summary: GoogleCalendarSyncSummary;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--modal-bg)] p-5 text-[var(--modal-text)] shadow-2xl">
        <div className="flex items-center gap-2">
          {summary.failed > 0 ? <AlertTriangle className="text-amber-400" /> : <CheckCircle2 className="text-emerald-400" />}
          <h2 className="text-xl font-bold">Google Calendar 同步完成</h2>
        </div>
        <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-xl bg-[var(--surface)] p-4 text-sm">
          <dt>已匹配並匯入／更新</dt><dd className="font-bold">{summary.matchedImportedOrUpdated}</dd>
          <dt>未匹配但已匯入</dt><dd className="font-bold">{summary.unmatchedImported}</dd>
          <dt>本次略過</dt><dd className="font-bold">{summary.skippedThisRun}</dd>
          <dt>同步失敗</dt><dd className="font-bold">{summary.failed}</dd>
        </dl>
        {summary.failures.length > 0 && (
          <div className="mt-4 max-h-56 overflow-y-auto rounded-xl border border-amber-500/30 p-3">
            <h3 className="mb-2 font-semibold text-amber-300">失敗項目</h3>
            <ul className="space-y-2 text-sm">
              {summary.failures.map((failure, index) => (
                <li key={`${failure.eventId}-${index}`}>
                  <span className="font-semibold">{failure.title || failure.eventId}</span>
                  <span className="text-[var(--modal-muted)]">：{failure.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose}
            className="rounded-lg bg-[var(--accent)] px-5 py-2 font-semibold text-[var(--accent-text)]">
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
