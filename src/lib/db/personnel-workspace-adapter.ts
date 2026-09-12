import type { UserRole } from './types';

export interface PersonnelWorkspaceProfileInput {
  memberId: string | null;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  googleCalendarEmail: string | null;
  notes: string | null;
  positionIds: string[];
  workGroupIds: string[];
  defaultWorkGroupId: string | null;
  dashboardViewIds: string[];
  defaultDashboardViewId: string | null;
}

export function createPersonnelWorkspaceAdapter(client: any) {
  return {
    async updateMemberWorkspaceProfile(input: PersonnelWorkspaceProfileInput): Promise<string> {
      const { data, error } = await client.rpc('update_member_workspace_profile', {
        p_member_id: input.memberId,
        p_name: input.name.trim(),
        p_email: input.email.trim(),
        p_role: input.role,
        p_is_active: input.isActive,
        p_google_calendar_email: input.googleCalendarEmail?.trim() || null,
        p_notes: input.notes?.trim() || null,
        p_position_ids: Array.from(new Set(input.positionIds)),
        p_work_group_ids: Array.from(new Set(input.workGroupIds)),
        p_default_work_group_id: input.defaultWorkGroupId,
        p_dashboard_view_ids: Array.from(new Set(input.dashboardViewIds)),
        p_default_dashboard_view_id: input.defaultDashboardViewId,
      });
      if (error) throw error;
      if (!data) throw new Error('人員工作區設定未回傳人員 ID');
      return data as string;
    },
  };
}
