'use client';

import { useId } from 'react';
import type { Project } from '@/lib/db/types';
import { resolveWorkItemProjectInput } from '@/lib/work-item-project';

export interface WorkItemProjectValue {
  projectId: string | null;
  projectLabel: string | null;
}

export function WorkItemProjectCombobox({ projects, value, onChange, disabled = false }: {
  projects: readonly Project[];
  value: WorkItemProjectValue;
  onChange: (value: WorkItemProjectValue) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const linkedProject = value.projectId ? projects.find(project => project.id === value.projectId) : undefined;
  const displayValue = value.projectLabel ?? linkedProject?.name ?? '';

  return (
    <div>
      <input
        list={listId}
        value={displayValue}
        disabled={disabled}
        placeholder="輸入自訂案場名稱，或選擇正式案場"
        className="min-h-11 w-full min-w-0 rounded border border-theme-border bg-page p-2"
        onChange={event => {
          onChange(resolveWorkItemProjectInput(event.target.value, projects));
        }}
      />
      <datalist id={listId}>
        {projects.map(project => <option key={project.id} value={project.name} />)}
      </datalist>
      <p className="mt-1 text-xs text-secondary">選擇清單會保留正式案場連結；自行輸入則保存為自訂名稱。</p>
    </div>
  );
}
