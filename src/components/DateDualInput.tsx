import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { parseDateField, formatDateForDisplay } from '@/lib/utils/date-utils';

interface DateDualInputProps {
  expectedDate: string | null;
  completionDate: string | null;
  baseDate: string;
  onChange: (expected: string | null, completion: string | null) => void;
  disabled?: boolean;
}

export function DateDualInput({ expectedDate, completionDate, baseDate, onChange, disabled }: DateDualInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [localExpected, setLocalExpected] = useState(expectedDate || '');
  const [localCompletion, setLocalCompletion] = useState(completionDate || '');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverCoords, setPopoverCoords] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    setLocalExpected(expectedDate || '');
    setLocalCompletion(completionDate || '');
  }, [expectedDate, completionDate, isFocused]);

  const updateCoords = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPopoverCoords({
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width
      });
    }
  };

  useEffect(() => {
    if (isFocused) {
      updateCoords();
      window.addEventListener('resize', updateCoords);
      window.addEventListener('scroll', updateCoords, true);
    } else {
      window.removeEventListener('resize', updateCoords);
      window.removeEventListener('scroll', updateCoords, true);
    }
    return () => {
      window.removeEventListener('resize', updateCoords);
      window.removeEventListener('scroll', updateCoords, true);
    };
  }, [isFocused]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!isFocused) return;
      if (
        containerRef.current && 
        !containerRef.current.contains(e.target as Node) &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        handleSaveAndClose();
      }
    };
    
    if (isFocused) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isFocused, localExpected, localCompletion]); // Need local states to save correctly

  const handleFocus = () => {
    if (disabled) return;
    setIsFocused(true);
  };

  const parseAndFormatExpected = (raw: string) => {
    if (!raw) return '';
    const normalized = raw.replace(/\./g, '/');
    const parsed = parseDateField(normalized, baseDate);
    if (parsed) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return raw;
  };

  const handleSaveAndClose = () => {
    setIsFocused(false);
    const parsedExpected = parseAndFormatExpected(localExpected);
    const parsedCompletion = parseAndFormatExpected(localCompletion);
    onChange(parsedExpected || null, parsedCompletion || null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveAndClose();
      
      // Try to focus the next input downwards (same column)
      if (containerRef.current) {
        const td = containerRef.current.closest('td');
        const tr = td?.closest('tr');
        if (td && tr) {
          const colIndex = Array.from(tr.children).indexOf(td);
          let nextTr = tr.nextElementSibling as HTMLTableRowElement | null;
          if (nextTr) {
            const nextTd = nextTr.children[colIndex];
            if (nextTd) {
              const nextInput = nextTd.querySelector('input[type="text"]') as HTMLInputElement;
              if (nextInput) {
                setTimeout(() => nextInput.focus(), 10);
              }
            }
          }
        }
      }
    } else if (e.key === 'Escape') {
      setIsFocused(false);
      setLocalExpected(expectedDate || '');
      setLocalCompletion(completionDate || '');
    }
  };

  const handlePopoverExpectedBlur = () => {
    setLocalExpected(parseAndFormatExpected(localExpected));
  };

  const handlePopoverCompletionBlur = () => {
    setLocalCompletion(parseAndFormatExpected(localCompletion));
  };

  const getDisplayValue = () => {
    if (isFocused) return localExpected;
    
    if (expectedDate) {
      const parsed = parseDateField(expectedDate.replace(/\./g, '/'), baseDate);
      if (parsed) {
        const today = new Date();
        const todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const parsedTime = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime();
        
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        if (parsedTime >= todayTime) {
          return `預計${m}/${d}`;
        } else {
          return `實際${m}/${d}`;
        }
      }
      return expectedDate;
    }
    return '';
  };

  let textClass = 'text-slate-200';
  if (!isFocused) {
    if (expectedDate) {
      const parsed = parseDateField(expectedDate.replace(/\./g, '/'), baseDate);
      if (parsed) {
        const today = new Date();
        const todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const parsedTime = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime();
        if (parsedTime >= todayTime) {
          textClass = 'text-blue-400 font-medium';
        } else {
          textClass = 'text-emerald-400 font-medium';
        }
      }
    }
  }

  // To let react portal mount safely on client side
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="relative w-full" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        value={getDisplayValue()}
        onFocus={handleFocus}
        onChange={(e) => setLocalExpected(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="未指定"
        className={`date-dual-input w-full bg-slate-900/50 px-2 py-1 rounded border border-slate-700/50 transition-colors outline-none placeholder:text-slate-600 text-sm h-[32px] ${textClass} ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-900 focus:bg-slate-900 focus:border-emerald-500/50'}`}
      />

      {mounted && isFocused && popoverCoords && createPortal(
        <div 
          ref={popoverRef}
          className="fixed mt-1 w-56 bg-slate-800 border border-slate-600 rounded-xl shadow-[0_0_40px_rgba(0,0,0,0.5)] p-4 flex flex-col gap-3 z-[99999]"
          style={{ 
            top: popoverCoords.top - window.scrollY, 
            left: popoverCoords.left - window.scrollX
          }}
        >
          <div>
            <label className="block text-xs text-slate-400 mb-1">進場日期</label>
            <input 
              type="text" 
              value={localExpected} 
              onChange={e => setLocalExpected(e.target.value)}
              onBlur={handlePopoverExpectedBlur}
              onKeyDown={e => { if(e.key==='Enter') handlePopoverExpectedBlur(); }}
              placeholder="例如 0703 或 20260703"
              className="w-full bg-slate-900/80 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-emerald-500/50"
            />
          </div>
          <div>
            <label className="block text-xs text-emerald-400/80 mb-1">實際完工日期</label>
            <input 
              type="text" 
              value={localCompletion} 
              onChange={e => setLocalCompletion(e.target.value)}
              onBlur={handlePopoverCompletionBlur}
              onKeyDown={e => { if(e.key==='Enter') handlePopoverCompletionBlur(); }}
              placeholder="例如 0703 或 20260703"
              className="w-full bg-slate-900/80 border border-emerald-600/30 rounded px-2 py-1.5 text-sm text-emerald-400 outline-none focus:border-emerald-500/50"
            />
          </div>
          <div className="flex justify-end mt-1">
            <button 
              type="button" 
              onMouseDown={(e) => { e.preventDefault(); handleSaveAndClose(); }} 
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs transition-colors w-full font-medium shadow-lg shadow-emerald-900/20"
            >
              完成
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
