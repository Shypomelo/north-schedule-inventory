export type DashboardViewKey = 'ENGINEERING' | 'PROJECT_MANAGEMENT' | 'DESIGN';
export interface DashboardView { id: string; key: DashboardViewKey; name: string; is_active: boolean; sort_order: number }
export interface MemberDashboardView { member_id: string; dashboard_view_id: string; is_default: boolean }
export function resolveDashboardViews(member: { id: string; role: string }, views: DashboardView[], memberships: MemberDashboardView[]) {
  const rows = memberships.filter(row => row.member_id === member.id);
  const active = views.filter(view => view.is_active).sort((a,b) => a.sort_order-b.sort_order || a.key.localeCompare(b.key));
  const allowed = active.filter(view => member.role === 'ADMIN' || (rows.length ? rows.some(row => row.dashboard_view_id===view.id) : view.key==='ENGINEERING'));
  const defaultView = allowed.find(view => rows.some(row => row.dashboard_view_id===view.id && row.is_default))
    ?? allowed.find(view => view.key==='ENGINEERING') ?? allowed[0] ?? null;
  return { allowed, defaultView };
}
