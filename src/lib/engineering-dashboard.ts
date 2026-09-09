import type { MemberProjectResponsibility, Project, ProjectMilestone } from './db/types';

export interface DashboardPositionProgress {
  positionId: string;
  positionName: string;
  current: ProjectMilestone | null;
  previous: ProjectMilestone | null;
}

export interface DashboardProjectCard {
  project: Project;
  progress: DashboardPositionProgress[];
  currentPlannedDate: string | null;
  isOverdue: boolean;
}

export function buildDashboardProjectCards(
  responsibilities: MemberProjectResponsibility[],
  today: string,
): DashboardProjectCard[] {
  const grouped = new Map<string, DashboardProjectCard>();

  responsibilities.forEach(responsibility => {
    const existing = grouped.get(responsibility.project.id) ?? {
      project: responsibility.project,
      progress: [],
      currentPlannedDate: null,
      isOverdue: false,
    };
    existing.progress.push({
      positionId: responsibility.position.id,
      positionName: responsibility.position.name,
      current: responsibility.current_milestone,
      previous: responsibility.previous_milestone,
    });
    grouped.set(responsibility.project.id, existing);
  });

  const cards = Array.from(grouped.values()).map(card => {
    const dates = card.progress
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
