import type { WorkGroup } from './db/types';

export interface MemberWorkGroup {
  member_id: string;
  work_group_id: string;
  is_default: boolean;
}

export type WorkGroupResolution = {
  status: 'resolved';
  activeGroup: WorkGroup;
  activeGroups: WorkGroup[];
  source: 'default-membership' | 'membership' | 'legacy-engineering';
} | {
  status: 'configuration-required';
  activeGroup: null;
  activeGroups: WorkGroup[];
  source: null;
};

export function selectActiveWorkGroups(groups: WorkGroup[]): WorkGroup[] {
  return groups
    .filter(group => group.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}

function resolveWorkGroupMembership(
  memberId: string | undefined,
  memberships: MemberWorkGroup[],
  groups: WorkGroup[],
  allowLegacyEngineeringFallback: boolean,
): WorkGroupResolution {
  const active = selectActiveWorkGroups(groups);
  const links = memberships.filter(link => link.member_id === memberId);
  const linkedActive = active.filter(group => links.some(link => link.work_group_id === group.id));
  const defaultGroup = linkedActive.find(group => links.some(link => link.work_group_id === group.id && link.is_default));
  if (defaultGroup) return { status: 'resolved', activeGroup: defaultGroup, activeGroups: linkedActive, source: 'default-membership' };
  if (linkedActive[0]) return { status: 'resolved', activeGroup: linkedActive[0], activeGroups: linkedActive, source: 'membership' };
  if (links.length === 0 && allowLegacyEngineeringFallback) {
    const legacyGroup = active.find(group => group.key === 'ENGINEERING');
    if (legacyGroup) return { status: 'resolved', activeGroup: legacyGroup, activeGroups: [legacyGroup], source: 'legacy-engineering' };
  }
  return { status: 'configuration-required', activeGroup: null, activeGroups: [], source: null };
}

// Workspace preference only: never an authorization boundary or a position mapping.
export function resolveMemberDefaultWorkGroup(memberId: string | undefined, memberships: MemberWorkGroup[], groups: WorkGroup[]): WorkGroupResolution {
  return resolveWorkGroupMembership(memberId, memberships, groups, true);
}

export function resolveParticipantWorkGroups(
  participant: { id: string; category?: string },
  memberships: MemberWorkGroup[],
  groups: WorkGroup[],
): WorkGroupResolution {
  return resolveWorkGroupMembership(participant.id, memberships, groups, participant.category === 'ENGINEERING');
}

export function requireTodoWorkGroup(todo: { scope: string; work_group_id: string | null }): string {
  if (todo.scope !== 'TEAM' || !todo.work_group_id) throw new Error('團隊待辦缺少工作群組，無法轉為排程');
  return todo.work_group_id;
}
