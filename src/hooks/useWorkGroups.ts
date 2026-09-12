"use client";

import { useEffect, useState } from 'react';
import { dbAdapter } from '@/lib/db';
import { useUser } from '@/components/UserContext';
import type { WorkGroup } from '@/lib/db/types';
import { MemberWorkGroup, resolveMemberDefaultWorkGroup, selectActiveWorkGroups } from '@/lib/work-groups';

export function useWorkGroups() {
  const { currentUser } = useUser();
  const memberId = currentUser?.id;
  const [groups, setGroups] = useState<WorkGroup[]>([]);
  const [memberships, setMemberships] = useState<MemberWorkGroup[]>([]);
  const [loadedMember, setLoadedMember] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!memberId) { setLoadedMember(undefined); return; }
    setLoadedMember(undefined);
    Promise.all([dbAdapter.getWorkGroups(), dbAdapter.getMemberWorkGroups(memberId)])
      .then(([g, m]) => { if (!cancelled) { setGroups(g); setMemberships(m); setLoadedMember(memberId); } })
      .catch(() => { if (!cancelled) { setError('工作群組載入失敗，請重新整理'); setLoadedMember(memberId); } });
    return () => { cancelled = true; };
  }, [memberId]);
  const resolution = resolveMemberDefaultWorkGroup(currentUser?.id, memberships, groups);
  return {
    groups: selectActiveWorkGroups(groups),
    memberships,
    error,
    ready: Boolean(currentUser && loadedMember === currentUser.id),
    resolution,
    defaultGroup: resolution.activeGroup,
    configurationRequired: resolution.status === 'configuration-required',
  };
}
