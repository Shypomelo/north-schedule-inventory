import type { DashboardView, DashboardViewKey } from './dashboard-perspectives';

export type DashboardSubpage = 'overview' | 'maintenance' | 'receiving';

export const dashboardPerspectiveStorageKey = (memberId: string) => (
  `north-engineering-dashboard-perspective:${memberId}`
);

export const dashboardSubpageStorageKey = (memberId: string, perspective: DashboardViewKey) => (
  `north-engineering-dashboard-subpage:${memberId}:${perspective}`
);

export const availableDashboardSubpages = (perspective: DashboardViewKey): DashboardSubpage[] => (
  perspective === 'ENGINEERING'
    ? ['overview', 'maintenance', 'receiving']
    : ['overview', 'receiving']
);

export const resolveDashboardSubpage = (
  perspective: DashboardViewKey,
  saved: string | null,
): DashboardSubpage => {
  const available = availableDashboardSubpages(perspective);
  return available.includes(saved as DashboardSubpage) ? saved as DashboardSubpage : available[0];
};

export const resolveSavedDashboardView = (
  allowed: DashboardView[],
  fallback: DashboardView | null,
  saved: string | null,
): DashboardView | null => allowed.find(view => view.key === saved) ?? fallback ?? allowed[0] ?? null;
