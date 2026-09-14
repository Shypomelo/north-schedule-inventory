"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, ChevronDown, ChevronRight, PackagePlus, Plus } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { useRowAutosave, type RowAutosaveState } from '@/hooks/useRowAutosave';
import { dbAdapter } from '@/lib/db';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import type { MaterialCatalogItem, MaterialGroup } from '@/lib/db/types';

const inputClass = 'h-9 w-full rounded-lg border border-theme-border bg-page px-2 text-sm text-primary outline-none focus:border-accent disabled:opacity-60';

interface ItemDraft {
  name: string;
  default_specification: string;
  default_unit: string;
  default_reminder_enabled: boolean;
  default_reminder_days_before: number;
}

const blankItemDraft = (): ItemDraft => ({
  name: '', default_specification: '', default_unit: '式',
  default_reminder_enabled: false, default_reminder_days_before: 7,
});

export default function AdminMaterialsPage() {
  const router = useRouter();
  const { currentUser, isLoading: userLoading } = useUser();
  const isAdmin = currentUser?.role === 'ADMIN';
  const [groups, setGroups] = useState<MaterialGroup[]>([]);
  const [items, setItems] = useState<MaterialCatalogItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newGroupName, setNewGroupName] = useState('');
  const [itemDrafts, setItemDrafts] = useState<Record<string, ItemDraft>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const orderedGroups = useMemo(() => [...groups].sort((left, right) => (
    left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'zh-TW')
  )), [groups]);
  const ungroupedItems = useMemo(() => items.filter(item => !item.group_id), [items]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [groupRows, itemRows] = await Promise.all([
        dbAdapter.listMaterialGroups(true), dbAdapter.listMaterialCatalogItems(true),
      ]);
      setGroups(groupRows);
      setItems(itemRows);
      setExpanded(new Set(groupRows.filter(group => group.is_active).map(group => group.id)));
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '無法載入常備物料'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userLoading) return;
    if (!isAdmin) { router.replace('/'); return; }
    void load();
  }, [isAdmin, load, router, userLoading]);

  const onAutosaveError = useCallback((saveError: unknown, validationMessage?: string) => {
    setError(validationMessage || getDatabaseErrorMessage(saveError, '自動儲存失敗'));
  }, []);

  const groupAutosave = useRowAutosave({
    rows: groups,
    setRows: setGroups,
    saveRow: useCallback(async (group: MaterialGroup) => dbAdapter.updateMaterialGroup(group.id, {
      name: group.name, sort_order: group.sort_order, is_active: group.is_active,
    }), []),
    validate: group => group.name.trim() ? null : '群組名稱不可留白。',
    onError: onAutosaveError,
    delay: 700,
  });

  const itemAutosave = useRowAutosave({
    rows: items,
    setRows: setItems,
    saveRow: useCallback(async (item: MaterialCatalogItem) => dbAdapter.updateMaterialCatalogItem(item.id, {
      name: item.name,
      default_specification: item.default_specification,
      default_unit: item.default_unit,
      default_reminder_enabled: item.default_reminder_enabled,
      default_reminder_days_before: item.default_reminder_enabled ? item.default_reminder_days_before : null,
      is_active: item.is_active,
      sort_order: item.sort_order,
    }), []),
    validate: item => !item.name.trim() ? '品項名稱不可留白。' : !item.default_unit.trim() ? '單位不可留白。' : null,
    onError: onAutosaveError,
    delay: 700,
  });

  const createGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentUser || !newGroupName.trim()) return;
    setCreating('group');
    setError(null);
    try {
      const created = await dbAdapter.createMaterialGroup({
        name: newGroupName,
        sort_order: groups.reduce((max, group) => Math.max(max, group.sort_order), 0) + 10,
        is_active: true,
        created_by: currentUser.id,
      });
      setGroups(current => [...current, created]);
      setExpanded(current => new Set(current).add(created.id));
      setNewGroupName('');
      setNotice(`已建立群組「${created.name}」。`);
    } catch (createError) {
      setError(getDatabaseErrorMessage(createError, '新增物料群組失敗'));
    } finally { setCreating(null); }
  };

  const createItem = async (group: MaterialGroup) => {
    const draft = itemDrafts[group.id] ?? blankItemDraft();
    if (!currentUser || !draft.name.trim() || !draft.default_unit.trim()) return;
    setCreating(group.id);
    setError(null);
    try {
      const groupItems = items.filter(item => item.group_id === group.id);
      const created = await dbAdapter.createMaterialCatalogItem({
        group_id: group.id,
        group_name: group.name,
        name: draft.name,
        default_specification: draft.default_specification || null,
        default_unit: draft.default_unit,
        default_reminder_enabled: draft.default_reminder_enabled,
        default_reminder_days_before: draft.default_reminder_enabled ? draft.default_reminder_days_before : null,
        is_active: true,
        sort_order: groupItems.reduce((max, item) => Math.max(max, item.sort_order), 0) + 10,
        created_by: currentUser.id,
      });
      setItems(current => [...current, created]);
      setItemDrafts(current => ({ ...current, [group.id]: blankItemDraft() }));
      setNotice(`已在「${group.name}」新增物料。`);
    } catch (createError) {
      setError(getDatabaseErrorMessage(createError, '新增常備物料失敗'));
    } finally { setCreating(null); }
  };

  const toggleGroup = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (userLoading || !isAdmin) return <div className="p-8 text-center text-secondary">驗證權限中...</div>;

  return <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
    <header className="rounded-xl border border-theme-border bg-card p-4 shadow-sm sm:p-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold text-primary"><PackagePlus className="text-accent" />常備物料管理</h1>
      <p className="mt-1 text-sm text-secondary">先管理群組，再於群組內管理常備品項；所有既有列皆自動儲存。</p>
    </header>
    <form onSubmit={createGroup} className="flex flex-wrap items-end gap-2 rounded-xl border border-theme-border bg-card/40 p-4">
      <label className="min-w-64 flex-1 text-xs text-secondary">新群組名稱<input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} className={`${inputClass} mt-1`} placeholder="例如：AC線材" /></label>
      <button type="submit" disabled={!newGroupName.trim() || creating !== null} className="flex h-9 items-center gap-1 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50"><Plus size={15} />新增群組</button>
    </form>
    {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>}
    {notice && <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">{notice}</div>}
    {loading ? <div className="p-10 text-center text-secondary">載入中...</div> : <div className="space-y-3">
      {orderedGroups.map(group => {
        const groupItems = items.filter(item => item.group_id === group.id).sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'zh-TW'));
        const draft = itemDrafts[group.id] ?? blankItemDraft();
        const isOpen = expanded.has(group.id);
        const updateDraft = (updates: Partial<ItemDraft>) => setItemDrafts(current => ({ ...current, [group.id]: { ...draft, ...updates } }));
        return <section key={group.id} className={`overflow-hidden rounded-xl border border-theme-border bg-card/40 ${group.is_active ? '' : 'opacity-60'}`}>
          <div className="grid gap-2 p-3 sm:grid-cols-[2rem_minmax(12rem,1fr)_7rem_7rem_6rem] sm:items-end" onBlur={() => groupAutosave.flush(group.id)}>
            <button type="button" onClick={() => toggleGroup(group.id)} className="flex h-9 items-center justify-center rounded-md text-secondary hover:bg-page" aria-label={`${isOpen ? '收合' : '展開'}${group.name}`}>{isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
            <label className="text-xs text-secondary">群組名稱<input value={group.name} onChange={event => groupAutosave.updateRow(group.id, { name: event.target.value })} className={`${inputClass} mt-1 font-medium`} /></label>
            <label className="text-xs text-secondary">排序<input type="number" value={group.sort_order} onChange={event => groupAutosave.updateRow(group.id, { sort_order: Number(event.target.value) })} className={`${inputClass} mt-1`} /></label>
            <label className="flex h-9 items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={group.is_active} onChange={event => groupAutosave.updateRow(group.id, { is_active: event.target.checked })} className="h-4 w-4 accent-accent" />啟用</label>
            <AutosaveStatus state={groupAutosave.stateFor(group.id)} />
          </div>
          {isOpen && <div className="border-t border-theme-border">
            <div className="grid gap-2 border-b border-theme-border bg-page/20 p-3 md:grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_6rem_7rem_8rem_auto] md:items-end">
              <label className="text-xs text-secondary">品項名稱<input value={draft.name} onChange={event => updateDraft({ name: event.target.value })} className={`${inputClass} mt-1`} /></label>
              <label className="text-xs text-secondary">型號／規格<input value={draft.default_specification} onChange={event => updateDraft({ default_specification: event.target.value })} className={`${inputClass} mt-1`} /></label>
              <label className="text-xs text-secondary">單位<input value={draft.default_unit} onChange={event => updateDraft({ default_unit: event.target.value })} className={`${inputClass} mt-1`} /></label>
              <label className="flex h-9 items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={draft.default_reminder_enabled} onChange={event => updateDraft({ default_reminder_enabled: event.target.checked })} className="h-4 w-4 accent-accent" />預設提醒</label>
              <label className="text-xs text-secondary">提前天數<input type="number" min={0} max={3650} disabled={!draft.default_reminder_enabled} value={draft.default_reminder_days_before} onChange={event => updateDraft({ default_reminder_days_before: Number(event.target.value) })} className={`${inputClass} mt-1`} /></label>
              <button type="button" disabled={!draft.name.trim() || !draft.default_unit.trim() || creating !== null} onClick={() => void createItem(group)} className="flex h-9 items-center justify-center gap-1 rounded-lg border border-accent/40 px-3 text-xs font-semibold text-accent disabled:opacity-50"><Plus size={14} />新增物料</button>
            </div>
            {groupItems.length === 0 ? <div className="p-6 text-center text-sm text-secondary">此群組尚無常備物料。</div> : <div className="divide-y divide-theme-border/70">{groupItems.map(item => <CatalogItemRow key={item.id} item={item} autosave={itemAutosave} />)}</div>}
          </div>}
        </section>;
      })}
      {ungroupedItems.length > 0 && <section className="overflow-hidden rounded-xl border border-dashed border-theme-border bg-card/30"><div className="p-3 text-sm font-medium text-secondary">未分組的相容資料（{ungroupedItems.length}）</div><div className="divide-y divide-theme-border/70 border-t border-theme-border">{ungroupedItems.map(item => <CatalogItemRow key={item.id} item={item} autosave={itemAutosave} />)}</div></section>}
      {orderedGroups.length === 0 && ungroupedItems.length === 0 && <div className="rounded-xl border border-dashed border-theme-border p-10 text-center text-secondary">尚無物料群組。</div>}
    </div>}
  </div>;
}

function CatalogItemRow({ item, autosave }: { item: MaterialCatalogItem; autosave: ReturnType<typeof useRowAutosave<MaterialCatalogItem>> }) {
  return <div onBlur={() => autosave.flush(item.id)} className={`grid gap-2 p-3 md:grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_6rem_6rem_10rem_6rem_5rem] md:items-end ${item.is_active ? '' : 'opacity-60'}`}>
    <label className="text-xs text-secondary">品項名稱<input value={item.name} onChange={event => autosave.updateRow(item.id, { name: event.target.value })} className={`${inputClass} mt-1`} /></label>
    <label className="text-xs text-secondary">型號／規格<input value={item.default_specification || ''} onChange={event => autosave.updateRow(item.id, { default_specification: event.target.value || null })} className={`${inputClass} mt-1`} /></label>
    <label className="text-xs text-secondary">單位<input value={item.default_unit} onChange={event => autosave.updateRow(item.id, { default_unit: event.target.value })} className={`${inputClass} mt-1`} /></label>
    <label className="text-xs text-secondary">排序<input type="number" value={item.sort_order} onChange={event => autosave.updateRow(item.id, { sort_order: Number(event.target.value) })} className={`${inputClass} mt-1`} /></label>
    <div className="flex h-9 items-center gap-2"><Bell size={14} className="text-secondary" /><input type="checkbox" checked={item.default_reminder_enabled} onChange={event => autosave.updateRow(item.id, { default_reminder_enabled: event.target.checked, default_reminder_days_before: event.target.checked ? item.default_reminder_days_before ?? 7 : null })} className="h-4 w-4 accent-accent" aria-label={`${item.name}預設提醒`} /><input type="number" min={0} max={3650} disabled={!item.default_reminder_enabled} value={item.default_reminder_days_before ?? 7} onChange={event => autosave.updateRow(item.id, { default_reminder_days_before: Number(event.target.value) })} className="h-9 w-16 rounded-lg border border-theme-border bg-page px-2 text-sm text-primary disabled:opacity-50" aria-label={`${item.name}提醒天數`} /><span className="text-xs text-secondary">天</span></div>
    <label className="flex h-9 items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={item.is_active} onChange={event => autosave.updateRow(item.id, { is_active: event.target.checked })} className="h-4 w-4 accent-accent" />啟用</label>
    <AutosaveStatus state={autosave.stateFor(item.id)} />
  </div>;
}

function AutosaveStatus({ state }: { state: RowAutosaveState }) {
  if (state === 'saving') return <span className="text-xs text-secondary">儲存中…</span>;
  if (state === 'saved') return <span className="text-xs text-success">已儲存</span>;
  if (state === 'error') return <span className="text-xs text-danger">儲存失敗</span>;
  return <span className="text-xs text-secondary">自動儲存</span>;
}
