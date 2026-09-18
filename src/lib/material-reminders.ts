import type {
  MemberProjectResponsibility,
  Project,
  ProjectMaterial,
  ProjectMaterialBatch,
  ScheduleTask,
  User,
} from './db/types';
import { ENGINEERING_POSITION_NAME } from './engineering-responsibilities';
import { isActiveProject } from './project-selectors';
import { getEffectiveExpectedDeliveryAt, receiptGroupKey } from './material-receipt-time';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MATERIAL_REMINDER_HORIZON_DAYS = 14;
export const RECEIVING_SCHEDULE_TASK_TYPE = '收料';

export interface RecentReceiptGroup {
  project: Project;
  batch: ProjectMaterialBatch;
  materials: ProjectMaterial[];
  expectedDeliveryAt: string;
  status: 'OVERDUE' | 'UPCOMING';
  overdueDays: number;
  isPartial: boolean;
  scheduleTaskId: string | null;
  receiptGroupKey: string;
}

const validTime = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

export function selectEngineeringProjectIds(
  responsibilities: MemberProjectResponsibility[],
  memberId: string,
): string[] {
  return Array.from(new Set(responsibilities
    .filter(row => row.assignment.member_id === memberId)
    .filter(row => row.position.name.trim() === ENGINEERING_POSITION_NAME)
    .filter(row => isActiveProject(row.project))
    .map(row => row.project.id)));
}

const shouldRemindForUpcomingDelivery = (
  material: ProjectMaterial,
  deliveryTime: number,
  nowTime: number,
) => {
  if (!material.reminder_enabled || material.reminder_days_before === null) return false;
  return nowTime >= deliveryTime - material.reminder_days_before * DAY_MS;
};

export function selectRecentReceiptGroups({
  memberId,
  responsibilities,
  projects,
  batches,
  materials,
  scheduleTasks,
  now = new Date(),
  horizonDays = MATERIAL_REMINDER_HORIZON_DAYS,
}: {
  memberId: string;
  responsibilities: MemberProjectResponsibility[];
  projects: Project[];
  batches: ProjectMaterialBatch[];
  materials: ProjectMaterial[];
  scheduleTasks: ScheduleTask[];
  now?: Date;
  horizonDays?: number;
}): RecentReceiptGroup[] {
  const ownedProjectIds = new Set(selectEngineeringProjectIds(responsibilities, memberId));
  const projectById = new Map(projects.filter(isActiveProject).map(project => [project.id, project]));
  const scheduledTaskByGroup = new Map(scheduleTasks
    .filter(task => task.source_material_batch_id && task.source_material_receipt_at)
    .filter(task => !['取消', '完成', '已完成'].includes(task.status))
    .map(task => [receiptGroupKey(task.source_material_batch_id as string, task.source_material_receipt_at as string), task.id]));
  const nowTime = now.getTime();
  const horizonTime = nowTime + horizonDays * DAY_MS;
  return batches.flatMap(batch => {
    if (!ownedProjectIds.has(batch.project_id) || batch.received_at) return [];
    const project = projectById.get(batch.project_id);
    if (!project) return [];
    const unfinishedMaterials = materials
      .filter(material => material.batch_id === batch.id && material.project_id === batch.project_id)
      .filter(material => material.procurement_status !== 'RECEIVED' && !material.received_at);
    const grouped = new Map<string, ProjectMaterial[]>();
    for (const material of unfinishedMaterials) {
      const effective = getEffectiveExpectedDeliveryAt(material, batch);
      if (!effective || validTime(effective) === null) continue;
      grouped.set(effective, [...(grouped.get(effective) || []), material]);
    }
    return Array.from(grouped.entries()).flatMap(([expectedDeliveryAt, groupMaterials]) => {
      const expectedTime = validTime(expectedDeliveryAt) as number;
      if (expectedTime > horizonTime) return [];
      const sortedMaterials = [...groupMaterials].sort((left, right) => left.item_name.localeCompare(right.item_name, 'zh-TW'));
      if (expectedTime >= nowTime && !sortedMaterials.some(material => (
        shouldRemindForUpcomingDelivery(material, expectedTime, nowTime)
      ))) return [];
      const overdue = expectedTime < nowTime;
      const groupKey = receiptGroupKey(batch.id, expectedDeliveryAt);
      return [{
        project,
        batch,
        materials: sortedMaterials,
        expectedDeliveryAt,
        status: overdue ? 'OVERDUE' as const : 'UPCOMING' as const,
        overdueDays: overdue ? Math.max(1, Math.ceil((nowTime - expectedTime) / DAY_MS)) : 0,
        isPartial: sortedMaterials.some(material => material.procurement_status === 'PARTIAL_RECEIVED'),
        scheduleTaskId: scheduledTaskByGroup.get(groupKey) ?? null,
        receiptGroupKey: groupKey,
      }];
    });
  }).sort((left, right) => (
    (left.status === 'OVERDUE' ? 0 : 1) - (right.status === 'OVERDUE' ? 0 : 1)
    || left.expectedDeliveryAt.localeCompare(right.expectedDeliveryAt)
    || left.project.name.localeCompare(right.project.name, 'zh-TW')
    || left.batch.batch_name.localeCompare(right.batch.batch_name, 'zh-TW')
  ));
}

const taipeiDateTimeParts = (value: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
};

export function formatRecentReceiptDateTime(value: string): string {
  const parts = taipeiDateTimeParts(value);
  return `${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`;
}

export function formatMaterialReceiptSummary(material: ProjectMaterial): string {
  const label = material.specification?.trim() || material.item_name.trim();
  const quantity = Number.isInteger(material.quantity)
    ? String(material.quantity)
    : String(Number(material.quantity.toFixed(3)));
  return `${label} × ${quantity}${material.unit}`;
}

export function buildReceiptScheduleTask({
  group,
  workGroupId,
  owner,
  creator,
}: {
  group: RecentReceiptGroup;
  workGroupId: string;
  owner: Pick<User, 'id'>;
  creator: Pick<User, 'id' | 'name'>;
}): Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'> {
  const parts = taipeiDateTimeParts(group.expectedDeliveryAt);
  const summary = group.materials.slice(0, 5).map(formatMaterialReceiptSummary);
  if (group.materials.length > summary.length) summary.push(`另 ${group.materials.length - summary.length} 項`);
  return {
    work_group_id: workGroupId,
    task_type: RECEIVING_SCHEDULE_TASK_TYPE,
    title: RECEIVING_SCHEDULE_TASK_TYPE,
    project_id: group.project.id,
    project_name: group.project.name,
    address: group.project.address,
    task_date: `${parts.year}-${parts.month}-${parts.day}`,
    start_time: `${parts.hour}:${parts.minute}`,
    end_time: null,
    is_all_day: false,
    is_tentative: false,
    status: '',
    main_assignee_id: owner.id,
    description: [`${group.batch.batch_name}｜${group.materials.length} 項物料`, ...summary].join('\n'),
    google_calendar_id: null,
    google_event_id: null,
    google_sync_status: 'pending',
    google_sync_error: null,
    last_synced_at: null,
    created_by: creator.id,
    created_by_user_id: creator.id,
    created_by_name: creator.name,
    creation_source: 'APP',
    source_todo_id: null,
    source_material_batch_id: group.batch.id,
    source_material_receipt_at: group.expectedDeliveryAt,
  };
}

export function isMaterialBatchScheduleDuplicate(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}
