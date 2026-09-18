"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, PackageCheck, Plus, Search, Trash2, X } from 'lucide-react';
import { useUser } from './UserContext';
import { ReceiptDateTimeInput } from './ReceiptDateTimeInput';
import { MaterialReceiptHistoryDialog } from './MaterialReceiptHistoryDialog';
import { dbAdapter } from '@/lib/db';
import type {
  DeliveryDestination,
  MaterialCatalogItem,
  MaterialGroup,
  MaterialReceipt,
  Project,
  ProjectMaterial,
  ProjectMaterialBatch,
  SESupplyRecord,
} from '@/lib/db/types';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import {
  filterPendingReceivingItems,
  formatTaipeiReceivingDate,
  formatReceivingQuantity,
  formatTaipeiReceivingTime,
  getReceivingGroupStatusLabel,
  groupPendingReceivingItems,
  selectReceivingItems,
  type PendingReceivingItem,
  type PendingReceivingGroup,
} from '@/lib/material-receiving';
import {
  buildProcurementCreatedProjectMaterial,
  DELIVERY_DESTINATION_OPTIONS,
  filterMaterialCatalogByGroupId,
  filterSelectableMaterialCatalogItems,
  fromDatetimeLocalValue,
  getActiveMaterialGroups,
  toDatetimeLocalValue,
} from '@/lib/project-materials';
import { selectActiveProjects } from '@/lib/project-selectors';
import { filterProjectsForAutocomplete, getProjectLocationLabel } from '@/lib/project-location';

type ReceivingTab = 'pending' | 'received';
type CreateArrivalMode = 'choose' | 'project' | 'se' | null;

const inputClass = 'h-10 w-full rounded-lg border border-theme-border bg-page px-3 text-sm text-primary outline-none focus:border-accent disabled:opacity-60';

export function MaterialReceivingCenter() {
  const { currentUser, allUsers } = useUser();
  const [tab, setTab] = useState<ReceivingTab>('pending');
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [batches, setBatches] = useState<ProjectMaterialBatch[]>([]);
  const [projectMaterials, setProjectMaterials] = useState<ProjectMaterial[]>([]);
  const [seRecords, setSeRecords] = useState<SESupplyRecord[]>([]);
  const [receipts, setReceipts] = useState<MaterialReceipt[]>([]);
  const [catalog, setCatalog] = useState<MaterialCatalogItem[]>([]);
  const [materialGroups, setMaterialGroups] = useState<MaterialGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<CreateArrivalMode>(null);
  const [detailGroupKey, setDetailGroupKey] = useState<string | null>(null);
  const [receivingItem, setReceivingItem] = useState<PendingReceivingItem | null>(null);
  const [historyItem, setHistoryItem] = useState<PendingReceivingItem | null>(null);
  const [archivingGroupKey, setArchivingGroupKey] = useState<string | null>(null);
  const canEdit = Boolean(currentUser && currentUser.role !== 'VIEWER');

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const [projectRows, batchRows, materialRows, seRows, receiptRows, catalogRows, materialGroupRows] = await Promise.all([
        dbAdapter.getProjects(),
        dbAdapter.listMaterialReceivingBatches(),
        dbAdapter.listOfficeProjectMaterials(),
        dbAdapter.getSESupplyRecords(),
        dbAdapter.listMaterialReceipts(),
        dbAdapter.listMaterialCatalogItems(),
        dbAdapter.listMaterialGroups(false),
      ]);
      setProjects(selectActiveProjects(projectRows));
      setBatches(batchRows);
      setProjectMaterials(materialRows);
      setSeRecords(seRows);
      setReceipts(receiptRows);
      setCatalog(catalogRows);
      setMaterialGroups(materialGroupRows);
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '物料到貨資料載入失敗。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const receivingItems = useMemo(() => selectReceivingItems({
    projects,
    batches,
    projectMaterials,
    seRecords,
    receipts,
    users: allUsers,
  }), [allUsers, batches, projectMaterials, projects, receipts, seRecords]);
  const allGroups = useMemo(() => groupPendingReceivingItems(receivingItems), [receivingItems]);
  const filteredGroups = useMemo(() => groupPendingReceivingItems(filterPendingReceivingItems(receivingItems, search)), [receivingItems, search]);
  const pendingGroups = useMemo(() => filteredGroups.filter(group => group.status !== 'RECEIVED'), [filteredGroups]);
  const receivedGroups = useMemo(() => filteredGroups.filter(group => group.status === 'RECEIVED'), [filteredGroups]);
  const detailGroup = detailGroupKey ? allGroups.find(group => group.key === detailGroupKey) || null : null;

  const archiveReceivingGroup = async (group: PendingReceivingGroup) => {
    if (!canEdit || archivingGroupKey) return;
    if (!window.confirm(`確定從物料到貨中心刪除「${group.contextLabel}｜${formatTaipeiReceivingDate(group.expectedDeliveryAt)}」共 ${group.items.length} 項？原始物料與收料歷程會完整保留。`)) return;
    setArchivingGroupKey(group.key);
    setError(null);
    try {
      const archivedAt = new Date().toISOString();
      await Promise.all(group.items.map(item => item.sourceType === 'PROJECT_MATERIAL'
        ? dbAdapter.updateProjectMaterial(item.sourceId, { receiving_archived_at: archivedAt })
        : dbAdapter.updateSESupplyRecord(item.sourceId, { receiving_archived_at: archivedAt })));
      if (detailGroupKey === group.key) setDetailGroupKey(null);
      await loadData();
    } catch (archiveError) {
      setError(getDatabaseErrorMessage(archiveError, '從物料到貨中心刪除群組失敗。'));
    } finally {
      setArchivingGroupKey(null);
    }
  };

  if (loading) {
    return <div className="flex min-h-56 items-center justify-center gap-2 text-secondary"><Loader2 className="animate-spin" size={18} />載入物料到貨...</div>;
  }

  return <section className="min-h-0 rounded-xl border border-theme-border bg-card/50 min-[1100px]:h-[calc(100%-8.5rem)] min-[1100px]:overflow-y-auto">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-theme-border p-3">
      <div className="flex rounded-lg border border-theme-border bg-page p-1" role="tablist" aria-label="物料到貨狀態">
        <button type="button" role="tab" aria-selected={tab === 'pending'} onClick={() => setTab('pending')} className={`min-h-9 rounded-md px-4 text-sm font-bold ${tab === 'pending' ? 'bg-accent text-white' : 'text-secondary'}`}>待收 {pendingGroups.length}</button>
        <button type="button" role="tab" aria-selected={tab === 'received'} onClick={() => setTab('received')} className={`min-h-9 rounded-md px-4 text-sm font-bold ${tab === 'received' ? 'bg-accent text-white' : 'text-secondary'}`}>已收到 {receivedGroups.length}</button>
      </div>
      <button type="button" disabled={!canEdit} onClick={() => setCreateMode('choose')} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:opacity-50"><Plus size={16} />新增到貨</button>
    </div>

    <div className="flex items-center gap-2 border-b border-theme-border px-3 py-2">
      <Search size={16} className="text-secondary" />
      <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜尋案場、申請人、品項或型號" className="h-9 min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-secondary/60" />
    </div>

    {error ? <div className="m-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}

    <ReceivingGroupList groups={tab === 'pending' ? pendingGroups : receivedGroups} tab={tab} canEdit={canEdit} archivingGroupKey={archivingGroupKey} onOpen={group => setDetailGroupKey(group.key)} onArchive={group => void archiveReceivingGroup(group)} />

    {createMode === 'choose' ? <ArrivalTypeDialog onClose={() => setCreateMode(null)} onChoose={setCreateMode} /> : null}
    {createMode === 'project' ? <ProjectMaterialArrivalDialog projects={projects} batches={batches} catalog={catalog} groups={materialGroups} currentUserId={currentUser?.id || null} onClose={() => setCreateMode(null)} onCreated={async () => { setCreateMode(null); setTab('pending'); await loadData(); }} /> : null}
    {createMode === 'se' ? <SEArrivalDialog projects={projects} users={allUsers} currentUserId={currentUser?.id || null} onClose={() => setCreateMode(null)} onCreated={async () => { setCreateMode(null); await loadData(); }} /> : null}
    {detailGroup ? <ReceivingGroupDetailDialog group={detailGroup} receipts={receipts} canEdit={canEdit} onClose={() => setDetailGroupKey(null)} onReceive={setReceivingItem} onHistory={setHistoryItem} onExpectedChanged={loadData} /> : null}
    {receivingItem ? <ConfirmReceiptDialog item={receivingItem} onClose={() => setReceivingItem(null)} onConfirmed={async () => { setReceivingItem(null); await loadData(); }} /> : null}
    {historyItem ? <MaterialReceiptHistoryDialog receipts={receipts} sourceType={historyItem.sourceType} sourceId={historyItem.sourceId} itemLabel={historyItem.itemLabel} contextLabel={historyItem.contextLabel} unit={historyItem.unit} canEdit={canEdit} onClose={() => setHistoryItem(null)} onChanged={loadData} /> : null}
  </section>;
}

function ArrivalTypeDialog({ onClose, onChoose }: {
  onClose: () => void;
  onChoose: (mode: 'project' | 'se') => void;
}) {
  return <DialogFrame title="新增到貨" onClose={onClose}>
    <p className="mb-3 text-sm text-secondary">選擇這筆到貨的來源。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <button type="button" autoFocus onClick={() => onChoose('project')} className="min-h-24 rounded-xl border border-theme-border bg-page/50 px-4 text-left hover:border-accent">
        <span className="block font-bold text-primary">案場物料</span>
        <span className="mt-1 block text-xs text-secondary">採購已代叫，直接建立到案件物料清單</span>
      </button>
      <button type="button" onClick={() => onChoose('se')} className="min-h-24 rounded-xl border border-theme-border bg-page/50 px-4 text-left hover:border-accent">
        <span className="block font-bold text-primary">SE</span>
        <span className="mt-1 block text-xs text-secondary">沿用既有 SE 到貨新增流程</span>
      </button>
    </div>
  </DialogFrame>;
}

const NEW_BATCH_VALUE = '__NEW_BATCH__';
const CUSTOM_CATALOG_VALUE = '__CUSTOM__';

interface ArrivalSlot {
  id: string;
  groupId: string;
  catalogId: string;
  itemName: string;
  specification: string;
  quantity: string;
  unit: string;
}

const createArrivalSlots = (start: number, count = 5): ArrivalSlot[] => Array.from({ length: count }, (_, index) => ({
  id: `arrival-slot-${start + index}`,
  groupId: '',
  catalogId: CUSTOM_CATALOG_VALUE,
  itemName: '',
  specification: '',
  quantity: '1',
  unit: '式',
}));

function ProjectMaterialArrivalDialog({ projects, batches, catalog, groups, currentUserId, onClose, onCreated }: {
  projects: Project[];
  batches: ProjectMaterialBatch[];
  catalog: MaterialCatalogItem[];
  groups: MaterialGroup[];
  currentUserId: string | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [projectId, setProjectId] = useState('');
  const [batchId, setBatchId] = useState(NEW_BATCH_VALUE);
  const [newBatchName, setNewBatchName] = useState('採購代叫');
  const [slots, setSlots] = useState<ArrivalSlot[]>(() => createArrivalSlots(0));
  const [expectedAt, setExpectedAt] = useState(new Date().toISOString());
  const [destination, setDestination] = useState<DeliveryDestination>('OFFICE');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectBatches = batches.filter(batch => batch.project_id === projectId && !batch.received_at);
  const activeGroups = useMemo(() => getActiveMaterialGroups(groups), [groups]);
  const selectableCatalog = useMemo(
    () => filterSelectableMaterialCatalogItems(catalog, activeGroups),
    [activeGroups, catalog],
  );

  const selectProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    const suitableBatch = batches.find(batch => batch.project_id === nextProjectId && !batch.received_at);
    setBatchId(suitableBatch?.id || NEW_BATCH_VALUE);
    if (suitableBatch?.planned_receipt_at) setExpectedAt(suitableBatch.planned_receipt_at);
  };

  const selectBatch = (nextBatchId: string) => {
    setBatchId(nextBatchId);
    const selected = batches.find(batch => batch.id === nextBatchId);
    if (selected?.planned_receipt_at) setExpectedAt(selected.planned_receipt_at);
  };

  const updateSlot = (id: string, updates: Partial<ArrivalSlot>) => {
    setSlots(current => current.map(slot => slot.id === id ? { ...slot, ...updates } : slot));
  };

  const selectSlotCatalog = (slot: ArrivalSlot, nextCatalogId: string) => {
    const selected = selectableCatalog.find(item => item.id === nextCatalogId);
    if (!selected) {
      updateSlot(slot.id, { catalogId: CUSTOM_CATALOG_VALUE, itemName: '', specification: '' });
      return;
    }
    updateSlot(slot.id, {
      groupId: selected.group_id || slot.groupId,
      catalogId: selected.id,
      itemName: selected.name,
      specification: selected.default_specification || '',
      unit: selected.default_unit,
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const timestamp = expectedAt;
    const filledSlots = slots.filter(slot => slot.itemName.trim());
    const invalidSlot = filledSlots.find(slot => !slot.unit.trim() || !Number.isFinite(Number(slot.quantity)) || Number(slot.quantity) <= 0);
    if (!currentUserId || !projectId || !timestamp || filledSlots.length === 0) {
      setError('請選擇案件，並至少填寫一筆物料。');
      return;
    }
    if (invalidSlot) {
      setError('每筆已填物料都需要有效的數量與單位。');
      return;
    }
    if (batchId === NEW_BATCH_VALUE && !newBatchName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let targetBatchId = batchId;
      if (batchId === NEW_BATCH_VALUE) {
        const batch = await dbAdapter.createProjectMaterialBatch({
          project_id: projectId,
          batch_name: newBatchName.trim(),
          ordered_at: new Date().toISOString(),
          planned_receipt_at: timestamp,
          same_day_delivery: true,
          received_at: null,
          notes: '由物料到貨新增的採購代叫批次',
          created_by: currentUserId,
        });
        targetBatchId = batch.id;
      } else {
        const targetBatch = batches.find(batch => batch.id === batchId);
        if (!targetBatch) throw new Error('找不到選取的叫料批次');
        if (targetBatch.same_day_delivery) await dbAdapter.updateMaterialReceiptPlan(targetBatch.id, timestamp);
      }
      const targetBatch = batches.find(batch => batch.id === targetBatchId);
      const materialOverride = batchId === NEW_BATCH_VALUE || targetBatch?.same_day_delivery
        ? null
        : targetBatch?.planned_receipt_at === timestamp ? null : timestamp;
      await Promise.all(filledSlots.map(slot => {
        const selectedCatalogItem = catalog.find(item => item.id === slot.catalogId) || null;
        return dbAdapter.createProjectMaterial(buildProcurementCreatedProjectMaterial(
          projectId,
          targetBatchId,
          currentUserId,
          {
            item_name: slot.itemName.trim(),
            specification: slot.specification.trim() || null,
            quantity: Number(slot.quantity),
            unit: slot.unit.trim(),
            expected_delivery_at: materialOverride,
            delivery_destination: destination,
            notes: notes.trim() || null,
          },
          selectedCatalogItem,
        ));
      }));
      await onCreated();
    } catch (createError) {
      setError(getDatabaseErrorMessage(createError, '新增案場到貨失敗。'));
    } finally {
      setSaving(false);
    }
  };

  return <DialogFrame title="新增案場物料到貨" onClose={onClose} wide>
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-3 rounded-lg border border-theme-border bg-page/30 p-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ProjectBindingAutocomplete projects={projects} projectId={projectId} onSelect={selectProject} /></div>
        <label className="text-xs text-secondary">叫料批次<select required disabled={!projectId} value={batchId} onChange={event => selectBatch(event.target.value)} className={`${inputClass} mt-1`}><option value={NEW_BATCH_VALUE}>＋ 建立新批次</option>{projectBatches.map(batch => <option key={batch.id} value={batch.id}>{batch.batch_name}</option>)}</select></label>
        {batchId === NEW_BATCH_VALUE ? <label className="text-xs text-secondary">新批次名稱<input required value={newBatchName} onChange={event => setNewBatchName(event.target.value)} className={`${inputClass} mt-1`} /></label> : <div />}
        <label className="text-xs text-secondary">預設到貨日期時間<div className="mt-1"><ReceiptDateTimeInput required label="採購代叫預設到貨" value={expectedAt} onChange={value => value && setExpectedAt(value)} /></div></label>
        <label className="text-xs text-secondary">送達位置<select required value={destination} onChange={event => setDestination(event.target.value as DeliveryDestination)} className={`${inputClass} mt-1`}>{DELIVERY_DESTINATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="text-xs text-secondary sm:col-span-2">備註（選填）<input value={notes} onChange={event => setNotes(event.target.value)} className={`${inputClass} mt-1`} /></label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-theme-border">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[2rem_9rem_minmax(20rem,1fr)_10rem] gap-2 border-b border-theme-border bg-page/45 px-3 py-2 text-xs font-bold text-secondary"><span>#</span><span>群組</span><span>型號／規格</span><span>數量／單位</span></div>
          <div className="divide-y divide-theme-border/70">{slots.map((slot, index) => {
            const filteredCatalog = slot.groupId
              ? filterMaterialCatalogByGroupId(selectableCatalog, slot.groupId)
              : selectableCatalog;
            return <div key={slot.id} className="grid grid-cols-[2rem_9rem_minmax(20rem,1fr)_10rem] items-start gap-2 px-3 py-2">
              <span className="pt-2 text-xs text-secondary">{index + 1}</span>
              <select value={slot.groupId} onChange={event => updateSlot(slot.id, { groupId: event.target.value, catalogId: CUSTOM_CATALOG_VALUE, itemName: '', specification: '' })} className={inputClass} aria-label={`第 ${index + 1} 格群組`}><option value="">全部／自訂</option>{activeGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
              <div className="grid grid-cols-[11rem_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-2">
                <select value={slot.catalogId} onChange={event => selectSlotCatalog(slot, event.target.value)} className={inputClass} aria-label={`第 ${index + 1} 格常備物料`}><option value={CUSTOM_CATALOG_VALUE}>特殊料自由輸入</option>{filteredCatalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                <input value={slot.itemName} onChange={event => updateSlot(slot.id, { itemName: event.target.value, catalogId: CUSTOM_CATALOG_VALUE })} placeholder="品項／型號" className={inputClass} aria-label={`第 ${index + 1} 格品項`} />
                <input value={slot.specification} onChange={event => updateSlot(slot.id, { specification: event.target.value })} placeholder="規格（選填）" className={inputClass} aria-label={`第 ${index + 1} 格規格`} />
              </div>
              <div className="grid grid-cols-[1fr_4rem] gap-1"><input type="number" min="0.001" step="any" value={slot.quantity} onChange={event => updateSlot(slot.id, { quantity: event.target.value })} className={inputClass} aria-label={`第 ${index + 1} 格數量`} /><input value={slot.unit} onChange={event => updateSlot(slot.id, { unit: event.target.value })} className={`${inputClass} px-2`} aria-label={`第 ${index + 1} 格單位`} /></div>
            </div>;
          })}</div>
        </div>
      </div>
      <button type="button" onClick={() => setSlots(current => [...current, ...createArrivalSlots(current.length)])} className="w-fit h-9 rounded-lg border border-theme-border px-3 text-xs font-bold text-primary hover:bg-page"><Plus size={14} className="mr-1 inline" />再加 5 格</button>
      <p className="text-xs text-secondary">空白格不會建立資料；所有新增列都標記為採購已代叫，不列入請購內容。</p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={onClose} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-secondary">取消</button><button type="submit" disabled={saving || !currentUserId} className="h-10 rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:opacity-50">{saving ? '新增中...' : '一次新增物料'}</button></div>
    </form>
  </DialogFrame>;
}

function ProjectBindingAutocomplete({ projects, projectId, onSelect }: {
  projects: Project[];
  projectId: string;
  onSelect: (projectId: string) => void;
}) {
  const selectedProject = projects.find(project => project.id === projectId) || null;
  const [query, setQuery] = useState(selectedProject?.name || '');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const filteredProjects = useMemo(
    () => filterProjectsForAutocomplete(projects, query),
    [projects, query],
  );

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  const changeQuery = (value: string) => {
    setQuery(value);
    if (projectId) onSelect('');
    setOpen(Boolean(value.trim()));
  };

  const chooseProject = (project: Project) => {
    setQuery(project.name);
    onSelect(project.id);
    setOpen(false);
  };

  return <div ref={rootRef} className="relative">
    <label className="text-xs text-secondary">案件
      <input autoFocus required value={query} onChange={event => changeQuery(event.target.value)} onFocus={() => setOpen(Boolean(query.trim()))} onClick={() => setOpen(Boolean(query.trim()))} placeholder="輸入一個字開始搜尋案件" autoComplete="off" role="combobox" aria-autocomplete="list" aria-controls="receiving-project-search-results" aria-label="案件快選" aria-expanded={open} className={`${inputClass} mt-1`} />
    </label>
    {open ? <div id="receiving-project-search-results" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-theme-border bg-card p-1 shadow-xl" role="listbox" aria-label="案件搜尋結果">
      {filteredProjects.length > 0 ? filteredProjects.map(project => {
        const location = getProjectLocationLabel(project);
        return <button type="button" key={project.id} onClick={() => chooseProject(project)} className="block w-full rounded-md px-3 py-2 text-left hover:bg-page" role="option" aria-selected={project.id === projectId}>
          <span className="block text-sm font-semibold text-primary">{project.name}</span>
          {(project.short_name || project.project_code || location) ? <span className="mt-0.5 block text-xs text-secondary">{[project.short_name, project.project_code, location].filter(Boolean).join(' · ')}</span> : null}
        </button>;
      }) : <div className="px-3 py-3 text-sm text-secondary">找不到既有案件</div>}
    </div> : null}
    {query && !projectId ? <p className="mt-1 text-xs text-warning">請從搜尋結果選擇正式案件</p> : null}
  </div>;
}

function ReceivingGroupList({ groups, tab, canEdit, archivingGroupKey, onOpen, onArchive }: {
  groups: PendingReceivingGroup[];
  tab: ReceivingTab;
  canEdit: boolean;
  archivingGroupKey: string | null;
  onOpen: (group: PendingReceivingGroup) => void;
  onArchive: (group: PendingReceivingGroup) => void;
}) {
  if (groups.length === 0) return <div className="p-10 text-center text-sm text-secondary">{tab === 'pending' ? '目前沒有符合條件的待收群組。' : '目前沒有已完成的收料群組。'}</div>;
  return <div>
    <div className="hidden grid-cols-[6rem_5.5rem_minmax(13rem,1.35fr)_minmax(14rem,1fr)_5rem_8rem] gap-2 border-b border-theme-border bg-page/35 px-3 py-2 text-xs font-bold text-secondary md:grid">
      <span>{tab === 'pending' ? '日期' : '完成時間'}</span><span>來源</span><span>案場 / 申請人</span><span>內容摘要</span><span>{tab === 'pending' ? '狀態' : '收料人'}</span><span>操作</span>
    </div>
    <div className="divide-y divide-theme-border/70">{groups.map(group => {
      const displayTime = tab === 'received' ? group.completedAt : group.expectedDeliveryAt;
      const isArchiving = archivingGroupKey === group.key;
      return <div key={group.key} className="grid w-full gap-2 px-3 py-3 text-left text-sm hover:bg-page/40 md:grid-cols-[6rem_5.5rem_minmax(13rem,1.35fr)_minmax(14rem,1fr)_5rem_8rem] md:items-center md:py-2">
        <span className="font-semibold md:font-normal">{tab === 'received' ? formatTaipeiReceivingTime(displayTime).replace(/^\d{4}\//, '') : formatTaipeiReceivingDate(displayTime)}</span>
        <span><span className="inline-flex rounded-full border border-theme-border bg-page px-2 py-0.5 text-xs font-bold text-primary">{group.sourceLabel}</span></span>
        <span className="min-w-0 break-words font-medium"><span className="mr-1 text-xs font-normal text-secondary md:hidden">案場／申請人</span>{group.contextLabel}</span>
        <span className="min-w-0"><span className="block font-semibold">{group.items.length} 項</span><span className="block truncate text-xs text-secondary" title={group.items.map(item => item.itemLabel).join('、')}>{group.items.slice(0, 3).map(item => item.itemLabel).join('、')}{group.items.length > 3 ? '…' : ''}</span></span>
        <span className={group.status === 'PARTIAL_RECEIVED' ? 'font-bold text-warning' : group.status === 'RECEIVED' ? 'text-success' : 'text-secondary'}>{tab === 'received' ? group.receivedByLabels.join('、') || '—' : getReceivingGroupStatusLabel(group.status)}</span>
        <span className="flex items-center gap-1">
          <button type="button" onClick={() => onOpen(group)} className="h-8 rounded-md px-2 text-xs font-bold text-accent hover:bg-page">查看</button>
          {canEdit ? <button type="button" disabled={Boolean(archivingGroupKey)} onClick={() => onArchive(group)} className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-bold text-danger hover:bg-danger/10 disabled:opacity-40" aria-label={`從物料到貨中心刪除 ${group.contextLabel} 群組`}><Trash2 size={13}/>{isArchiving ? '刪除中' : '刪除'}</button> : null}
        </span>
      </div>;
    })}</div>
  </div>;
}

function ReceivingGroupDetailDialog({ group, receipts, canEdit, onClose, onReceive, onHistory, onExpectedChanged }: {
  group: PendingReceivingGroup;
  receipts: MaterialReceipt[];
  canEdit: boolean;
  onClose: () => void;
  onReceive: (item: PendingReceivingItem) => void;
  onHistory: (item: PendingReceivingItem) => void;
  onExpectedChanged: () => void | Promise<void>;
}) {
  const [editingItem, setEditingItem] = useState<PendingReceivingItem | null>(null);
  const [expectedAt, setExpectedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startExpectedEdit = (item: PendingReceivingItem) => {
    setEditingItem(item);
    setExpectedAt(item.expectedDeliveryAt);
    setError(null);
  };

  const saveExpected = async () => {
    if (!editingItem || !expectedAt) return;
    setSaving(true);
    setError(null);
    try {
      if (editingItem.sourceType === 'PROJECT_MATERIAL') {
        if (editingItem.batchSameDayDelivery && editingItem.batchId) {
          await dbAdapter.updateMaterialReceiptPlan(editingItem.batchId, expectedAt);
        } else {
          await dbAdapter.updateMaterialReceiptOverride(editingItem.sourceId, expectedAt);
        }
      } else {
        await dbAdapter.updateSESupplyRecord(editingItem.sourceId, { expected_delivery_at: expectedAt });
      }
      setEditingItem(null);
      await onExpectedChanged();
      onClose();
    } catch (updateError) {
      setError(getDatabaseErrorMessage(updateError, '修改預計到貨時間失敗。'));
    } finally {
      setSaving(false);
    }
  };

  return <DialogFrame title="收料詳情" onClose={onClose} wide>
    <div className="mb-4 grid gap-2 rounded-lg border border-theme-border bg-page/35 p-3 text-sm sm:grid-cols-[1fr_auto_auto] sm:items-center">
      <div><span className="text-xs text-secondary">案場／申請人</span><p className="font-bold text-primary">{group.contextLabel}</p></div>
      <div><span className="text-xs text-secondary">日期</span><p className="font-semibold">{formatTaipeiReceivingDate(group.expectedDeliveryAt)}</p></div>
      <span className={`w-fit rounded-full border px-2 py-1 text-xs font-bold ${group.status === 'PARTIAL_RECEIVED' ? 'border-warning/40 bg-warning/10 text-warning' : group.status === 'RECEIVED' ? 'border-success/40 bg-success/10 text-success' : 'border-theme-border bg-card text-secondary'}`}>{getReceivingGroupStatusLabel(group.status)}</span>
    </div>
    <div className="overflow-x-auto rounded-lg border border-theme-border"><div className="min-w-[820px]">
      <div className="grid grid-cols-[minmax(13rem,1fr)_6rem_6rem_6rem_10.5rem_5rem_11rem] gap-2 border-b border-theme-border bg-page/45 px-3 py-2 text-xs font-bold text-secondary"><span>品項／規格</span><span>需求數量</span><span>已收數量</span><span>待收數量</span><span>預計時間</span><span>狀態</span><span>操作</span></div>
      <div className="divide-y divide-theme-border/70">{group.items.map(item => {
        const hasHistory = receipts.some(receipt => receipt.source_type === item.sourceType && (item.sourceType === 'PROJECT_MATERIAL' ? receipt.project_material_id === item.sourceId : receipt.se_supply_record_id === item.sourceId));
        return <div key={`${item.sourceType}:${item.sourceId}`} className="group grid grid-cols-[minmax(13rem,1fr)_6rem_6rem_6rem_10.5rem_5rem_11rem] items-center gap-2 px-3 py-2 text-sm">
          <span className="min-w-0 break-words font-semibold">{item.itemLabel}</span>
          <span>{formatReceivingQuantity(item.quantity)} {item.unit}</span>
          <span>{formatReceivingQuantity(item.receivedQuantity)} {item.unit}</span>
          <span className={item.remainingQuantity > 0 ? 'font-bold text-warning' : 'text-secondary'}>{formatReceivingQuantity(item.remainingQuantity)} {item.unit}</span>
          <span className="text-xs"><span className="block">{formatTaipeiReceivingTime(item.expectedDeliveryAt)}</span>{canEdit && item.status !== 'RECEIVED' ? <button type="button" onClick={() => startExpectedEdit(item)} className="mt-0.5 font-bold text-accent">修改預計</button> : null}</span>
          <span className={item.status === 'PARTIAL_RECEIVED' ? 'font-bold text-warning' : item.status === 'RECEIVED' ? 'text-success' : 'text-secondary'}>{item.status === 'RECEIVED' ? '已收到' : item.status === 'PARTIAL_RECEIVED' ? '未全' : '待收'}</span>
          <span className="flex items-center gap-1">{item.status !== 'RECEIVED' ? <button type="button" disabled={!canEdit} onClick={() => onReceive(item)} className="h-8 flex-1 rounded-md border border-accent/40 px-2 text-xs font-bold text-accent disabled:opacity-50">確認收到</button> : null}<button type="button" disabled={!hasHistory} onClick={() => onHistory(item)} className="h-8 rounded-md px-2 text-xs font-bold text-secondary hover:bg-page disabled:opacity-35">歷程</button></span>
        </div>;
      })}</div>
    </div></div>
    {editingItem ? <div className="mt-4 rounded-lg border border-accent/30 bg-page/40 p-3"><p className="mb-2 text-sm font-bold">修改預計到貨｜{editingItem.itemLabel}</p><div className="flex flex-col gap-2 sm:flex-row sm:items-end"><div className="flex-1"><ReceiptDateTimeInput required label={`${editingItem.itemLabel}預計到貨`} value={expectedAt} onChange={setExpectedAt} /></div><button type="button" onClick={() => setEditingItem(null)} className="h-10 rounded-lg border border-theme-border px-3 text-sm text-secondary">取消</button><button type="button" disabled={saving || !expectedAt} onClick={() => void saveExpected()} className="h-10 rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:opacity-50">{saving ? '儲存中...' : '儲存'}</button></div></div> : null}
    {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
  </DialogFrame>;
}

function SEArrivalDialog({ projects, users, currentUserId, onClose, onCreated }: {
  projects: Project[];
  users: ReturnType<typeof useUser>['allUsers'];
  currentUserId: string | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('台');
  const [expectedAt, setExpectedAt] = useState(toDatetimeLocalValue(new Date().toISOString()));
  const [requestedBy, setRequestedBy] = useState(currentUserId || '');
  const [projectId, setProjectId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeUsers = users.filter(user => user.is_active);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const numericQuantity = Number(quantity);
    const receivedTime = fromDatetimeLocalValue(expectedAt);
    if (!item.trim() || !Number.isFinite(numericQuantity) || numericQuantity <= 0 || !unit.trim() || !receivedTime || !requestedBy) return;
    const project = projects.find(row => row.id === projectId);
    setSaving(true);
    setError(null);
    try {
      await dbAdapter.createSESupplyRecord({
        project_id: project?.id || null,
        project_name: project?.name || null,
        old_model: null,
        faulty_serial: null,
        fault_reason: null,
        new_model: item.trim(),
        new_serial: null,
        receive_method: 'SE 寄件到北辦',
        receive_date: null,
        replace_date: null,
        notes: notes.trim() || null,
        quantity: numericQuantity,
        unit: unit.trim(),
        expected_delivery_at: receivedTime,
        requested_by: requestedBy,
        procurement_status: 'ORDERED',
        received_at: null,
        received_by: null,
      });
      await onCreated();
    } catch (createError) {
      setError(getDatabaseErrorMessage(createError, '新增 SE 到貨失敗。'));
    } finally {
      setSaving(false);
    }
  };

  return <DialogFrame title="新增 SE 到貨" onClose={onClose}>
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-secondary sm:col-span-2">品項 / 型號<input autoFocus required value={item} onChange={event => setItem(event.target.value)} className={`${inputClass} mt-1`} /></label>
      <label className="text-xs text-secondary">數量<input required type="number" min="0.001" step="any" value={quantity} onChange={event => setQuantity(event.target.value)} className={`${inputClass} mt-1`} /></label>
      <label className="text-xs text-secondary">單位<input required value={unit} onChange={event => setUnit(event.target.value)} className={`${inputClass} mt-1`} /></label>
      <label className="text-xs text-secondary sm:col-span-2">預計到貨<input required type="datetime-local" step="60" value={expectedAt} onChange={event => setExpectedAt(event.target.value)} className={`${inputClass} mt-1`} /></label>
      <label className="text-xs text-secondary">申請人<select required value={requestedBy} onChange={event => setRequestedBy(event.target.value)} className={`${inputClass} mt-1`}><option value="">選擇申請人</option>{activeUsers.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
      <label className="text-xs text-secondary">案件（選填）<select value={projectId} onChange={event => setProjectId(event.target.value)} className={`${inputClass} mt-1`}><option value="">不掛案件</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="text-xs text-secondary sm:col-span-2">備註（選填）<input value={notes} onChange={event => setNotes(event.target.value)} className={`${inputClass} mt-1`} /></label>
      {error ? <p className="text-sm text-danger sm:col-span-2">{error}</p> : null}
      <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" onClick={onClose} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-secondary">取消</button><button type="submit" disabled={saving} className="h-10 rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:opacity-50">{saving ? '新增中...' : '新增'}</button></div>
    </form>
  </DialogFrame>;
}

function ConfirmReceiptDialog({ item, onClose, onConfirmed }: {
  item: PendingReceivingItem;
  onClose: () => void;
  onConfirmed: () => void | Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(item.remainingQuantity));
  const [receivedAt, setReceivedAt] = useState(toDatetimeLocalValue(new Date().toISOString()));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const numericQuantity = Number(quantity);
    const timestamp = fromDatetimeLocalValue(receivedAt);
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0 || numericQuantity > item.remainingQuantity || !timestamp) return;
    setSaving(true);
    setError(null);
    try {
      await dbAdapter.confirmMaterialReceipt({
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        quantityReceived: numericQuantity,
        receivedAt: timestamp,
        notes: notes.trim() || null,
      });
      await onConfirmed();
    } catch (confirmError) {
      setError(getDatabaseErrorMessage(confirmError, '確認收料失敗。'));
    } finally {
      setSaving(false);
    }
  };

  return <DialogFrame title="確認收到" onClose={onClose}>
    <form onSubmit={submit} className="space-y-3">
      <div className="rounded-lg border border-theme-border bg-page/50 p-3 text-sm"><div className="font-bold">{item.itemLabel}</div><div className="mt-1 text-secondary">{item.sourceLabel}｜{item.contextLabel}｜待收：{formatReceivingQuantity(item.remainingQuantity)} {item.unit}</div></div>
      <label className="block text-xs text-secondary">收到數量<input required type="number" min="0.001" max={item.remainingQuantity} step="any" value={quantity} onChange={event => setQuantity(event.target.value)} className={`${inputClass} mt-1`} /></label>
      <label className="block text-xs text-secondary">收到時間<input required type="datetime-local" step="60" value={receivedAt} onChange={event => setReceivedAt(event.target.value)} className={`${inputClass} mt-1`} /></label>
      <label className="block text-xs text-secondary">備註（選填）<input value={notes} onChange={event => setNotes(event.target.value)} className={`${inputClass} mt-1`} /></label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-secondary">取消</button><button type="submit" disabled={saving} className="h-10 rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:opacity-50">{saving ? '確認中...' : '確認收到'}</button></div>
    </form>
  </DialogFrame>;
}

function DialogFrame({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-3" role="dialog" aria-modal="true" aria-label={title}>
    <div className={`max-h-[90dvh] w-full overflow-y-auto rounded-xl border border-theme-border bg-card shadow-2xl ${wide ? 'max-w-5xl' : 'max-w-xl'}`}>
      <div className="flex items-center justify-between border-b border-theme-border px-4 py-3"><h2 className="flex items-center gap-2 font-bold"><PackageCheck size={18} className="text-accent" />{title}</h2><button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-secondary hover:bg-page" aria-label="關閉"><X size={18} /></button></div>
      <div className="p-4">{children}</div>
    </div>
  </div>;
}
