'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import {
  combineTaipeiReceiptDateTime,
  parseReceiptDateInput,
  parseReceiptTimeInput,
  receiptDateTimeParts,
} from '@/lib/material-receipt-time';

const displayDate = (value: string) => value ? value.slice(5).replace('-', '/') : '';

export function ReceiptDateTimeInput({ value, onChange, label, disabled = false, required = false, compact = false }: {
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
  disabled?: boolean;
  required?: boolean;
  compact?: boolean;
}) {
  const id = useId();
  const pickerRef = useRef<HTMLInputElement>(null);
  const source = receiptDateTimeParts(value);
  const [dateText, setDateText] = useState(displayDate(source.date));
  const [timeText, setTimeText] = useState(source.time || '09:00');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDateText(displayDate(source.date));
    setTimeText(source.time || '09:00');
    setError(null);
  }, [source.date, source.time]);

  const commit = () => {
    if (!dateText.trim() && !required) {
      setError(null);
      onChange(null);
      return;
    }
    const date = parseReceiptDateInput(dateText);
    const time = parseReceiptTimeInput(timeText);
    if (!date) return setError('日期格式錯誤，請輸入 0127、01/27 或 2027-01-27。');
    if (!time) return setError('時間格式錯誤，請輸入 900、0900 或 09:00。');
    const combined = combineTaipeiReceiptDateTime(date, time);
    if (!combined) return setError('日期或時間無效。');
    setDateText(displayDate(date));
    setTimeText(time);
    setError(null);
    onChange(combined);
  };

  const inputClass = `${compact ? 'h-8 text-xs' : 'h-10 text-sm'} min-w-0 rounded-md border bg-page px-2 text-primary outline-none focus:border-accent disabled:opacity-60`;
  const gridColumns = compact ? 'grid-cols-[4.25rem_3.25rem_1.5rem]' : 'grid-cols-[minmax(5.8rem,1fr)_4.3rem_2rem]';
  return <div>
    <div className={`grid ${gridColumns} gap-1 ${error ? 'text-danger' : ''}`}>
      <input aria-label={`${label}日期`} aria-invalid={Boolean(error)} disabled={disabled} value={dateText} placeholder="MM/DD" className={`${inputClass} ${error ? 'border-danger' : 'border-theme-border'}`} onChange={event => { setDateText(event.target.value); setError(null); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
      <input aria-label={`${label}時間`} aria-invalid={Boolean(error)} disabled={disabled} value={timeText} placeholder="0900" className={`${inputClass} ${error ? 'border-danger' : 'border-theme-border'}`} onChange={event => { setTimeText(event.target.value); setError(null); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
      <button type="button" disabled={disabled} aria-label={`${label}日曆`} className={`${compact ? 'h-8' : 'h-10'} flex items-center justify-center rounded-md border border-theme-border text-secondary disabled:opacity-60`} onClick={() => { try { pickerRef.current?.showPicker(); } catch { pickerRef.current?.click(); } }}><CalendarDays size={15} /></button>
      <input ref={pickerRef} type="date" tabIndex={-1} aria-hidden="true" className="pointer-events-none absolute h-px w-px opacity-0" value={source.date} onChange={event => { const nextDate = event.target.value; setDateText(displayDate(nextDate)); setError(null); const time = parseReceiptTimeInput(timeText); const combined = time ? combineTaipeiReceiptDateTime(nextDate, time) : null; if (combined) onChange(combined); }} />
    </div>
    {error ? <p id={`${id}-error`} role="alert" className="mt-1 text-[11px] text-danger">{error}</p> : null}
  </div>;
}
