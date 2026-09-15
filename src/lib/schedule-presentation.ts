import type { Project, ScheduleTask, ScheduleTaskMember, User, WorkGroup } from '@/lib/db/types';
import { parseTaiwanProjectLocation } from '@/lib/project-location';
import { getScheduleTaskSemanticType } from '@/lib/schedule-task-semantics';

const CREATION_SOURCE_LABELS: Record<NonNullable<ScheduleTask['creation_source']>, string> = {
  APP: '系統排程',
  GOOGLE_IMPORT: 'Google 匯入',
  SYSTEM: '系統建立',
  LEGACY: '歷史資料',
};

export function getScheduleMapUrl(searchAddress: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchAddress)}`;
}

export function getScheduleCreationSourceLabel(source: ScheduleTask['creation_source']): string {
  return CREATION_SOURCE_LABELS[source || 'LEGACY'];
}

export function getScheduleTaskPresentation(
  task: ScheduleTask,
  projects: Project[],
  users: User[],
  members: ScheduleTaskMember[],
  workGroups: WorkGroup[] = [],
) {
  const project = projects.find(candidate => candidate.id === task.project_id);
  const canonicalTaskType = getScheduleTaskSemanticType(task.task_type);
  const storedProjectName = task.project_name?.trim() || '';
  const formalProjectName = project?.short_name || project?.name || storedProjectName;
  const projectName = task.project_id
    ? (formalProjectName || '未匹配案場')
    : canonicalTaskType === 'internal'
      ? '內勤'
      : canonicalTaskType === 'leave'
        ? '休假'
        : canonicalTaskType === 'meeting'
          ? (storedProjectName || task.address?.trim() || '開會')
          : canonicalTaskType === 'other'
            ? (task.title?.trim() || task.task_type.trim() || '其他')
            : (storedProjectName || '未匹配案場');
  const mainAssigneeName = users.find(user => user.id === task.main_assignee_id)?.name || '';
  const collaboratorIds = members
    .filter(member => member.task_id === task.id)
    .map(member => member.user_id);
  const collaboratorNames = users
    .filter(user => collaboratorIds.includes(user.id))
    .map(user => user.name);
  const location = parseTaiwanProjectLocation(project?.address)
    || parseTaiwanProjectLocation(task.address);
  const districtName = location
    ? (location.city === '新竹市' || location.city === '嘉義市'
      ? `${location.city.replace(/市$/, '')}${location.district}`
      : location.district.replace(/[區鄉鎮市]$/, ''))
    : '';
  const searchAddress = task.address || project?.address || projectName;
  const workGroup = workGroups.find(candidate => candidate.id === task.work_group_id);

  return {
    project,
    projectName,
    mainAssigneeName,
    collaboratorNames,
    assigneeDisplay: mainAssigneeName ? `主要：${mainAssigneeName}` : '主要：未指定負責人',
    collaboratorDisplay: collaboratorNames.length > 0 ? `協同：${collaboratorNames.join('、')}` : '',
    district: districtName ? `[${districtName}]` : '',
    searchAddress,
    mapUrl: getScheduleMapUrl(searchAddress),
    workGroup,
    workGroupName: workGroup?.name || '未設定群組',
  };
}
