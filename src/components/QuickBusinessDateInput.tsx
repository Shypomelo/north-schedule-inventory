"use client";

import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { normalizeConstructionDateInput } from '@/lib/construction-progress';

export function QuickBusinessDateInput({ value, today, label, disabled, onCommit }: {
  value: string | null;
  today: string;
  label: string;
  disabled: boolean;
  onCommit: (value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!editing) setDraft(value ?? ''); }, [value, editing]);
  const commit = () => {
    try {
      const normalized = normalizeConstructionDateInput(draft, today);
      setError(null);
      if (normalized !== value) onCommit(normalized);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '日期格式無效');
      setDraft(value ?? '');
    }
    setEditing(false);
  };
  return <div className="min-w-0">
    <div className="flex min-w-0 items-center gap-1">
      <input type="text" inputMode="numeric" aria-label={label} value={editing ? draft : value?.replace(/-/g, '/') ?? ''} placeholder="MMDD" disabled={disabled} onFocus={() => { setEditing(true); setDraft(value ?? ''); setError(null); }} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="h-8 min-w-0 flex-1 rounded border border-theme-border bg-page px-2 text-xs text-primary disabled:opacity-50" />
      <label className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded border border-theme-border text-secondary" title={`${label}選擇日期`}><CalendarDays size={15} aria-hidden="true" /><input type="date" aria-label={`${label}選擇日期`} value={value ?? ''} disabled={disabled} onChange={event => { setError(null); onCommit(event.target.value || null); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" /></label>
    </div>
    {error && <span role="alert" className="text-[11px] text-danger">{error}</span>}
  </div>;
}
