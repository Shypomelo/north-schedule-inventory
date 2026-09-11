import { dbAdapter } from '@/lib/db';
import type { ScheduleTask } from '@/lib/db/types';
import { formatScheduleTaskTime } from '@/lib/schedule-selectors';

type ScheduleActor = {
  id: string | null | undefined;
  name: string | null | undefined;
};

type ScheduleTaskInput = Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>;

const actorId = (actor: ScheduleActor) => actor.id || 'system';
const actorName = (actor: ScheduleActor) => actor.name || 'System';

export async function updateScheduleTaskWithActivity({
  task,
  data,
  memberIds,
  actor,
}: {
  task: ScheduleTask;
  data: ScheduleTaskInput;
  memberIds: string[];
  actor: ScheduleActor;
}) {
  const safeData = { ...data, work_group_id: task.work_group_id };
  const updatedTask = await dbAdapter.updateScheduleTask(task.id, safeData, memberIds);
  const projectChanged = task.project_id !== safeData.project_id;
  const timingChanged = task.task_date !== safeData.task_date
    || task.start_time !== safeData.start_time
    || task.end_time !== safeData.end_time
    || task.is_all_day !== safeData.is_all_day;

  await dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: timingChanged ? 'RESCHEDULE_TASK' : 'UPDATE_TASK',
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: safeData.title,
    project_id: safeData.project_id,
    project_name: safeData.project_name || '',
    before_value: timingChanged
      ? `${task.task_date} ${formatScheduleTaskTime(task)}`
      : projectChanged ? (task.project_name || '未匹配案場') : null,
    after_value: timingChanged
      ? `${safeData.task_date} ${formatScheduleTaskTime(safeData as ScheduleTask)}`
      : projectChanged ? (safeData.project_name || '未匹配案場') : null,
    message: timingChanged
      ? '編輯排程並改期'
      : projectChanged ? '編輯排程任務並更新案場關聯' : '編輯排程任務',
  });

  return updatedTask;
}

export async function completeScheduleTaskWithActivity(task: ScheduleTask, actor: ScheduleActor) {
  const updatedTask = await dbAdapter.updateScheduleTask(task.id, { status: '完成' });
  if (task.source_todo_id) {
    await dbAdapter.updateTodo(task.source_todo_id, { status: '已完成' });
  }
  await dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: 'COMPLETE_TASK',
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: task.title,
    project_id: task.project_id,
    project_name: task.project_name || '',
    before_value: task.status,
    after_value: '完成',
    message: null,
  });
  return updatedTask;
}

export async function deleteScheduleTaskWithActivity(task: ScheduleTask, actor: ScheduleActor) {
  await dbAdapter.deleteScheduleTask(task.id);
  await dbAdapter.logActivity({
    actor_user_id: actorId(actor),
    actor_name: actorName(actor),
    action_type: 'DELETE_TASK',
    target_type: 'ScheduleTask',
    target_id: task.id,
    target_label: task.title,
    project_id: task.project_id,
    project_name: task.project_name || '',
    before_value: task.status,
    after_value: '取消',
    message: '取消排程（保留歷史資料）',
  });
}

export function confirmScheduleTaskDeletion(): boolean {
  return window.confirm('確定要刪除此排程嗎？排程會取消並保留歷史紀錄。');
}
