import type { MemberProjectResponsibility, Project, ProjectMilestone } from './db/types';

export interface DashboardPositionProgress {
  positionId: string;
  positionName: string;
  state: 'UPCOMING' | 'CURRENT' | 'COMPLETED';
  current: ProjectMilestone | null;
  previous: ProjectMilestone | null;
}

export interface DashboardProjectCard {
  project: Project;
  progress: DashboardPositionProgress[];
  currentPlannedDate: string | null;
  isOverdue: boolean;
}

const byWorkflowOrder = (a: ProjectMilestone, b: ProjectMilestone) =>
  a.sort_order - b.sort_order
  || a.created_at.localeCompare(b.created_at)
  || a.id.localeCompare(b.id);

export function selectDashboardPositionProgress(
  responsibility: MemberProjectResponsibility,
): DashboardPositionProgress | null {
  const chain = [...responsibility.workflow_milestones].sort(byWorkflowOrder);
  const firstIncompleteIndex = chain.findIndex(milestone => milestone.status !== 'COMPLETED');
  const assignedIds = new Set(responsibility.milestones.map(milestone => milestone.id));

  if (firstIncompleteIndex < 0) {
    const completed = [...chain].reverse().find(milestone => (
      assignedIds.has(milestone.id) && milestone.status === 'COMPLETED'
    ));
    return completed ? {
      positionId: responsibility.position.id,
      positionName: responsibility.position.name,
      state: 'COMPLETED',
      current: completed,
      previous: null,
    } : null;
  }

  const current = chain[firstIncompleteIndex];
  if (!assignedIds.has(current.id)) return null;

  return {
    positionId: responsibility.position.id,
    positionName: responsibility.position.name,
    state: current.status === 'IN_PROGRESS' ? 'CURRENT' : 'UPCOMING',
    current,
    previous: firstIncompleteIndex > 0 ? chain[firstIncompleteIndex - 1] : null,
  };
}

export function buildDashboardProjectCards(
  responsibilities: MemberProjectResponsibility[],
  today: string,
): DashboardProjectCard[] {
  const grouped = new Map<string, DashboardProjectCard>();

  responsibilities.forEach(responsibility => {
    const progress = selectDashboardPositionProgress(responsibility);
    if (!progress) return;
    const existing = grouped.get(responsibility.project.id) ?? {
      project: responsibility.project,
      progress: [],
      currentPlannedDate: null,
      isOverdue: false,
    };
    existing.progress.push(progress);
    grouped.set(responsibility.project.id, existing);
  });

  const cards = Array.from(grouped.values()).map(card => {
    const dates = card.progress
      .filter(group => group.state !== 'COMPLETED')
      .map(group => group.current?.planned_date)
      .filter((date): date is string => Boolean(date))
      .sort();
    const currentPlannedDate = dates[0] ?? null;
    return {
      ...card,
      progress: card.progress.sort((a, b) => a.positionName.localeCompare(b.positionName)),
      currentPlannedDate,
      isOverdue: Boolean(currentPlannedDate && currentPlannedDate < today),
    };
  });

  return cards.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    if (a.currentPlannedDate && b.currentPlannedDate) {
      return a.currentPlannedDate.localeCompare(b.currentPlannedDate)
        || a.project.name.localeCompare(b.project.name);
    }
    if (a.currentPlannedDate) return -1;
    if (b.currentPlannedDate) return 1;
    return a.project.name.localeCompare(b.project.name);
  });
}
