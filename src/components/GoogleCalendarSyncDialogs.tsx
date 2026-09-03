"use client";

import { AlertTriangle, CheckCircle2 } from 'lucide-react';

export type GoogleCalendarSyncFailure = {
  eventId: string;
  title: string;
  message: string;
};

export type GoogleCalendarSyncSummary = {
  imported: number;
  updated: number;
  unmatchedProjectImported: number;
  unassignedMemberImported: number;
  failed: number;
  failures: GoogleCalendarSyncFailure[];
};

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
          <h2 className="text-xl font-bold">Google Calendar 同步結果</h2>
        </div>
        <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-xl bg-[var(--surface)] p-4 text-sm">
          <dt>新增</dt><dd className="font-bold">{summary.imported}</dd>
          <dt>更新</dt><dd className="font-bold">{summary.updated}</dd>
          <dt>未匹配案場</dt><dd className="font-bold">{summary.unmatchedProjectImported}</dd>
          <dt>未指定負責人</dt><dd className="font-bold">{summary.unassignedMemberImported}</dd>
          <dt>失敗</dt><dd className="font-bold">{summary.failed}</dd>
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
