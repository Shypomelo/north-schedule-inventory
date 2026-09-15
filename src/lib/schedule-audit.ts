import type { ActivityLog, Project, ScheduleTask, User } from './db/types';

const BUSINESS_ACTIONS = new Set([
  'CREATE_TASK',
  'UPDATE_TASK',
  'RESCHEDULE_TASK',
  'DRAG_MOVE_TASK',
  'COMPLETE_TASK',
  'DELETE_TASK',
  'ASSIGNEE_CHANGE_TASK',
]);

const SCHEDULE_HISTORY_ACTIONS = new Set([
  'CREATE_TASK',
  'UPDATE_TASK',
  'RESCHEDULE_TASK',
  'DRAG_MOVE_TASK',
  'COMPLETE_TASK',
  'ASSIGNEE_CHANGE_TASK',
]);

const ACTION_LABELS: Record<string,string> = {
  CREATE_TASK: '建立排程',
  UPDATE_TASK: '修改',
  RESCHEDULE_TASK: '改期',
  DRAG_MOVE_TASK: '改期',
  COMPLETE_TASK: '完成',
  DELETE_TASK: '刪除',
  ASSIGNEE_CHANGE_TASK: '變更人員',
};

export const SCHEDULE_AUDIT_FIELD_LABELS = {
  site: '案場',
  task_type: '任務類型',
  title: '標題／任務內容',
  notes: '備註',
  task_date: '任務日期',
  start_time: '開始時間',
  end_time: '結束時間',
  primary_assignee: '主要負責人',
  collaborators: '協同人員',
  status: '狀態',
} as const;

export type ScheduleAuditField = keyof typeof SCHEDULE_AUDIT_FIELD_LABELS;
export type ScheduleAuditValue = string | string[] | null;
export type ScheduleAuditSnapshot = Record<ScheduleAuditField, ScheduleAuditValue>;

export type ScheduleAuditContext = {
  projects?: Project[];
  users?: User[];
  memberIds?: string[];
};

export type ScheduleHistoryChange = {
  field: ScheduleAuditField;
  label: string;
  before: ScheduleAuditValue;
  after: ScheduleAuditValue;
};

export type ScheduleHistoryEntry = {
  id: string;
  action: string;
  actionLabel: string;
  actorName: string;
  occurredAt: string;
  changes: ScheduleHistoryChange[];
  snapshot: Partial<ScheduleAuditSnapshot> | null;
};

const AUDIT_FIELDS = Object.keys(SCHEDULE_AUDIT_FIELD_LABELS) as ScheduleAuditField[];

const normalizeMemberIds = (memberIds: string[] = []) => Array.from(new Set(memberIds)).sort();

export function createScheduleAuditSnapshot(
  task: Pick<ScheduleTask, ScheduleAuditTaskKeys>,
  context: ScheduleAuditContext = {},
): ScheduleAuditSnapshot {
  const project = context.projects?.find(candidate => candidate.id === task.project_id);
  const memberName = (id: string | null) => (
    id ? context.users?.find(user => user.id === id)?.name || id : null
  );
  const collaborators = normalizeMemberIds(context.memberIds)
    .map(id => memberName(id) || id)
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  return {
    site: project?.short_name || project?.name || task.project_name?.trim() || task.address?.trim() || null,
    task_type: task.task_type?.trim() || null,
    title: task.title?.trim() || null,
    notes: task.description?.trim() || null,
    task_date: task.task_date || null,
    start_time: task.is_all_day ? '全天' : task.start_time || null,
    end_time: task.is_all_day ? null : task.end_time || null,
    primary_assignee: memberName(task.main_assignee_id),
    collaborators,
    status: task.status || null,
  };
}

type ScheduleAuditTaskKeys =
  | 'project_id'
  | 'project_name'
  | 'address'
  | 'task_type'
  | 'title'
  | 'description'
  | 'task_date'
  | 'start_time'
  | 'end_time'
  | 'is_all_day'
  | 'main_assignee_id'
  | 'status';

const valuesEqual = (left: ScheduleAuditValue, right: ScheduleAuditValue) => (
  JSON.stringify(left) === JSON.stringify(right)
);

export function diffScheduleAuditSnapshots(before: ScheduleAuditSnapshot, after: ScheduleAuditSnapshot) {
  const changedFields = AUDIT_FIELDS.filter(field => !valuesEqual(before[field], after[field]));
  return {
    before: Object.fromEntries(changedFields.map(field => [field, before[field]])) as Partial<ScheduleAuditSnapshot>,
    after: Object.fromEntries(changedFields.map(field => [field, after[field]])) as Partial<ScheduleAuditSnapshot>,
    changedFields,
  };
}

export function serializeScheduleAuditSnapshot(snapshot: Partial<ScheduleAuditSnapshot> | null) {
  return snapshot ? JSON.stringify(snapshot) : null;
}

const parseJsonRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readAuditSide = (log: ActivityLog, side: 'before' | 'after') => (
  parseJsonRecord(log.changes?.[side]) || parseJsonRecord(side === 'before' ? log.before_value : log.after_value)
);

const toAuditValue = (value: unknown): ScheduleAuditValue => {
  if (Array.isArray(value)) return value.map(item => String(item));
  if (value === null || value === undefined || value === '') return null;
  return String(value);
};

const buildHistoryChanges = (log: ActivityLog): ScheduleHistoryChange[] => {
  const before = readAuditSide(log, 'before');
  const after = readAuditSide(log, 'after');
  const fields = log.action_type === 'CREATE_TASK'
    ? AUDIT_FIELDS.filter(field => after && toAuditValue(after[field]) !== null)
    : AUDIT_FIELDS.filter(field => (
      before?.[field] !== undefined
      || after?.[field] !== undefined
    ) && !valuesEqual(toAuditValue(before?.[field]), toAuditValue(after?.[field])));

  if (fields.length > 0) {
    return fields.map(field => ({
      field,
      label: SCHEDULE_AUDIT_FIELD_LABELS[field],
      before: toAuditValue(before?.[field]),
      after: toAuditValue(after?.[field]),
    }));
  }

  return [];
};

export function getScheduleHistoryEntries(task: ScheduleTask, logs: ActivityLog[]): ScheduleHistoryEntry[] {
  const entries = logs
    .filter(log => log.target_type === 'ScheduleTask'
      && log.target_id === task.id
      && SCHEDULE_HISTORY_ACTIONS.has(log.action_type))
    .map(log => ({
      id: log.id,
      action: log.action_type,
      actionLabel: ACTION_LABELS[log.action_type] || log.action_type,
      actorName: log.actor_name || '系統',
      occurredAt: log.created_at,
      changes: buildHistoryChanges(log),
      snapshot: (readAuditSide(log, 'after') || null) as Partial<ScheduleAuditSnapshot> | null,
    }))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  if (!entries.some(entry => entry.action === 'CREATE_TASK')) {
    entries.unshift({
      id: `created-${task.id}`,
      action: 'CREATE_TASK',
      actionLabel: ACTION_LABELS.CREATE_TASK,
      actorName: task.created_by_name?.trim() || '未知',
      occurredAt: task.created_at,
      changes: [],
      snapshot: null,
    });
  }
  return entries;
}

export function getDeletedScheduleAuditEntries(logs: ActivityLog[]) {
  return logs
    .filter(log => log.target_type === 'ScheduleTask' && log.action_type === 'DELETE_TASK')
    .map(log => ({
      id: log.id,
      taskId: log.target_id,
      title: log.target_label || '無標題',
      actorName: log.actor_name || '未知',
      occurredAt: log.created_at,
      snapshot: (readAuditSide(log, 'before') || null) as Partial<ScheduleAuditSnapshot> | null,
    }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function formatScheduleAuditValue(value: ScheduleAuditValue) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '無';
  return value || '無';
}

export function selectLastBusinessScheduleActivity(logs: ActivityLog[], taskId: string): ActivityLog | null {
  return logs
    .filter(log => log.target_type === 'ScheduleTask'
      && log.target_id === taskId
      && BUSINESS_ACTIONS.has(log.action_type)
      && log.action_type !== 'CREATE_TASK'
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
