'use client';

import type { MouseEvent, ReactNode } from 'react';
import type { Todo } from '@/lib/db/types';
import { TEAM_TODO_CARD_CLASS } from '@/lib/todo-presentation';

export function TodoRow({
  todo,
  statusControl,
  title,
  secondary,
  onActivate,
  onOpenMenu,
  menuDisabled = false,
  draggable = false,
  onDragStart,
  className = '',
}: {
  todo: Todo;
  statusControl?: ReactNode;
  title?: ReactNode;
  secondary?: ReactNode;
  onActivate?: () => void;
  onOpenMenu?: (point: { x: number; y: number }) => void;
  menuDisabled?: boolean;
  draggable?: boolean;
  onDragStart?: React.DragEventHandler<HTMLElement>;
  className?: string;
}) {
  const openPointerMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!menuDisabled) onOpenMenu?.({ x: event.clientX, y: event.clientY });
  };

  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onActivate}
      onContextMenu={openPointerMenu}
      className={`${TEAM_TODO_CARD_CLASS} flex min-w-0 items-start gap-3 px-3 py-2.5 ${onActivate ? 'cursor-pointer' : ''} ${className}`}
    >
      {statusControl ? <div className="mt-0.5 shrink-0">{statusControl}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-medium leading-5 text-primary">{title ?? todo.title}</div>
        {secondary ? <div className="mt-1 text-xs leading-4 text-secondary">{secondary}</div> : null}
      </div>
      {onOpenMenu ? (
        <button
          type="button"
          disabled={menuDisabled}
          aria-label={`${todo.title} 更多操作`}
          className="flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded text-lg text-secondary hover:bg-page disabled:cursor-not-allowed disabled:opacity-50 md:hidden"
          onClick={event => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu({ x: rect.right, y: rect.bottom });
          }}
        >
          ⋯
        </button>
      ) : null}
    </article>
  );
}
