import type { WorkGroup } from './db/types';

export interface MemberWorkGroup {
  member_id: string;
  work_group_id: string;
  is_default: boolean;
}

// Workspace preference only: never an authorization boundary or a position mapping.
export function resolveMemberDefaultWorkGroup(memberId: string | undefined, memberships: MemberWorkGroup[], groups: WorkGroup[]): WorkGroup | undefined {
  const active = groups.filter(group => group.is_active).sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
  const links = memberships.filter(link => link.member_id === memberId);
  return active.find(group => links.some(link => link.work_group_id === group.id && link.is_default))
    || active.find(group => links.some(link => link.work_group_id === group.id))
    || active.find(group => group.key === 'ENGINEERING');
}

export function requireTodoWorkGroup(todo: { scope: string; work_group_id: string | null }): string {
  if (todo.scope !== 'TEAM' || !todo.work_group_id) throw new Error('團隊待辦缺少工作群組，無法轉為排程');
  return todo.work_group_id;
}
