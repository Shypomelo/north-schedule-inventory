'use client';

import { useEffect, useId, useRef, useState } from 'react';
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
  const pickerRef = useRef<HTMLInputElement>(null);
  const sourceValue = value?.slice(0, 10) || '';
  const parsedSource = sourceValue ? parseFlexibleLocalDate(sourceValue) : null;
  const canonicalValue = parsedSource === sourceValue ? sourceValue : '';
  const sourceInvalid = Boolean(sourceValue && !canonicalValue);
  const [text, setText] = useState(sourceValue);
  const [invalid, setInvalid] = useState(sourceInvalid);

  useEffect(() => {
    setText(sourceValue);
    setInvalid(sourceInvalid);
  }, [sourceValue, sourceInvalid]);

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
      <div className={`relative flex min-h-11 items-center rounded border bg-page ${invalid ? 'border-danger' : 'border-theme-border'}`}>
        <input
          id={id}
          type="text"
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
              setText(sourceValue);
              setInvalid(sourceInvalid);
            }
          }}
        />
        <button
          type="button"
          disabled={disabled}
          aria-label={`${label}日期選擇器`}
          className="flex h-10 w-10 shrink-0 items-center justify-center text-secondary disabled:cursor-not-allowed"
          onClick={() => {
            const picker = pickerRef.current;
            if (!picker) return;
            try { picker.showPicker(); } catch { picker.click(); }
          }}
        >
          <CalendarDays size={17} />
        </button>
        <input
          ref={pickerRef}
          id={`${id}-picker`}
          type="date"
          tabIndex={-1}
          value={canonicalValue}
          disabled={disabled}
          aria-hidden="true"
          className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
          onChange={event => {
            const next = event.target.value;
            setText(next);
            setInvalid(false);
            onChange(next || null);
          }}
        />
      </div>
      {invalid ? <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">日期格式或日期無效；目前儲存值未變更。</p> : null}
    </div>
  );
}
