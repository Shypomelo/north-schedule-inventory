import type { ScheduleTask } from './db/types';

export type ScheduleTaskSemanticType = 'internal' | 'leave' | 'meeting' | 'other' | 'maintenance' | 'site-work';

const normalizeTaskType = (value: string | null | undefined) => (
  (value || '').replace(/\u3000/g, ' ').trim()
);

export function getScheduleTaskSemanticType(taskType: string | null | undefined): ScheduleTaskSemanticType {
  switch (normalizeTaskType(taskType)) {
    case '內勤':
    case '內部':
      return 'internal';
    case '休假':
      return 'leave';
    case '開會':
      return 'meeting';
    case '其他':
      return 'other';
    case '維修':
      return 'maintenance';
    default:
      return 'site-work';
  }
}

export function allowsScheduleTaskWithoutSite(taskType: string | null | undefined): boolean {
  const semanticType = getScheduleTaskSemanticType(taskType);
  return semanticType === 'internal'
    || semanticType === 'leave'
    || semanticType === 'meeting'
    || semanticType === 'other';
}

export function isMaintenanceScheduleTask(task: Pick<ScheduleTask, 'task_type'>): boolean {
  return getScheduleTaskSemanticType(task.task_type) === 'maintenance';
}

