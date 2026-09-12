import type { MemberWorkGroup } from '../work-groups';

// Authenticated client only. Foundation RLS is the final authorization boundary.
export function createWorkGroupAdapter(client: any) {
  const getMemberWorkGroups = async (memberId?: string): Promise<MemberWorkGroup[]> => {
    let query = client.from('member_work_groups').select('member_id, work_group_id, is_default');
    if (memberId) query = query.eq('member_id', memberId);
    const { data, error } = await query.order('work_group_id');
    if (error) throw error;
    return data || [];
  };
  return {
    getMemberWorkGroups,
    async setMemberWorkGroups(memberId: string, groupIds: string[], defaultId: string | null) {
      const { data: auth, error: authError } = await client.auth.getUser();
      if (authError || !auth.user?.email) throw new Error('需要登入');
      const { data: actors, error: actorError } = await client.from('team_members').select('email, role, is_active').is('deleted_at', null);
      const actor = actors?.find((row: any) => row.email?.trim().toLowerCase() === auth.user.email.trim().toLowerCase());
      if (actorError || !actor?.is_active || actor.role?.toUpperCase() !== 'ADMIN') throw new Error('只有 ADMIN 可以修改工作群組');
      const ids = Array.from(new Set(groupIds));
      if (ids.length && (!defaultId || !ids.includes(defaultId))) throw new Error('請指定已加入群組中的一個預設群組');
      if (!ids.length && defaultId) throw new Error('未加入群組不能指定預設');
      const { data: groups, error: groupError } = await client.from('work_groups').select('id').eq('is_active', true);
      if (groupError || ids.some(id => !groups?.some((g: any) => g.id === id))) throw new Error('工作群組無效或已停用');
      const before = await getMemberWorkGroups(memberId);
      const check = (result: any) => { if (result.error) throw result.error; };
      try {
        // Add first without a default; do not delete/recreate existing membership rows.
        const additions = ids.filter(id => !before.some(row => row.work_group_id === id));
        if (additions.length) check(await client.from('member_work_groups').insert(additions.map(id => ({ member_id: memberId, work_group_id: id, is_default: false }))));
        const currentDefault = before.find(row => row.is_default)?.work_group_id || null;
        if (currentDefault !== defaultId) {
          check(await client.from('member_work_groups').update({ is_default: false }).eq('member_id', memberId).eq('is_default', true));
          if (defaultId) check(await client.from('member_work_groups').update({ is_default: true }).eq('member_id', memberId).eq('work_group_id', defaultId).select().single());
        }
        const removed = before.filter(row => !ids.includes(row.work_group_id)).map(row => row.work_group_id);
        if (removed.length) check(await client.from('member_work_groups').delete().eq('member_id', memberId).in('work_group_id', removed));
        const saved = await getMemberWorkGroups(memberId);
        if (saved.length !== ids.length || saved.some(row => !ids.includes(row.work_group_id) || row.is_default !== (row.work_group_id === defaultId))) throw new Error('儲存結果已變更');
        return saved;
      } catch {
        // Multi-request operation, not a DB transaction. Never pretend partial success is atomic.
        throw new Error('工作群組未完整儲存（可能部分成功或有其他管理員同時修改），請重新載入確認後再儲存');
      }
    },
  };
}
