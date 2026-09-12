import type { ScheduleTask, ScheduleTaskMember, User, WorkGroup, WorkGroupKey } from './db/types';
import { type MemberWorkGroup, resolveParticipantWorkGroups } from './work-groups';

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
