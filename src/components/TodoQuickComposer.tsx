'use client';

import type { FormEvent } from 'react';
import { Loader2, Plus } from 'lucide-react';

export function TodoQuickComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  isSaving,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  placeholder: string;
  disabled: boolean;
  isSaving: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="mb-3 flex items-center gap-2 border-b border-theme-border pb-3">
      <Plus size={17} className="shrink-0 text-accent" />
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled || isSaving}
        placeholder={disabled ? '僅可檢視' : placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-secondary/70 disabled:cursor-not-allowed"
      />
      <button
        type="submit"
        disabled={disabled || isSaving || !value.trim()}
        className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-accent-hover disabled:opacity-40"
      >
        {isSaving ? <Loader2 className="animate-spin" size={14} /> : '新增'}
      </button>
    </form>
  );
}
