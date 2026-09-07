import type {
  MemberProjectResponsibility,
  Position,
  Project,
  ProjectMilestone,
  ProjectPositionAssignment,
  User,
} from './db/types';

const byWorkflowOrder = (a: ProjectMilestone, b: ProjectMilestone) =>
  a.sort_order - b.sort_order
  || a.created_at.localeCompare(b.created_at)
  || a.id.localeCompare(b.id);

export function getPositionMilestoneProgress(
  milestones: ProjectMilestone[],
  positionId: string,
) {
  const applicable = milestones
    .filter(milestone => milestone.deleted_at === null && milestone.is_applicable)
    .sort(byWorkflowOrder);
  const currentIndex = applicable.findIndex(milestone =>
    milestone.responsible_position_id === positionId
    && milestone.status !== 'COMPLETED');
  const current = currentIndex >= 0 ? applicable[currentIndex] : null;

  return {
    current_milestone: current,
    previous_milestone: currentIndex > 0 ? applicable[currentIndex - 1] : null,
    current_planned_date: current?.planned_date ?? null,
  };
}

export function getPositionCandidates(
  users: User[],
  memberPositions: { member_id: string; position_id: string }[],
  positionId: string,
) {
  const eligibleIds = new Set(
    memberPositions
      .filter(link => link.position_id === positionId)
      .map(link => link.member_id),
  );
  return users.filter(user => user.is_active && eligibleIds.has(user.id));
}

export function buildMemberProjectResponsibilities({
  memberId,
  assignments,
  projects,
  positions,
  milestones,
}: {
  memberId: string;
  assignments: ProjectPositionAssignment[];
  projects: Project[];
  positions: Position[];
  milestones: ProjectMilestone[];
}): MemberProjectResponsibility[] {
  const projectById = new Map(projects.map(project => [project.id, project]));
  const positionById = new Map(positions.map(position => [position.id, position]));

  return assignments
    .filter(assignment => assignment.member_id === memberId)
    .flatMap(assignment => {
      const project = projectById.get(assignment.project_id);
      const position = positionById.get(assignment.position_id);
      if (!project?.is_active || !position) return [];
      const projectMilestones = milestones.filter(milestone =>
        milestone.project_id === project.id
        && milestone.responsible_position_id === position.id
        && milestone.is_applicable
        && milestone.deleted_at === null);
      const progress = getPositionMilestoneProgress(
        milestones.filter(milestone => milestone.project_id === project.id),
        position.id,
      );
      return [{
        assignment,
        project,
        position,
        milestones: projectMilestones.sort(byWorkflowOrder),
        ...progress,
      }];
    })
    .sort((a, b) => a.project.name.localeCompare(b.project.name)
      || a.position.sort_order - b.position.sort_order
      || a.position.name.localeCompare(b.position.name));
}
