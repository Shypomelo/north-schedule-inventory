import { supabase } from './supabaseClient';
import type { DashboardView, MemberDashboardView } from '../dashboard-perspectives';
export const perspectiveAdapter = {
  async getDashboardViews(): Promise<DashboardView[]> {
    const {data,error}=await supabase.from('dashboard_views').select('*').order('sort_order');
    if(error) throw new Error('工作視角無法載入；請確認 candidate migration 已於測試環境套用。');
    return data || [];
  },
  async getMemberDashboardViews(memberId?: string): Promise<MemberDashboardView[]> {
    let query=supabase.from('member_dashboard_views').select('*');
    if(memberId) query=query.eq('member_id',memberId);
    const {data,error}=await query; if(error) throw error; return data || [];
  },
  async setMemberDashboardViews(memberId:string,ids:string[],defaultId:string|null) {
    const {error}=await supabase.rpc('set_member_dashboard_views',{p_member_id:memberId,p_view_ids:ids,p_default_id:defaultId});
    if(error) throw error;
  },
};
