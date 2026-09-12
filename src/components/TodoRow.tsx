'use client';

import type { MouseEvent, ReactNode } from 'react';
import type { Todo } from '@/lib/db/types';

export function TodoRow({
  todo,
  statusControl,
  title,
  secondary,
  content,
  secondaryClassName = 'mt-1 text-xs text-secondary',
  onActivate,
  onOpenMenu,
  menuDisabled = false,
  menuButtonClassName = 'flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded text-lg disabled:opacity-50 md:hidden',
  draggable = false,
  onDragStart,
  className = '',
}: {
  todo: Todo;
  statusControl?: ReactNode;
  title?: ReactNode;
  secondary?: ReactNode;
  content?: ReactNode;
  secondaryClassName?: string;
  onActivate?: () => void;
  onOpenMenu?: (point: { x: number; y: number }) => void;
  menuDisabled?: boolean;
  menuButtonClassName?: string;
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
      className={`min-w-0 ${onActivate ? 'cursor-pointer' : ''} ${className}`}
    >
      {content ?? <>
        {statusControl ? <div className="mt-0.5 shrink-0">{statusControl}</div> : null}
        <div className="min-w-0 flex-1">
          {title ?? todo.title}
          {secondary ? <div className={secondaryClassName}>{secondary}</div> : null}
        </div>
      </>}
      {onOpenMenu ? (
        <button
          type="button"
          disabled={menuDisabled}
          aria-label={`${todo.title} 更多操作`}
          className={menuButtonClassName}
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
