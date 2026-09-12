'use client';

import { useEffect, useId, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { parseFlexibleLocalDate } from '@/lib/flexible-local-date';

export function FlexibleDateInput({ value, onChange, label, required = false, disabled = false }: {
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const canonicalValue = value?.slice(0, 10) || '';
  const [text, setText] = useState(canonicalValue);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(canonicalValue);
    setInvalid(false);
  }, [canonicalValue]);

  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed && !required) {
      setInvalid(false);
      onChange(null);
      return;
    }
    const parsed = parseFlexibleLocalDate(trimmed);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(parsed);
    onChange(parsed);
  };

  return (
    <div>
      <div className={`flex min-h-11 items-center rounded border bg-page ${invalid ? 'border-danger' : 'border-theme-border'}`}>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={text}
          required={required}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          placeholder="YYYY-MM-DD、9/8、09.08、0908"
          className="min-w-0 flex-1 bg-transparent px-2 py-2 outline-none disabled:cursor-not-allowed"
          onChange={event => {
            setText(event.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              setText(canonicalValue);
              setInvalid(false);
            }
          }}
        />
        <div className="relative h-10 w-10 shrink-0" title={`${label}日期選擇器`}>
          <CalendarDays size={17} className="pointer-events-none absolute left-3 top-3 text-secondary" />
          <input
            id={`${id}-picker`}
            type="date"
            value={canonicalValue}
            disabled={disabled}
            aria-label={`${label}日期選擇器`}
            className="absolute inset-0 h-10 w-10 cursor-pointer opacity-0 disabled:cursor-not-allowed"
            onChange={event => {
              const next = event.target.value;
              setText(next);
              setInvalid(false);
              onChange(next || null);
            }}
          />
        </div>
      </div>
      {invalid ? <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">日期格式或日期無效；目前儲存值未變更。</p> : null}
    </div>
  );
}
