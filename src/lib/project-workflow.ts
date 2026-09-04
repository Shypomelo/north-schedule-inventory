import type {
  ActivityActionType,
  ActivityLog,
  ProjectMilestone,
  ProjectMilestoneOrigin,
  ProjectMilestoneStatus,
} from './db/types';

type MilestoneOrderFields = Pick<ProjectMilestone, 'id' | 'sort_order' | 'created_at'>;
type SummaryFields = Pick<
  ProjectMilestone,
  'id' | 'sort_order' | 'created_at' | 'is_applicable' | 'status' | 'deleted_at'
>;
type PhaseOrderFields = MilestoneOrderFields & Pick<ProjectMilestone, 'phase_key_snapshot'>;
type WorkflowActivityAction = Extract<ActivityActionType, `WORKFLOW_${string}`>;

export interface WorkflowActivityInput {
  action: WorkflowActivityAction;
  targetType: 'PROJECT_WORKFLOW' | 'PROJECT_MILESTONE';
  targetId: string;
  targetLabel: string;
  projectId: string;
  projectName?: string | null;
  actorUserId: string;
  actorName: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export function sortWorkflowMilestones<T extends MilestoneOrderFields>(milestones: T[]): T[] {
  return [...milestones].sort((left, right) => (
    left.sort_order - right.sort_order
    || left.created_at.localeCompare(right.created_at)
    || left.id.localeCompare(right.id)
  ));
}

export function getCurrentAndNextMilestones<T extends SummaryFields>(milestones: T[]): {
  current: T | null;
  next: T | null;
} {
  const active = sortWorkflowMilestones(
    milestones.filter(milestone => milestone.deleted_at === null && milestone.is_applicable),
  );
  const current = active.find(milestone => (
    milestone.status === 'IN_PROGRESS' || milestone.status === 'BLOCKED'
  )) ?? active.find(milestone => milestone.status !== 'COMPLETED') ?? null;

  if (!current) return { current: null, next: null };
  const currentIndex = active.findIndex(milestone => milestone.id === current.id);
  const next = active.slice(currentIndex + 1).find(milestone => milestone.status !== 'COMPLETED') ?? null;
  return { current, next };
}

export function getVisibleWorkflowMilestones<T extends SummaryFields>(
  milestones: T[],
  hideCompleted: boolean,
): T[] {
  const ordered = sortWorkflowMilestones(milestones);
  return hideCompleted
    ? ordered.filter(milestone => milestone.status !== 'COMPLETED')
    : ordered;
}

export function normalizeMilestoneCompletion(
  status: ProjectMilestoneStatus,
  actualDate: string | null,
  today = new Date().toISOString().slice(0, 10),
): { status: ProjectMilestoneStatus; actual_date: string | null } {
  if (status === 'COMPLETED') {
    return { status, actual_date: actualDate || today };
  }
  return { status, actual_date: null };
}

export function getMilestoneCapabilities(origin: ProjectMilestoneOrigin) {
  const isCustom = origin === 'PROJECT_CUSTOM';
  return {
    editProgress: true,
    editIdentity: isCustom,
    changePosition: true,
    softDelete: isCustom,
  };
}

export function normalizeWorkflowSortOrders<T extends MilestoneOrderFields>(milestones: T[]): T[] {
  return milestones.map((milestone, index) => ({
    ...milestone,
    sort_order: (index + 1) * 10,
  }));
}

export function reorderWorkflowMilestones<T extends PhaseOrderFields>(
  milestones: T[],
  draggedId: string,
  targetId: string,
): T[] {
  const ordered = sortWorkflowMilestones(milestones);
  const dragged = ordered.find(milestone => milestone.id === draggedId);
  const target = ordered.find(milestone => milestone.id === targetId);
  if (!dragged || !target) throw new Error('找不到拖曳的流程項目');
  if (dragged.phase_key_snapshot !== target.phase_key_snapshot) {
    throw new Error('流程項目只能在同一階段內排序');
  }
  if (draggedId === targetId) return normalizeWorkflowSortOrders(ordered);

  const withoutDragged = ordered.filter(milestone => milestone.id !== draggedId);
  const targetIndex = withoutDragged.findIndex(milestone => milestone.id === targetId);
  withoutDragged.splice(targetIndex, 0, dragged);
  return normalizeWorkflowSortOrders(withoutDragged);
}

function formatActivityValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未設定';
  return String(value);
}

export function getWorkflowActivityMessage(
  action: WorkflowActivityAction,
  label: string,
  after: Record<string, unknown> | null = null,
): string {
  switch (action) {
    case 'WORKFLOW_INITIALIZED': return '專案流程已建立';
    case 'WORKFLOW_STATUS_CHANGED': {
      const status = after?.status;
      if (status === 'IN_PROGRESS') return `${label}開始`;
      if (status === 'COMPLETED') return `${label}完成`;
      if (status === 'BLOCKED') return `${label}標記為卡住`;
      if (status === 'NOT_STARTED') return `${label}重設為未開始`;
      return `${label}狀態已更新`;
    }
    case 'WORKFLOW_PLANNED_DATE_CHANGED':
      return `${label}預計日期改為 ${formatActivityValue(after?.planned_date)}`;
    case 'WORKFLOW_ACTUAL_DATE_CHANGED':
      return `${label}實際日期改為 ${formatActivityValue(after?.actual_date)}`;
    case 'WORKFLOW_NOTES_CHANGED': return `${label}備註已更新`;
    case 'WORKFLOW_APPLICABILITY_CHANGED':
      return `${label}設為${after?.is_applicable ? '適用' : '不適用'}`;
    case 'WORKFLOW_CUSTOM_CREATED': return `${label}新增`;
    case 'WORKFLOW_CUSTOM_UPDATED': return `${label}臨時項目已更新`;
    case 'WORKFLOW_CUSTOM_DELETED': return `${label}刪除`;
    case 'WORKFLOW_REORDERED': return '流程順序已調整';
  }
}

export function buildWorkflowActivityLog(
  input: WorkflowActivityInput,
): Omit<ActivityLog, 'id' | 'created_at'> {
  const before = input.before ?? null;
  const after = input.after ?? null;
  return {
    actor_user_id: input.actorUserId,
    actor_name: input.actorName,
    action_type: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    target_label: input.targetLabel,
    project_id: input.projectId,
    project_name: input.projectName ?? null,
    before_value: before ? JSON.stringify(before) : null,
    after_value: after ? JSON.stringify(after) : null,
    message: getWorkflowActivityMessage(input.action, input.targetLabel, after),
  };
}

export function getCustomInsertSortOrder<T extends MilestoneOrderFields>(
  milestones: T[],
  afterMilestoneId: string | null,
): number {
  const ordered = sortWorkflowMilestones(milestones);
  if (ordered.length === 0) return 10;

  if (afterMilestoneId === null) {
    return Math.max(0, ordered[0].sort_order - 10);
  }

  const afterIndex = ordered.findIndex(milestone => milestone.id === afterMilestoneId);
  if (afterIndex < 0) throw new Error('找不到指定的插入位置');
  const previousOrder = ordered[afterIndex].sort_order;
  const nextOrder = ordered.slice(afterIndex + 1)
    .find(milestone => milestone.sort_order > previousOrder)?.sort_order;

  if (nextOrder === undefined) return previousOrder + 10;
  if (nextOrder - previousOrder > 1) return previousOrder + Math.floor((nextOrder - previousOrder) / 2);

  // Integer space is exhausted. Sharing the preceding order remains stable
  // because reads use created_at/id as secondary ordering and avoids touching
  // immutable TEMPLATE ordering.
  return previousOrder;
}
