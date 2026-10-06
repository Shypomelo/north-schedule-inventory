'use client';

import { useId, useState } from 'react';
import type { Project } from '@/lib/db/types';
import { filterProjectsForAutocomplete, getProjectLocationLabel } from '@/lib/project-location';

export function ReceivingProjectCombobox({ projects, value, onChange, disabled, required = false, label = '案件' }: {
  projects: Project[]; value: string; onChange: (id: string) => void; disabled?: boolean; required?: boolean; label?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = projects.find(project => project.id === value);
  // Same first-character filtering, scoring and source as ScheduleTaskForm.
  const candidates = filterProjectsForAutocomplete(projects, query);
  const choose = (project: Project) => { onChange(project.id); setQuery(''); setOpen(false); };
  const close = () => { setOpen(false); setQuery(''); };
  return <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <label htmlFor={id} className="block text-sm">{label}{required ? '' : '（選填）'}</label>
    <div className="flex items-center gap-2">
      <input id={id} role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls={id + '-list'}
        aria-activedescendant={open && candidates[active] ? id + '-' + active : undefined}
        autoComplete="off" aria-required={required} disabled={disabled} value={open ? query : selected?.name || ''}
        placeholder={required ? '輸入案場名稱搜尋' : '輸入案場名稱搜尋；可留空'}
        className="mt-1 min-h-11 min-w-0 flex-1 rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary"
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); if (value) onChange(''); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => Math.max(0, Math.min(candidates.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') { event.preventDefault(); if (open && candidates[active]) choose(candidates[active]); }
        }} />
      {(value || query) && <button type="button" disabled={disabled} className="min-h-11 px-2 text-sm text-secondary" onClick={() => { onChange(''); close(); }}>清除{label}</button>}
    </div>
    {open && query.trim() && <ul id={id + '-list'} role="listbox" className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-theme-border bg-card shadow-xl">
      {candidates.map((project, index) => <li key={project.id} id={id + '-' + index} role="option" aria-selected={value === project.id} className={index === active ? 'bg-accent/10' : ''}>
        <button type="button" className="min-h-11 w-full px-3 py-2 text-left text-sm" onMouseDown={event => event.preventDefault()} onClick={() => choose(project)}>
          {project.name}{getProjectLocationLabel(project) && <span className="ml-2 text-xs text-secondary">{getProjectLocationLabel(project)}</span>}
        </button>
      </li>)}
      {!candidates.length && <li className="p-3 text-sm text-secondary">{required ? '找不到符合的案件' : '找不到符合的案件；可留空'}</li>}
    </ul>}
  </div>;
}
