import type { Project } from '@/lib/db/types';

export interface WorkItemProjectSelection {
  projectId: string | null;
  projectLabel: string | null;
}

export function resolveWorkItemProjectInput(
  input: string,
  projects: readonly Pick<Project, 'id' | 'name'>[],
): WorkItemProjectSelection {
  const label = input.trim();
  if (!label) return { projectId: null, projectLabel: null };
  const official = projects.find(project => project.name === label);
  return official
    ? { projectId: official.id, projectLabel: official.name }
    : { projectId: null, projectLabel: label };
}

export function displayWorkItemProjectLabel(
  item: { project_id: string | null; project_label: string | null },
  projects: readonly Pick<Project, 'id' | 'name'>[],
): string | null {
  return item.project_label
    ?? projects.find(project => project.id === item.project_id)?.name
    ?? null;
}
