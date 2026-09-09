import type { ScheduleTask, ScheduleTaskMember } from './db/types';

export function sortScheduleTasks(taskList: ScheduleTask[]) {
  return [...taskList].filter(task => task.status !== '取消').sort((a, b) => {
    if (a.is_tentative !== b.is_tentative) return a.is_tentative ? 1 : -1;
    const timeWeight = (task: ScheduleTask) => {
      if (task.start_time) return task.start_time;
      if (task.is_all_day) return '25:00';
      return '26:00';
    };
    return timeWeight(a).localeCompare(timeWeight(b));
  });
}

export function formatScheduleTaskTime(task: ScheduleTask) {
  if (task.is_all_day) return '全天';
  if (task.start_time && task.end_time) return `${task.start_time}–${task.end_time}`;
  return task.start_time || '未指定時間';
}

export function selectTodayMemberSchedule({
  tasks,
  members,
  memberId,
  today,
}: {
  tasks: ScheduleTask[];
  members: ScheduleTaskMember[];
  memberId: string;
  today: string;
}) {
  const collaboratorTaskIds = new Set(
    members.filter(member => member.user_id === memberId).map(member => member.task_id),
  );
  return sortScheduleTasks(tasks.filter(task => (
    task.task_date === today
    && (task.main_assignee_id === memberId || collaboratorTaskIds.has(task.id))
  )));
}
