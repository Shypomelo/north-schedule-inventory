'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';

export type ReceivingActionId = 'return' | 'post' | 'route-se' | 'route-site' | 'resolve' | 'cancel-arrival' | 'view' | 'delete';
export type ReceivingActionTarget = {
  type: 'history' | 'received' | 'pending'; key: string; receiptId: string | null;
  arrivalLineIds: string[]; state: string;
  pendingSource?: { type: 'PROJECT_MATERIAL' | 'SE_SUPPLY'; id: string; updatedAt: string };
  actions: { id: ReceivingActionId; label: string }[];
};
type OpenMenu = { target: ReceivingActionTarget; x: number; y: number; touch: boolean };
const pressDelay = 520;
const moveTolerance = 12;
const noSelection = { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-y' } as const;

export function useReceivingActionMenu(onAction: (target: ReceivingActionTarget, action: ReceivingActionId) => void) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef<{ key: string; pointerId: number; x: number; y: number } | null>(null);
  const suppressClick = useRef<{ key: string; until: number } | null>(null);
  const clearPress = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; active.current = null; }, []);
  const open = useCallback((target: ReceivingActionTarget, x: number, y: number, touch: boolean) => {
    if (!target.actions.length) return;
    setPosition(null); setMenu({ target, x, y, touch });
  }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: globalThis.PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    const focusFrame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    return () => { cancelAnimationFrame(focusFrame); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keydown); };
  }, [menu]);
  useEffect(() => { const cancel = () => clearPress(); window.addEventListener('scroll', cancel, true); return () => window.removeEventListener('scroll', cancel, true); }, [clearPress]);
  useEffect(() => () => clearPress(), [clearPress]);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    if (menu.touch || window.innerWidth < 640) return;
    const box = menuRef.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8)) });
  }, [menu]);
  const interactive = (event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    const element = event.target as HTMLElement;
    const control = element.closest('button,input,textarea,select,a,[contenteditable="true"],[role="menu"]');
    return Boolean(control && control !== event.currentTarget);
  };
  const bind = (target: ReceivingActionTarget) => ({
    style: noSelection,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      if (interactive(event) || !target.actions.length) return;
      event.preventDefault();
      if (suppressClick.current?.key === target.key && Date.now() < suppressClick.current.until) return;
      open(target, event.clientX, event.clientY, false);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch' || interactive(event) || !target.actions.length) return;
      clearPress(); suppressClick.current = null;
      active.current = { key: target.key, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        const current = active.current;
        if (!current || current.pointerId !== event.pointerId) return;
        suppressClick.current = { key: target.key, until: Date.now() + 800 };
        open(target, current.x, current.y, true);
        clearPress();
      }, pressDelay);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = active.current;
      if (current?.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > moveTolerance) clearPress();
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => { if (active.current?.pointerId === event.pointerId) clearPress(); },
    onPointerCancel: () => clearPress(),
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (suppressClick.current?.key === target.key && Date.now() < suppressClick.current.until) {
        event.preventDefault(); event.stopPropagation(); suppressClick.current = null;
      }
    },
  });
  const openFromButton = (target: ReceivingActionTarget, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    open(target, rect.right - 184, rect.bottom + 4, window.innerWidth < 640);
  };
  const popup = menu ? createPortal(<div className={menu.touch || typeof window !== 'undefined' && window.innerWidth < 640
    ? 'fixed inset-x-0 bottom-0 z-[80] border-t border-theme-border bg-card p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-xl'
    : 'fixed z-[80] min-w-44 rounded-lg border border-theme-border bg-card p-1 shadow-xl'}
    ref={menuRef} role="menu" aria-label="收貨操作" style={menu.touch || typeof window !== 'undefined' && window.innerWidth < 640 ? undefined
      : { left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position ? 'visible' : 'hidden' }}>
    {menu.target.actions.map(action => <button key={action.id} type="button" role="menuitem" className={'min-h-11 w-full rounded-md px-3 text-left text-sm hover:bg-page focus:bg-page focus:outline-accent' + (action.id === 'delete' ? ' text-danger' : '')} onClick={() => { const target = menu.target; setMenu(null); onAction(target, action.id); }}>{action.label}</button>)}
  </div>, document.body) : null;
  return { menu, bind, openFromButton, popup };
}
