'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { positionContextMenu, type ContextMenuPoint } from '@/lib/context-menu-position';

export interface TodoContextMenuAction {
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
}

export function TodoContextMenu({ point, actions, onClose }: {
  point: ContextMenuPoint | null;
  actions: readonly TodoContextMenuAction[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!point || !menuRef.current) {
      setPosition(null);
      return;
    }
    const menu = menuRef.current.getBoundingClientRect();
    setPosition(positionContextMenu(
      point,
      { width: menu.width, height: menu.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [point]);

  useEffect(() => {
    if (!point) return;
    const close = () => onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('click', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, point]);

  if (!mounted || !point) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="待辦操作"
      className="fixed z-[100] min-w-36 rounded-lg border border-theme-border bg-card p-1 text-sm shadow-xl"
      style={{
        left: position?.left ?? point.x,
        top: position?.top ?? point.y,
        visibility: position ? 'visible' : 'hidden',
      }}
      onClick={event => event.stopPropagation()}
    >
      {actions.map(action => (
        <button
          key={action.label}
          role="menuitem"
          type="button"
          disabled={action.disabled}
          onClick={() => {
            if (action.disabled) return;
            onClose();
            action.onSelect();
          }}
          className={`min-h-10 w-full rounded px-3 text-left transition hover:bg-page disabled:cursor-not-allowed disabled:opacity-50 ${
            action.tone === 'danger' ? 'text-danger hover:bg-danger/10' : action.tone === 'accent' ? 'text-accent' : ''
          }`}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
