"use client";

import { useState } from 'react';
import { dbAdapter } from '@/lib/db';
import { getConstructionToday } from '@/lib/construction-progress';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import { getWorkflowOuterCompactLabel, normalizeMilestoneCompletion, type WorkflowOuterKind } from '@/lib/project-workflow';
import { updateAuthoritativeMilestone, type AuthoritativeMilestoneKey } from '@/lib/workflow-milestone-editor';
import { DateDualInput } from '@/components/DateDualInput';
import type { ProjectMilestone } from '@/lib/db/types';

interface WorkflowMilestoneQuickEditorProps {
  projectId: string;
  milestoneId: string | null;
  milestoneKey: AuthoritativeMilestoneKey;
  kind: WorkflowOuterKind;
  status: string | null;
  plannedDate: string | null;
  actualDate: string | null;
  disabled: boolean;
  onUpdated: (milestone: ProjectMilestone) => void;
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
  const summaryText = getWorkflowOuterCompactLabel(kind, status, plannedDate, actualDate, today);
  const noun = kind === 'ACCEPTANCE' ? '驗收' : kind === 'METER' ? '掛表' : '設備登記';

  const save = async (updates: Parameters<typeof updateAuthoritativeMilestone>[1]['updates']) => {
    if (disabled || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateAuthoritativeMilestone(dbAdapter, {
        projectId,
        milestoneId,
        milestoneKey,
        kind,
        updates,
        today,
      });
      onUpdated(updated);
    } catch (cause) {
      setError(getDatabaseErrorMessage(cause, `更新${noun}失敗`));
    } finally {
      setSaving(false);
    }
  };

  const saveEditor = (nextPlannedDate: string | null, nextActualDate: string | null, completed?: boolean) => {
    const nextCompleted = kind !== 'EQUIPMENT' && nextPlannedDate && nextPlannedDate >= today
      ? false : completed ?? isCompleted;
    const updates: Parameters<typeof save>[0] = { planned_date: nextPlannedDate };
    if (nextCompleted) {
      Object.assign(updates, normalizeMilestoneCompletion('COMPLETED', nextActualDate, today));
    } else if (isCompleted) {
      Object.assign(updates, normalizeMilestoneCompletion('IN_PROGRESS', null, today));
    }
    void save(updates);
  };

  return (
    <div className="min-w-[7.5rem]">
      <DateDualInput
        expectedDate={plannedDate}
        completionDate={actualDate}
        baseDate={today}
        onChange={saveEditor}
        disabled={disabled || saving}
        summaryText={summaryText}
        completionIsActual
        showCompletionToggle
        isCompleted={isCompleted}
        defaultCompletionDate={today}
        expectedLabel={`預計${noun}日期`}
        completionLabel={`實際${noun}日期`}
      />
      {error ? <span role="alert" className="text-[11px] text-danger">{error}</span> : null}
    </div>
  );
}
