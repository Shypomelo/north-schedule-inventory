import type { Project } from './db/types';
import { getConstructionToday } from './construction-progress';

export type ProjectManagementSection = 'construction' | 'upcoming' | 'other' | 'metered';

const isoDay = (value: string | null | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value! : null;

export function nextNextSunday(today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (7 - date.getUTCDay()) % 7 + 14);
  return date.toISOString().slice(0, 10);
}

export function isMeteredProject(project: Project, today = getConstructionToday()): boolean {
  return project.meter_status === 'COMPLETED'
    && !!isoDay(project.meter_completion_date)
    && project.meter_completion_date! < today;
}

export function getFormalEntryDate(project: Project): string | null {
  const isNewRoof = /新設頂蓋|頂蓋|鋼構/.test(project.project_type || '')
    || (!!project.steel_expected_start_date && project.steel_status !== 'disabled')
    || (!!project.roof_cover_expected_start_date && project.roof_cover_status !== 'disabled');
  const types = isNewRoof ? ['steel', 'roof_cover', 'racking', 'electrical'] : ['racking', 'electrical'];
  return types.map(type => project[`${type}_status` as keyof Project] === 'disabled' ? null
    : isoDay(project[`${type}_expected_start_date` as keyof Project] as string | null))
    .filter((date): date is string => !!date).sort()[0] ?? null;
}

export function classifyProjectManagement(project: Project, today = getConstructionToday()): ProjectManagementSection {
  if (isMeteredProject(project, today)) return 'metered';
  const entry = getFormalEntryDate(project);
  if (entry && entry <= today) return 'construction';
  if (entry && entry > today && entry <= nextNextSunday(today)) return 'upcoming';
  return 'other';
}

export function isManagedProject(project: Project): boolean {
  return project.is_active !== false && !project.deleted_at
    && !['已結案', '已撤案', '作廢'].includes(project.status || '');
}
