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
  const storedAddress = task.address?.trim() || '';
  const taskTitle = task.title?.trim() || '';
  const formalProjectName = project?.short_name || project?.name || storedProjectName;
  const projectName = canonicalTaskType === 'internal'
    ? '內勤'
    : canonicalTaskType === 'leave'
      ? '休假'
      : canonicalTaskType === 'meeting'
        ? (formalProjectName || storedAddress || '開會')
        : canonicalTaskType === 'other'
          ? (storedProjectName || storedAddress || '其他')
          : formalProjectName;
  const mainAssigneeName = users.find(user => user.id === task.main_assignee_id)?.name || '';
  const collaboratorIds = members
    .filter(member => member.task_id === task.id)
    .map(member => member.user_id);
  const collaboratorNames = users
    .filter(user => collaboratorIds.includes(user.id))
    .map(user => user.name);
  const searchAddress = canonicalTaskType === 'internal' || canonicalTaskType === 'leave'
    ? ''
    : canonicalTaskType === 'other'
      ? (storedAddress || storedProjectName)
      : canonicalTaskType === 'meeting'
        ? (storedAddress || project?.address || formalProjectName)
        : (storedAddress || project?.address || formalProjectName);
  const location = searchAddress ? parseTaiwanProjectLocation(searchAddress) : null;
  const districtName = location
    ? (location.city === '新竹市' || location.city === '嘉義市'
      ? `${location.city.replace(/市$/, '')}${location.district}`
      : location.district.replace(/[區鄉鎮市]$/, ''))
    : '';
  const workGroup = workGroups.find(candidate => candidate.id === task.work_group_id);
  const hasOptionalLocation = Boolean(storedProjectName || storedAddress || (canonicalTaskType === 'meeting' && project));
  const isStandaloneType = canonicalTaskType === 'internal'
    || canonicalTaskType === 'leave'
    || ((canonicalTaskType === 'meeting' || canonicalTaskType === 'other') && !hasOptionalLocation);
  const cardDetail = isStandaloneType
    ? taskTitle
    : `${districtName ? `[${districtName}] ` : ''}[${task.task_type.trim()}]${taskTitle ? ` ${taskTitle}` : ''}`;

  return {
    project,
    projectName,
    taskTitle,
    cardDetail,
    mainAssigneeName,
    collaboratorNames,
    assigneeDisplay: mainAssigneeName ? `主要：${mainAssigneeName}` : '',
    collaboratorDisplay: collaboratorNames.length > 0 ? `協同：${collaboratorNames.join('、')}` : '',
    district: districtName ? `[${districtName}]` : '',
    searchAddress,
    mapUrl: searchAddress ? getScheduleMapUrl(searchAddress) : '',
    workGroup,
    workGroupName: workGroup?.name || '未設定群組',
  };
}
