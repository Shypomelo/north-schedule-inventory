"use client";

import type { ScheduleTask } from '@/lib/db/types';
import { ScheduleTaskForm } from '@/components/ScheduleTaskForm';

export function ScheduleTaskFormDialog({
  initialData,
  initialMemberIds,
  onSubmit,
  onCancel,
  isSubmitting,
}: {
  initialData?: Partial<ScheduleTask>;
  initialMemberIds?: string[];
  onSubmit: (
    data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>,
    memberIds: string[],
  ) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label={initialData?.id ? '編輯排程' : '新增排程'}>
      <div className="max-h-[100dvh] w-full overflow-auto rounded-t-2xl border border-[var(--border)] bg-[var(--modal-bg)] p-4 text-[var(--modal-text)] shadow-2xl sm:max-h-[95vh] sm:max-w-xl sm:rounded-2xl sm:p-5">
        <ScheduleTaskForm
          initialData={initialData}
          initialMemberIds={initialMemberIds}
          onSubmit={onSubmit}
          onCancel={onCancel}
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  );
}
