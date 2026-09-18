import { dbAdapter } from '@/lib/db';
import type { ScheduleTask } from '@/lib/db/types';
import type { ScheduleAuditContext } from '@/lib/schedule-audit';
import {
  createScheduleAuditSnapshot,
  diffScheduleAuditSnapshots,
  serializeScheduleAuditSnapshot,
} from '@/lib/schedule-audit';

type ScheduleActor = {
  id: string | null | undefined;
  name: string | null | undefined;
};

type ScheduleTaskInput = Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>;

const actorId = (actor: ScheduleActor) => actor.id || 'system';
const actorName = (actor: ScheduleActor) => actor.name || 'System';
const withMembers = (context: ScheduleAuditContext, memberIds: string[]) => ({ ...context, memberIds });
const isLinkedReceiptTask = (task: Pick<ScheduleTask, 'task_type' | 'source_material_batch_id'>) => (
  task.task_type.replace(/\u3000/g, ' ').trim() === '收料' && Boolean(task.source_material_batch_id)
);
const receiptPlanDateTime = (task: Pick<ScheduleTask, 'task_date' | 'start_time'>) => {
  const time = (task.start_time || '09:00').slice(0, 5);
  return `${task.task_date}T${time}:00+08:00`;
};

export async function logScheduleTaskCreation(
  task: ScheduleTask,
  actor: ScheduleActor,
  context: ScheduleAuditContext = {},
) {
  const after = createScheduleAuditSnapshot(task, context);
  return dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: 'CREATE_TASK',
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: task.title,
    project_id: task.project_id,
    project_name: String(after.site || ''),
    before_value: null,
    after_value: serializeScheduleAuditSnapshot(after),
    message: '建立排程任務',
  });
}

export async function createScheduleTaskWithActivity({
  data,
  memberIds,
  actor,
  auditContext = {},
}: {
  data: ScheduleTaskInput;
  memberIds: string[];
  actor: ScheduleActor;
  auditContext?: Omit<ScheduleAuditContext, 'memberIds'>;
}) {
  const task = await dbAdapter.createScheduleTask(data, memberIds);
  await logScheduleTaskCreation(task, actor, withMembers(auditContext, memberIds));
  return task;
}

export async function updateScheduleTaskWithActivity({
  task,
  data,
  memberIds,
  previousMemberIds = [],
  actionType,
  actor,
  auditContext = {},
}: {
  task: ScheduleTask;
  data: ScheduleTaskInput;
  memberIds: string[];
  previousMemberIds?: string[];
  actionType?: 'DRAG_MOVE_TASK';
  actor: ScheduleActor;
  auditContext?: Omit<ScheduleAuditContext, 'memberIds'>;
}) {
  const linkedReceipt = isLinkedReceiptTask(task);
  const safeData = {
    ...data,
    work_group_id: task.work_group_id,
    task_type: linkedReceipt ? '收料' : data.task_type,
  };
  const receiptTimingChanged = linkedReceipt && (
    task.task_date !== safeData.task_date || task.start_time !== safeData.start_time
  );
  if (receiptTimingChanged) {
    await dbAdapter.rescheduleMaterialReceiptGroup(task.id, receiptPlanDateTime(safeData));
  }
  const updatedTask = await dbAdapter.updateScheduleTask(task.id, safeData, memberIds);
  const before = createScheduleAuditSnapshot(task, withMembers(auditContext, previousMemberIds));
  const after = createScheduleAuditSnapshot(
    { ...task, ...safeData },
    withMembers(auditContext, memberIds),
  );
  const diff = diffScheduleAuditSnapshots(before, after);
  if (diff.changedFields.length === 0) return updatedTask;

  const timingChanged = diff.changedFields.some(field => (
    field === 'task_date' || field === 'start_time' || field === 'end_time'
  ));
  const assigneesChanged = diff.changedFields.some(field => (
    field === 'primary_assignee' || field === 'collaborators'
  ));
  const completed = diff.changedFields.includes('status')
    && (after.status === '完成' || after.status === '已完成');
  const resolvedActionType = actionType
    || (completed ? 'COMPLETE_TASK' : timingChanged ? 'RESCHEDULE_TASK' : assigneesChanged ? 'ASSIGNEE_CHANGE_TASK' : 'UPDATE_TASK');

  await dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: resolvedActionType,
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: safeData.title,
    project_id: safeData.project_id,
    project_name: String(after.site || ''),
    before_value: serializeScheduleAuditSnapshot(diff.before),
    after_value: serializeScheduleAuditSnapshot(diff.after),
    message: resolvedActionType === 'RESCHEDULE_TASK' || resolvedActionType === 'DRAG_MOVE_TASK'
      ? '排程改期'
      : resolvedActionType === 'COMPLETE_TASK'
        ? '完成排程'
        : resolvedActionType === 'ASSIGNEE_CHANGE_TASK'
          ? '變更排程人員'
          : '修改排程',
  });

  return updatedTask;
}

export async function completeScheduleTaskWithActivity(
  task: ScheduleTask,
  actor: ScheduleActor,
  auditContext: ScheduleAuditContext = {},
) {
  const completedAt = new Date().toISOString();
  if (isLinkedReceiptTask(task)) {
    await dbAdapter.completeMaterialReceiptSchedule(task.id, completedAt);
  }
  const updatedTask = await dbAdapter.updateScheduleTask(task.id, { status: '完成' });
  if (task.source_todo_id) {
    await dbAdapter.updateTodo(task.source_todo_id, { status: '已完成' });
  }
  const before = createScheduleAuditSnapshot(task, auditContext);
  const after = createScheduleAuditSnapshot({ ...task, status: '完成' }, auditContext);
  const diff = diffScheduleAuditSnapshots(before, after);
  if (diff.changedFields.length > 0) await dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: 'COMPLETE_TASK',
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: task.title,
    project_id: task.project_id,
    project_name: String(after.site || ''),
    before_value: serializeScheduleAuditSnapshot(diff.before),
    after_value: serializeScheduleAuditSnapshot(diff.after),
    message: null,
  });
  return updatedTask;
}

export async function deleteScheduleTaskWithActivity(
  task: ScheduleTask,
  actor: ScheduleActor,
  auditContext: ScheduleAuditContext = {},
) {
  const before = createScheduleAuditSnapshot(task, auditContext);
  await dbAdapter.deleteScheduleTask(task.id);
  await dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: 'DELETE_TASK',
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: task.title,
    project_id: task.project_id,
    project_name: String(before.site || ''),
    before_value: serializeScheduleAuditSnapshot(before),
    after_value: null,
    message: '刪除排程（保留審計快照）',
  });
}

export function confirmScheduleTaskDeletion(): boolean {
  return window.confirm('確定要刪除此排程嗎？排程會從正常清單消失，並保留 ADMIN 可查的刪除紀錄。');
}
