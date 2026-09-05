"use client";

import { useState } from 'react';
import { dbAdapter } from '@/lib/db';
import { getConstructionToday } from '@/lib/construction-progress';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import { getWorkflowOuterDisplay, normalizeMilestoneCompletion, type WorkflowOuterKind } from '@/lib/project-workflow';
import { updateAuthoritativeMilestone, type AuthoritativeMilestoneKey } from '@/lib/workflow-milestone-editor';

interface WorkflowMilestoneQuickEditorProps {
  projectId: string;
  milestoneId: string | null;
  milestoneKey: AuthoritativeMilestoneKey;
  kind: WorkflowOuterKind;
  status: string | null;
  plannedDate: string | null;
  actualDate: string | null;
  disabled: boolean;
  onUpdated: () => Promise<void>;
}

export function WorkflowMilestoneQuickEditor({
  projectId,
  milestoneId,
  milestoneKey,
  kind,
  status,
  plannedDate,
  actualDate,
  disabled,
  onUpdated,
}: WorkflowMilestoneQuickEditorProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = getConstructionToday();
  const isCompleted = Boolean(actualDate || status === 'COMPLETED');
  const display = getWorkflowOuterDisplay(kind, status, plannedDate, actualDate);
  const noun = kind === 'ACCEPTANCE' ? '驗收' : '掛表';

  const save = async (updates: Parameters<typeof updateAuthoritativeMilestone>[1]['updates']) => {
    if (disabled || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateAuthoritativeMilestone(dbAdapter, {
        projectId,
        milestoneId,
        milestoneKey,
        kind,
        updates,
        today,
      });
      await onUpdated();
    } catch (cause) {
      setError(getDatabaseErrorMessage(cause, `更新${noun}失敗`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-[9.5rem] flex-col gap-1 rounded-md px-1 py-0.5">
      <span className={isCompleted ? 'text-xs font-medium text-emerald-400' : 'text-xs font-medium text-blue-400'}>{display.label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          aria-label={`${noun}日期`}
          value={(isCompleted ? actualDate : plannedDate) ?? ''}
          max={isCompleted ? today : undefined}
          disabled={disabled || saving}
          onChange={event => {
            const date = event.target.value || null;
            void save(isCompleted
              ? date
                ? { status: 'COMPLETED', actual_date: date }
                : { status: 'IN_PROGRESS', actual_date: null }
              : { planned_date: date });
          }}
          className="min-w-0 flex-1 rounded border border-theme-border/60 bg-page/60 px-1 py-1 text-xs text-primary outline-none focus:border-accent disabled:opacity-50"
        />
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-secondary">
          <input
            type="checkbox"
            aria-label={`${noun}完成`}
            checked={isCompleted}
            disabled={disabled || saving}
            onChange={event => void save(normalizeMilestoneCompletion(
              event.target.checked ? 'COMPLETED' : 'IN_PROGRESS',
              event.target.checked ? actualDate : null,
              today,
            ))}
            className="h-3.5 w-3.5 accent-accent"
          />
          完成
        </label>
      </div>
      {error ? <span role="alert" className="text-[11px] text-danger">{error}</span> : null}
    </div>
  );
}
