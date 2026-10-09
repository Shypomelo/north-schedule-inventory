'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/components/UserContext';
import { supabase } from '@/lib/db/supabaseClient';
import { creatableToolLinkScopes, sortPersonalToolLinks } from '@/lib/toolbox-links';

type Scope = 'PERSONAL' | 'DEPARTMENT' | 'GLOBAL';
type ToolLink = {
  id: string; name: string; url: string; category: string; description: string | null;
  icon_key: string | null; sort_order: number; scope: Scope;
  owner_member_id: string | null; work_group_id: string | null; created_by_member_id: string | null;
};
type Group = { id: string; name: string };
type Draft = Pick<ToolLink, 'name' | 'url' | 'category' | 'description' | 'icon_key' | 'scope' | 'work_group_id'>;
const emptyDraft: Draft = { name: '', url: '', category: '一般', description: '', icon_key: '', scope: 'PERSONAL', work_group_id: null };
const labels: Record<Scope, string> = { PERSONAL: '個人', DEPARTMENT: '部門', GLOBAL: '全部' };
const inputClass = 'w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-primary';

export default function ToolboxPage() {
  const { currentUser } = useUser();
  const [links, setLinks] = useState<ToolLink[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('ALL');
  const [sort, setSort] = useState<'ORDER' | 'NAME'>('ORDER');
  const [density, setDensity] = useState<'list' | 'cards'>('list');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const isAdmin = currentUser?.role === 'ADMIN';
  const createScopes = creatableToolLinkScopes(currentUser?.role);
  const availableGroups = isAdmin ? groups : groups.filter(group => groupIds.includes(group.id));

  const load = useCallback(async () => {
    if (!currentUser?.id) return;
    setLoading(true); setError('');
    const [linksResult, groupsResult, orderResult, membershipsResult] = await Promise.all([
      supabase.from('tool_links').select('*'),
      supabase.from('work_groups').select('id,name').eq('is_active', true).order('sort_order'),
      supabase.from('tool_link_personal_order').select('tool_link_id,position').eq('member_id', currentUser.id),
      supabase.from('member_work_groups').select('work_group_id').eq('member_id', currentUser.id),
    ]);
    if (linksResult.error) setError(linksResult.error.message);
    else setLinks((linksResult.data || []) as ToolLink[]);
    if (groupsResult.error) setError(groupsResult.error.message);
    else setGroups(groupsResult.data || []);
    if (orderResult.error) setError(orderResult.error.message);
    else setPositions(Object.fromEntries((orderResult.data || []).map(row => [row.tool_link_id, row.position])));
    if (membershipsResult.error) setError(membershipsResult.error.message);
    else setGroupIds((membershipsResult.data || []).map(row => row.work_group_id));
    setLoading(false);
  }, [currentUser?.id]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => sortPersonalToolLinks(links.filter(link => (scope === 'ALL' || link.scope === scope) &&
    (category === 'ALL' || link.category === category) &&
    [link.name, link.category, link.description || ''].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), positions)
    .sort((a, b) => sort === 'NAME' ? a.name.localeCompare(b.name, 'zh-TW') : 0),
  [links, scope, category, query, sort, positions]);
  const categories = Array.from(new Set(links.filter(link => scope === 'ALL' || link.scope === scope).map(link => link.category))).sort();
  const canEdit = (link: ToolLink) => link.created_by_member_id === currentUser?.id
    || (!link.created_by_member_id && link.scope === 'PERSONAL' && link.owner_member_id === currentUser?.id)
    || (isAdmin && link.scope !== 'PERSONAL');
  const openNew = () => { const createScope = scope !== 'ALL' && createScopes.includes(scope) ? scope : 'PERSONAL'; setScope(createScope); setCategory('ALL'); setEditingId(null); setDraft({ ...emptyDraft, scope: createScope, work_group_id: createScope === 'DEPARTMENT' ? availableGroups[0]?.id || null : null }); setError(''); };
  const openEdit = (link: ToolLink) => { setEditingId(link.id); setDraft({ name: link.name, url: link.url, category: link.category, description: link.description, icon_key: link.icon_key, scope: link.scope, work_group_id: link.work_group_id }); setError(''); };
  const save = async () => {
    if (!draft || !currentUser) return;
    let url: URL;
    try { url = new URL(draft.url.trim()); } catch { setError('請輸入有效的 HTTPS 網址。'); return; }
    if (url.protocol !== 'https:' || !url.hostname || !draft.name.trim() || !draft.category.trim()) { setError('名稱、分類及 HTTPS 網址為必填。'); return; }
    if (draft.scope === 'DEPARTMENT' && !draft.work_group_id) { setError('請選擇部門。'); return; }
    const values = { name: draft.name.trim(), url: url.toString(), category: draft.category.trim(),
      description: draft.description?.trim() || null, icon_key: draft.icon_key?.trim() || null,
      scope: draft.scope,
      owner_member_id: draft.scope === 'PERSONAL' ? currentUser.id : null,
      work_group_id: draft.scope === 'DEPARTMENT' ? draft.work_group_id : null };
    const result = editingId ? await supabase.from('tool_links').update(values).eq('id', editingId).select('id').single() : await supabase.from('tool_links').insert(values).select('id').single();
    if (result.error) { setError(result.error.message); return; }
    setDraft(null); await load();
  };
  const remove = async (link: ToolLink) => {
    if (!window.confirm(`刪除「${link.name}」？`)) return;
    const { error: deleteError } = await supabase.from('tool_links').delete().eq('id', link.id).select('id').single();
    if (deleteError) setError(deleteError.message);
    else await load();
  };
  const reorder = async (targetId: string) => {
    if (!draggingId || draggingId === targetId || sort !== 'ORDER') return;
    const ids = sortPersonalToolLinks(links, positions).map(link => link.id);
    const from = ids.indexOf(draggingId), to = ids.indexOf(targetId);
    setDraggingId(null);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const oldPositions = positions;
    setPositions(Object.fromEntries(ids.map((id, index) => [id, index + 1])));
    const expected = Object.fromEntries(links.map(link => [link.id, positions[link.id] ?? null]));
    const { error: orderError } = await supabase.rpc('reorder_my_tool_links_if_current', { p_ids: ids, p_expected: expected });
    if (orderError) { setPositions(oldPositions); setError(orderError.message); }
  };

  if (!currentUser) return null;
  return <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold text-primary">工具箱管理</h1><p className="text-sm text-secondary">常用網站與工作連結的完整管理</p></div>
      <button type="button" onClick={openNew} className="rounded-lg bg-accent px-4 py-2 font-semibold text-white">新增連結</button></div>
    <div role="tablist" aria-label="連結範圍" className="flex gap-2">{(['ALL', ...Object.keys(labels)] as (Scope | 'ALL')[]).map(value =>
      <button type="button" role="tab" aria-selected={scope === value} key={value} onClick={() => { setScope(value); setCategory('ALL'); setDraft(null); }} className={`rounded-lg px-4 py-2 ${scope === value ? 'bg-accent text-white' : 'bg-card text-primary'}`}>{value === 'ALL' ? '混合' : labels[value]}</button>)}</div>
    <div className="grid gap-3 sm:grid-cols-[1fr_12rem_10rem]"><input type="search" aria-label="搜尋連結" placeholder="搜尋名稱、分類、說明" value={query} onChange={e => setQuery(e.target.value)} className={inputClass} />
      <select aria-label="分類" value={category} onChange={e => setCategory(e.target.value)} className={inputClass}><option value="ALL">所有分類</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <select aria-label="排序" value={sort} onChange={e => setSort(e.target.value as 'ORDER' | 'NAME')} className={inputClass}><option value="ORDER">自訂排序</option><option value="NAME">名稱排序</option></select></div>
    <div role="group" aria-label="工具箱顯示方式" className="flex gap-2 text-sm">
      <button type="button" aria-pressed={density === 'list'} onClick={() => setDensity('list')} className="rounded border border-theme-border px-3 py-1.5 aria-pressed:bg-accent aria-pressed:text-white">高密度條列</button>
      <button type="button" aria-pressed={density === 'cards'} onClick={() => setDensity('cards')} className="rounded border border-theme-border px-3 py-1.5 aria-pressed:bg-accent aria-pressed:text-white">高密度卡片</button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-danger">{error}</p>}
    {draft && <section aria-label={editingId ? '修改連結' : '新增連結'} className="grid gap-3 rounded-xl border border-theme-border bg-card p-4 sm:grid-cols-2">
      <label className="text-sm text-secondary">名稱<input className={inputClass} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="text-sm text-secondary">HTTPS 網址<input type="url" className={inputClass} value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>
      <label className="text-sm text-secondary">分類<input className={inputClass} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} /></label>
      <label className="text-sm text-secondary">說明<input className={inputClass} value={draft.description || ''} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      <label className="text-sm text-secondary">圖示 key<input className={inputClass} value={draft.icon_key || ''} onChange={e => setDraft({ ...draft, icon_key: e.target.value })} /></label>
      <label className="text-sm text-secondary">範圍<select className={inputClass} value={draft.scope} onChange={e => { const next = e.target.value as Scope; setDraft({ ...draft, scope: next, work_group_id: next === 'DEPARTMENT' ? availableGroups[0]?.id || null : null }); }}>{createScopes.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
      {draft.scope === 'DEPARTMENT' && <label className="text-sm text-secondary">部門<select className={inputClass} value={draft.work_group_id || ''} onChange={e => setDraft({ ...draft, work_group_id: e.target.value })}><option value="">請選擇部門</option>{availableGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
      <div className="flex items-end gap-2"><button type="button" onClick={() => void save()} className="rounded-lg bg-accent px-4 py-2 text-white">儲存</button><button type="button" onClick={() => setDraft(null)} className="rounded-lg border border-theme-border px-4 py-2 text-primary">取消</button></div>
    </section>}
    {loading ? <p className="text-secondary">載入中…</p> : visible.length === 0 ? <p className="rounded-lg bg-card p-6 text-secondary">沒有符合的連結。</p> :
      <ul className={density === 'cards' ? 'grid gap-2 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-1.5'}>{visible.map(link => <li key={link.id} draggable={sort === 'ORDER'} onDragStart={() => setDraggingId(link.id)} onDragEnd={() => setDraggingId(null)} onDragOver={event => { if (draggingId) event.preventDefault(); }} onDrop={event => { event.preventDefault(); void reorder(link.id); }} onContextMenu={event => { if (!canEdit(link)) return; event.preventDefault(); openEdit(link); }} className={`rounded-lg border border-theme-border bg-card ${density === 'cards' ? 'p-3' : 'px-3 py-2'}`}>
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><a href={link.url} target="_blank" rel="noopener noreferrer" className="break-words font-semibold text-accent hover:underline">{link.name} ↗</a><p className="text-xs text-secondary">{link.category}{link.work_group_id ? ` · ${groups.find(group => group.id === link.work_group_id)?.name || '部門'}` : ''}</p></div>
          {canEdit(link) && <div className="flex shrink-0 gap-2"><button type="button" onClick={() => openEdit(link)} aria-label={`編輯${link.name}`} className="text-sm text-accent">⋯ <span className="hidden sm:inline">修改</span></button><button type="button" onClick={() => void remove(link)} className="text-sm text-danger">刪除</button></div>}</div>
        {link.description && <p className="mt-2 text-sm text-secondary">{link.description}</p>}
      </li>)}</ul>}
  </main>;
}
