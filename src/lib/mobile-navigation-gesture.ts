export const MOBILE_NAV_EDGE_PX = 32;
export const MOBILE_NAV_MIN_SWIPE_PX = 64;
export const MOBILE_NAV_MAX_VERTICAL_PX = 48;

export type SwipePoint = { x: number; y: number };

export function isMobileNavigationEdgeSwipe(start: SwipePoint, end: SwipePoint): boolean {
  return start.x >= 0
    && start.x <= MOBILE_NAV_EDGE_PX
    && end.x - start.x >= MOBILE_NAV_MIN_SWIPE_PX
    && Math.abs(end.y - start.y) <= MOBILE_NAV_MAX_VERTICAL_PX;
}
