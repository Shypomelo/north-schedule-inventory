'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, FileText, Folder, Globe2, Link2, Package, Plus, Wrench, X } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { supabase } from '@/lib/db/supabaseClient';
import { creatableToolLinkScopes, newToolLinkValues, toolLinkScopeLabels, type ToolLink, type ToolLinkScope } from '@/lib/toolbox-links';

type Group = { id: string; name: string };
const iconMap = { calendar: CalendarDays, file: FileText, folder: Folder, globe: Globe2, link: Link2, package: Package, wrench: Wrench };

function LinkIcon({ iconKey }: { iconKey: string }) {
  const Icon = iconMap[iconKey.toLowerCase() as keyof typeof iconMap] || Link2;
  return <Icon size={14} aria-hidden="true" className="shrink-0" />;
}

export function DashboardToolbox() {
  const { currentUser } = useUser();
  const [links, setLinks] = useState<ToolLink[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ToolLinkScope>('PERSONAL');
  const [workGroupId, setWorkGroupId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const allowedScopes = creatableToolLinkScopes(currentUser?.role);

  const loadLinks = useCallback(async () => {
    const result = await supabase.from('tool_links').select('id,name,url,category,icon_key,sort_order,scope,owner_member_id,work_group_id');
    if (result.error) setError(result.error.message);
    else { setLinks((result.data || []) as ToolLink[]); setError(''); }
  }, []);

  useEffect(() => { if (currentUser?.id) void loadLinks(); }, [currentUser?.id, loadLinks]);
  useEffect(() => {
    if (!open) return;
    urlRef.current?.focus();
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) setOpen(false); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [open, saving]);

  const sortedLinks = useMemo(() => [...links].sort((a, b) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-TW')), [links]);

  const openNew = async () => {
    setUrl(''); setName(''); setScope('PERSONAL'); setWorkGroupId(null); setError(''); setOpen(true);
    if (currentUser?.role !== 'ADMIN') return;
    const result = await supabase.from('work_groups').select('id,name').eq('is_active', true).order('sort_order');
    if (result.error) setError(result.error.message);
    else { setGroups(result.data || []); setWorkGroupId(result.data?.[0]?.id || null); }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentUser || saving) return;
    if (!allowedScopes.includes(scope)) { setError('沒有新增此範圍的權限。'); return; }
    let values;
    try { values = newToolLinkValues({ url, name, scope, workGroupId, memberId: currentUser.id, links }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '無法新增連結。'); return; }
    setSaving(true); setError('');
    const result = await supabase.from('tool_links').insert(values);
    setSaving(false);
    if (result.error) { setError(result.error.message); return; }
    setOpen(false);
    await loadLinks();
  };

  if (!currentUser) return null;
  return <>
    <section aria-label="工具箱" className="flex min-w-0 items-center gap-2 border-b border-theme-border bg-card/40 px-4 py-2 md:px-6 xl:px-8">
      <h2 className="shrink-0 text-sm font-bold text-primary">工具箱</h2>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap py-0.5" aria-label="常用工作連結">
        {sortedLinks.length ? sortedLinks.map(link =>
          <a key={link.id} href={link.url} target="_blank" rel="noopener noreferrer" title={`${link.name} · ${toolLinkScopeLabels[link.scope]} · ${link.category}`} className="inline-flex min-h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-lg border border-theme-border bg-page px-2.5 text-xs font-medium text-primary transition hover:border-accent/50 hover:text-accent">
            {link.icon_key ? <LinkIcon iconKey={link.icon_key} /> : null}
            <span className="truncate">{link.name}</span>
            <span className="text-[10px] text-secondary">{toolLinkScopeLabels[link.scope]}</span>
          </a>) : <span className="truncate text-xs text-secondary">常用連結可在這裡快速開啟</span>}
      </div>
      <a href="/toolbox" className="hidden shrink-0 text-xs font-semibold text-secondary hover:text-accent sm:inline">管理</a>
      <button type="button" onClick={() => void openNew()} aria-label="新增工具箱連結" title="新增連結" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white hover:bg-accent/90"><Plus size={17} /></button>
    </section>

    {open && <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="toolbox-add-title" className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-theme-border bg-card p-5 text-primary shadow-2xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between"><h2 id="toolbox-add-title" className="text-lg font-bold">新增連結</h2><button type="button" aria-label="關閉新增連結" onClick={() => setOpen(false)} disabled={saving} className="rounded-lg p-1 text-secondary hover:text-primary"><X size={18} /></button></div>
        <form onSubmit={event => void save(event)} className="space-y-3">
          <label className="block text-sm font-medium">網址<span className="text-danger"> *</span><input ref={urlRef} type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-primary" /></label>
          <label className="block text-sm font-medium">名稱 <span className="font-normal text-secondary">選填</span><input value={name} onChange={event => setName(event.target.value)} placeholder="留空時使用網址名稱" className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-primary" /></label>
          <fieldset><legend className="mb-1 text-sm font-medium">範圍</legend><div className="flex rounded-lg border border-theme-border bg-page p-1" role="group" aria-label="連結範圍">
            {allowedScopes.map(value => <button key={value} type="button" aria-pressed={scope === value} onClick={() => { setScope(value); setError(''); }} className={`min-h-9 flex-1 rounded-md px-3 text-sm font-semibold ${scope === value ? 'bg-accent text-white' : 'text-secondary hover:text-primary'}`}>{toolLinkScopeLabels[value]}</button>)}
          </div></fieldset>
          {scope === 'DEPARTMENT' && <label className="block text-sm font-medium">部門<select required value={workGroupId || ''} onChange={event => setWorkGroupId(event.target.value)} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-primary"><option value="">選擇部門</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1"><button type="button" onClick={() => setOpen(false)} disabled={saving} className="rounded-lg border border-theme-border px-4 py-2 text-sm">取消</button><button type="submit" disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '新增中…' : '新增'}</button></div>
        </form>
      </section>
    </div>}
  </>;
}
