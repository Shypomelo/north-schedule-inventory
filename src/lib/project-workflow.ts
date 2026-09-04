import type {
  ProjectMilestone,
  ProjectMilestoneOrigin,
  ProjectMilestoneStatus,
} from './db/types';

type MilestoneOrderFields = Pick<ProjectMilestone, 'id' | 'sort_order' | 'created_at'>;
type SummaryFields = Pick<
  ProjectMilestone,
  'id' | 'sort_order' | 'created_at' | 'is_applicable' | 'status' | 'deleted_at'
>;

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
    changePosition: isCustom,
    softDelete: isCustom,
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
