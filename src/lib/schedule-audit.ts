import type { ActivityLog, ScheduleTask } from './db/types';

const BUSINESS_ACTIONS = new Set([
  'UPDATE_TASK',
  'RESCHEDULE_TASK',
  'DRAG_MOVE_TASK',
  'COMPLETE_TASK',
  'DELETE_TASK',
  'ASSIGNEE_CHANGE_TASK',
]);

const ACTION_LABELS: Record<string,string> = {
  UPDATE_TASK: '編輯',
  RESCHEDULE_TASK: '改期',
  DRAG_MOVE_TASK: '拖曳改期',
  COMPLETE_TASK: '完成',
  DELETE_TASK: '取消',
  ASSIGNEE_CHANGE_TASK: '變更人員',
};

export function selectLastBusinessScheduleActivity(logs: ActivityLog[], taskId: string): ActivityLog | null {
  return logs
    .filter(log => log.target_type === 'ScheduleTask'
      && log.target_id === taskId
      && BUSINESS_ACTIONS.has(log.action_type)
      && log.actor_user_id !== 'system'
      && log.actor_name.toLowerCase() !== 'system')
    .sort((a,b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function getScheduleAuditPresentation(task: ScheduleTask, logs: ActivityLog[]) {
  const last = selectLastBusinessScheduleActivity(logs, task.id);
  return {
    creatorName: task.created_by_name?.trim() || '未知',
    createdAt: task.created_at,
    creationSource: task.creation_source,
    lastBusinessModifiedBy: last?.actor_name ?? null,
    lastBusinessModifiedAt: last?.created_at ?? null,
    lastBusinessModifiedAction: last ? (ACTION_LABELS[last.action_type] || last.action_type) : null,
  };
}
