"use client";
import { useState } from 'react';
import type { User, WorkGroup } from '@/lib/db/types';
import type { MemberWorkGroup } from '@/lib/work-groups';
import { dbAdapter } from '@/lib/db';

export function MemberWorkGroupEditor({ member, groups, memberships, isAdmin, onSaved }: {
  member: User; groups: WorkGroup[]; memberships: MemberWorkGroup[]; isAdmin: boolean; onSaved: () => Promise<void>;
}) {
  const [ids, setIds] = useState(memberships.map(row => row.work_group_id));
  const [defaultId, setDefaultId] = useState(memberships.find(row => row.is_default)?.work_group_id || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!isAdmin || saving) return;
    setSaving(true); setError('');
    try { await dbAdapter.setMemberWorkGroups(member.id, ids, defaultId || null); await onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : '儲存失敗'); }
    finally { setSaving(false); }
  };
  return <fieldset disabled={!isAdmin || saving} className="min-w-0 rounded-lg border border-theme-border p-3">
    <legend className="px-1 font-semibold text-primary">{member.name}</legend>
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      {groups.map(group => <div key={group.id} className="flex min-h-11 flex-wrap items-center gap-3 rounded border border-theme-border p-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={ids.includes(group.id)} onChange={e => {
          const next = e.target.checked ? [...ids, group.id] : ids.filter(id => id !== group.id);
          setIds(next); if (!next.includes(defaultId)) setDefaultId(next[0] || '');
        }} />{group.name}</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`default-${member.id}`} disabled={!ids.includes(group.id)} checked={defaultId === group.id} onChange={() => setDefaultId(group.id)} />預設</label>
      </div>)}
      <button type="button" onClick={() => void save()} disabled={saving || (ids.length > 0 && !defaultId)} className="min-h-11 rounded bg-accent px-3 text-[var(--accent-text)] disabled:opacity-50">{saving ? '儲存中…' : '儲存工作群組'}</button>
    </div>
    {!ids.length && <p className="mt-2 text-sm text-secondary">未設定 membership：相容預設為工程，不會自動寫入資料庫。</p>}
    {error && <p role="alert" className="mt-2 break-words text-sm text-danger">{error}</p>}
  </fieldset>;
}
