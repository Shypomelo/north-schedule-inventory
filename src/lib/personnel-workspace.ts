import type { MemberPosition, Position, Project, ProjectPositionAssignment, User, UserRole } from './db/types';
import { isActiveProject } from './project-selectors';

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: '管理員',
  ENGINEER: '一般使用者',
  VIEWER: '唯讀',
};

export const ENGINEERING_POSITION_NAME = '工程';

const normalizePositionName = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('zh-TW');

export function resolveEngineeringPosition(positions: Position[]): Position | null {
  const expected = normalizePositionName(ENGINEERING_POSITION_NAME);
  return positions.find(position => position.is_active && normalizePositionName(position.name) === expected) ?? null;
}

export function selectEngineeringMembers(
  users: User[],
  positions: Position[],
  memberPositions: MemberPosition[],
): User[] {
  const engineeringPosition = resolveEngineeringPosition(positions);
  if (!engineeringPosition) return [];
  const memberIds = new Set(memberPositions
    .filter(link => link.position_id === engineeringPosition.id)
    .map(link => link.member_id));
  return users.filter(user => user.is_active && memberIds.has(user.id));
}

export function selectProjectsForEngineeringMember(
  projectIds: string[],
  memberId: string,
  positions: Position[],
  assignments: ProjectPositionAssignment[],
): string[] {
  const engineeringPosition = resolveEngineeringPosition(positions);
  if (!engineeringPosition) return [];
  const allowed = new Set(assignments
    .filter(assignment => assignment.member_id === memberId && assignment.position_id === engineeringPosition.id)
    .map(assignment => assignment.project_id));
  return projectIds.filter(id => allowed.has(id));
}

export function selectActiveProjectsForEngineeringMember<T extends Pick<Project, 'id' | 'status' | 'is_active'>>(
  projects: T[],
  memberId: string,
  positions: Position[],
  assignments: ProjectPositionAssignment[],
): T[] {
  const assignedProjectIds = new Set(selectProjectsForEngineeringMember(
    projects.map(project => project.id),
    memberId,
    positions,
    assignments,
  ));
  return projects.filter(project => assignedProjectIds.has(project.id) && isActiveProject(project));
}

export function keepValidDefault(selectedIds: string[], defaultId: string | null): string | null {
  return defaultId && selectedIds.includes(defaultId) ? defaultId : selectedIds[0] ?? null;
}
