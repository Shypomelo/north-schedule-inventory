export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export function positionContextMenu(
  point: ContextMenuPoint,
  menu: ContextMenuSize,
  viewport: ViewportSize,
  padding = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(padding, viewport.width - menu.width - padding);
  const maxTop = Math.max(padding, viewport.height - menu.height - padding);

  return {
    left: Math.max(padding, Math.min(point.x, maxLeft)),
    top: Math.max(padding, Math.min(point.y, maxTop)),
  };
}
