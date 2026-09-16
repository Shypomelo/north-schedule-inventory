import type { ScheduleTask, ScheduleTaskMember, User, WorkGroup, WorkGroupKey } from './db/types';
import { type MemberWorkGroup, resolveParticipantWorkGroups } from './work-groups';
import { isMaintenanceScheduleTask } from './schedule-task-semantics';

export type MaintenanceScheduleFilter = 'week' | 'incomplete' | 'completed';

const formatLocalBusinessDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export function getDefaultMaintenanceDateRange(referenceDate = new Date()) {
  const taipeiParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate).map(part => [part.type, part.value]));
  const reference = new Date(
    Number(taipeiParts.year),
    Number(taipeiParts.month) - 1,
    Number(taipeiParts.day),
  );
  const daysSinceMonday = (reference.getDay() + 6) % 7;
  const currentMonday = new Date(reference);
  currentMonday.setDate(reference.getDate() - daysSinceMonday);
  const previousMonday = new Date(currentMonday);
  previousMonday.setDate(currentMonday.getDate() - 7);
  const currentSunday = new Date(currentMonday);
  currentSunday.setDate(currentMonday.getDate() + 6);
  return {
    start: formatLocalBusinessDate(previousMonday),
    end: formatLocalBusinessDate(currentSunday),
  };
}

const scheduleTimeWeight = (task: Pick<ScheduleTask, 'start_time' | 'is_all_day'>) => {
  if (task.start_time) return task.start_time;
  if (task.is_all_day) return '25:00';
  return '26:00';
};

export function selectScheduleTasksByWorkGroup(
  tasks: ScheduleTask[],
  workGroupId: string | null | undefined,
  participants?: { members: ScheduleTaskMember[]; users: User[]; memberships: MemberWorkGroup[]; groups: WorkGroup[] },
): ScheduleTask[] {
  if (!workGroupId) return [];
  const participantIds=new Set((participants?.users||[]).filter(user=>{
    const resolution=resolveParticipantWorkGroups(user,participants!.memberships,participants!.groups);
    return resolution.activeGroups.some(group=>group.id===workGroupId);
  }).map(user=>user.id));
  const sharedTaskIds=new Set((participants?.members||[]).filter(member=>participantIds.has(member.user_id)).map(member=>member.task_id));
  const seen=new Set<string>();
  return tasks.filter(task=>{
    const visible=task.work_group_id===workGroupId||participantIds.has(task.main_assignee_id||'')||sharedTaskIds.has(task.id);
    if(!visible||seen.has(task.id))return false;seen.add(task.id);return true;
  });
}

export function selectSchedulePrimaryCandidates(
  users: User[],
  workGroupKey: WorkGroupKey | undefined,
  currentAssigneeId?: string | null,
): User[] {
  return users.filter(user => (
    (workGroupKey === 'ENGINEERING'
      ? user.category === 'ENGINEERING'
      : workGroupKey === 'PROJECT'
        ? user.role !== 'VIEWER'
        : false)
    || user.id === currentAssigneeId
  ));
}

export function sortScheduleTasks(taskList: ScheduleTask[]) {
  return [...taskList].filter(task => task.status !== '取消').sort((a, b) => {
    if (a.is_tentative !== b.is_tentative) return a.is_tentative ? 1 : -1;
    return scheduleTimeWeight(a).localeCompare(scheduleTimeWeight(b));
  });
}

export function isScheduleTaskCompleted(task: Pick<ScheduleTask, 'status'>): boolean {
  return task.status === '完成' || task.status === '已完成';
}

export function selectMaintenanceScheduleTasks(
  tasks: ScheduleTask[],
  filter: MaintenanceScheduleFilter,
  weekRange: { start: string; end: string },
): ScheduleTask[] {
  const maintenanceTasks = tasks.filter(task => (
    task.status !== '取消'
    && isMaintenanceScheduleTask(task)
    && task.task_date >= weekRange.start
    && task.task_date <= weekRange.end
    && (filter !== 'incomplete' || !isScheduleTaskCompleted(task))
    && (filter !== 'completed' || isScheduleTaskCompleted(task))
  ));

  return maintenanceTasks.sort((a, b) => (
    a.task_date.localeCompare(b.task_date)
    || (a.is_tentative === b.is_tentative ? 0 : a.is_tentative ? 1 : -1)
    || scheduleTimeWeight(a).localeCompare(scheduleTimeWeight(b))
    || a.title.localeCompare(b.title, 'zh-Hant')
  ));
}

export function formatScheduleTaskTime(task: ScheduleTask) {
  if (task.is_all_day) return '全天';
  if (task.start_time && task.end_time) return `${task.start_time}–${task.end_time}`;
  return task.start_time || '';
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
