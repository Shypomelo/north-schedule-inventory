"use client";

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Loader2, X } from 'lucide-react';
import type { ActivityLog } from '@/lib/db/types';
import {
  formatScheduleAuditValue,
  getDeletedScheduleAuditEntries,
  SCHEDULE_AUDIT_FIELD_LABELS,
  type ScheduleAuditField,
} from '@/lib/schedule-audit';

const AUDIT_FIELDS = Object.keys(SCHEDULE_AUDIT_FIELD_LABELS) as ScheduleAuditField[];
const formatAuditTime = (value: string) => new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date(value));

export function ScheduleDeletedAuditDialog({
  logs,
  loading,
  onClose,
}: {
  logs: ActivityLog[];
  loading: boolean;
  onClose: () => void;
}) {
  const entries = useMemo(() => getDeletedScheduleAuditEntries(logs), [logs]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = entries.find(entry => entry.id === selectedId) || null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[130] flex items-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="排程刪除紀錄">
      <section className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--modal-bg)] text-[var(--modal-text)] shadow-2xl sm:max-w-3xl sm:rounded-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {selected ? (
              <button type="button" onClick={() => setSelectedId(null)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--surface-secondary)]" aria-label="返回刪除紀錄清單"><ChevronLeft size={20} /></button>
            ) : null}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[var(--accent)]">ADMIN ONLY</p>
              <h2 className="truncate text-lg font-bold">{selected ? '刪除快照' : '排程刪除紀錄'}</h2>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--surface-secondary)]" aria-label="關閉刪除紀錄"><X size={21} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-[var(--modal-muted)]"><Loader2 className="animate-spin" size={18} />讀取刪除紀錄…</div>
          ) : selected ? (
            <div>
              <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-4 text-sm">
                <div className="font-bold">{selected.snapshot?.site || '無案場'}｜{selected.snapshot?.title || selected.title}</div>
                <div className="mt-1 text-[var(--modal-muted)]">{formatAuditTime(selected.occurredAt)} · {selected.actorName} 刪除</div>
              </div>
              {selected.snapshot ? (
                <dl className="grid gap-2 sm:grid-cols-2">
                  {AUDIT_FIELDS.map(field => (
                    <div key={field} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
                      <dt className="text-xs font-semibold text-[var(--modal-muted)]">{SCHEDULE_AUDIT_FIELD_LABELS[field]}</dt>
                      <dd className="mt-1 whitespace-pre-wrap break-words font-medium">{formatScheduleAuditValue(selected.snapshot?.[field] ?? null)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="rounded-lg border border-dashed border-[var(--border)] p-4 text-sm text-[var(--modal-muted)]">這筆舊紀錄沒有完整 snapshot。</p>
              )}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-[var(--modal-muted)]">目前沒有排程刪除紀錄</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[var(--border)]">
              <div className="hidden grid-cols-[9.5rem_minmax(0,1fr)_8rem_7rem] gap-3 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs font-semibold text-[var(--modal-muted)] sm:grid">
                <span>刪除時間</span><span>案場／標題</span><span>任務類型</span><span>刪除人</span>
              </div>
              {entries.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  className="grid w-full gap-1 border-b border-[var(--border)] px-3 py-3 text-left text-sm last:border-b-0 hover:bg-[var(--surface-secondary)] sm:grid-cols-[9.5rem_minmax(0,1fr)_8rem_7rem] sm:items-center sm:gap-3"
                >
                  <span className="text-xs text-[var(--modal-muted)] sm:text-sm">{formatAuditTime(entry.occurredAt)}</span>
                  <span className="min-w-0 truncate font-semibold">{entry.snapshot?.site || '無案場'}／{entry.snapshot?.title || entry.title}</span>
                  <span>{entry.snapshot?.task_type || '未設定'}</span>
                  <span>{entry.actorName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
