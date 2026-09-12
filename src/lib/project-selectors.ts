import type { Project } from './db/types';

// Shared by /projects/active and every Dashboard perspective.
// The adapter already removes deleted rows; is_active keeps fixtures and alternate adapters safe.
const INACTIVE_PROJECT_STATUSES = new Set(['已完工', '已結案', '已撤案', '作廢']);

export function isActiveProject(project: Pick<Project, 'status' | 'is_active'>): boolean {
  return project.is_active !== false && !INACTIVE_PROJECT_STATUSES.has(project.status ?? '');
}

export function selectActiveProjects<T extends Pick<Project, 'status' | 'is_active'>>(projects: T[]): T[] {
  return projects.filter(isActiveProject);
}
