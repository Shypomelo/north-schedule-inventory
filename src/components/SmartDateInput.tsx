import React, { useState, useEffect } from 'react';
import { formatDateForDisplay } from '@/lib/utils/date-utils';

interface SmartDateInputProps {
  value: string;
  baseDate: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SmartDateInput({ value, baseDate, onChange, placeholder }: SmartDateInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [localValue, setLocalValue] = useState(value);

  // Sync with external value when not focused
  useEffect(() => {
    if (!isFocused) {
      setLocalValue(value);
    }
  }, [value, isFocused]);

  const displayValue = isFocused ? localValue : formatDateForDisplay(localValue, baseDate);

  const handleBlur = () => {
    setIsFocused(false);
    if (localValue !== value) {
      onChange(localValue);
    }
  };

  return (
    <input
      type="text"
      value={displayValue}
      onFocus={() => setIsFocused(true)}
      onBlur={handleBlur}
      onChange={(e) => setLocalValue(e.target.value)}
      className="w-full bg-slate-900/50 hover:bg-slate-900 focus:bg-slate-900 px-2 py-1.5 rounded border border-slate-700/50 focus:border-emerald-500/50 transition-colors outline-none placeholder:text-slate-600"
      placeholder={placeholder}
    />
  );
}
