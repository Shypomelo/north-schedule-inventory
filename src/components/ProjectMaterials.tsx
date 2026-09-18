"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronRight, Clipboard, MoreHorizontal, PackagePlus, Plus, Trash2 } from 'lucide-react';
import { useUser } from './UserContext';
import { useRowAutosave, type RowAutosaveState } from '@/hooks/useRowAutosave';
import { dbAdapter } from '@/lib/db';
import { ReceiptDateTimeInput } from './ReceiptDateTimeInput';
import { MaterialReceiptHistoryDialog } from './MaterialReceiptHistoryDialog';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import type { DeliveryDestination, MaterialCatalogItem, MaterialGroup, MaterialReceipt, ProjectMaterial, ProjectMaterialBatch, ProjectMaterialCreateInput } from '@/lib/db/types';
import {
  buildCustomProjectMaterial,
  buildProjectMaterialFromCatalog,
  buildPurchaseRequestText,
  deriveBatchProcurementSummary,
  DELIVERY_DESTINATION_OPTIONS,
  filterMaterialCatalogByGroupId,
  fromDatetimeLocalValue,
  getActiveMaterialGroups,
  getProjectMaterialGroupLabel,
  getProcurementStatusLabel,
  toDatetimeLocalValue,
} from '@/lib/project-materials';
import { formatCompactTaipeiReceiptTime, getEffectiveExpectedDeliveryAt } from '@/lib/material-receipt-time';
import { summarizeMaterialReceipts } from '@/lib/material-receiving';

const compactInputClass = 'h-8 w-full min-w-0 rounded-md border border-theme-border bg-page px-2 text-xs text-primary outline-none focus:border-accent disabled:opacity-60';

const statusClass: Record<ProjectMaterial['procurement_status'], string> = {
  NOT_ORDERED: 'border-warning/30 bg-warning/10 text-warning',
  ORDERED: 'border-accent/30 bg-accent/10 text-accent',
  PARTIAL_RECEIVED: 'border-indigo-400/30 bg-indigo-400/10 text-indigo-300',
  RECEIVED: 'border-success/30 bg-success/10 text-success',
};

interface Props {
  projectId: string;
  projectName: string;
  canEdit: boolean;
}

export function ProjectMaterials({ projectId, projectName, canEdit }: Props) {
  const { currentUser } = useUser();
  const [batches, setBatches] = useState<ProjectMaterialBatch[]>([]);
  const [materials, setMaterials] = useState<ProjectMaterial[]>([]);
  const [catalog, setCatalog] = useState<MaterialCatalogItem[]>([]);
  const [groups, setGroups] = useState<MaterialGroup[]>([]);
  const [receipts, setReceipts] = useState<MaterialReceipt[]>([]);
  const [historyMaterial, setHistoryMaterial] = useState<ProjectMaterial | null>(null);
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [newBatchName, setNewBatchName] = useState('');
  const [newBatchOrderedAt, setNewBatchOrderedAt] = useState('');
  const [newBatchPlannedReceiptAt, setNewBatchPlannedReceiptAt] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [batchRows, materialRows, catalogRows, groupRows, receiptRows] = await Promise.all([
        dbAdapter.listProjectMaterialBatches(projectId),
        dbAdapter.listProjectMaterials(projectId),
        dbAdapter.listMaterialCatalogItems(true),
        dbAdapter.listMaterialGroups(true),
        dbAdapter.listMaterialReceipts(),
      ]);
      setBatches(batchRows);
      setMaterials(materialRows);
      setCatalog(catalogRows);
      setGroups(groupRows);
      setReceipts(receiptRows);
      const preferred = batchRows.find(batch => deriveBatchProcurementSummary(
        batch,
        materialRows.filter(material => material.batch_id === batch.id),
      ).status !== 'RECEIVED') ?? batchRows[0];
      setExpandedBatchIds(preferred ? new Set([preferred.id]) : new Set());
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '無法載入案件叫料批次。'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const handleAutosaveError = useCallback((saveError: unknown, validationMessage?: string) => {
    setError(validationMessage || getDatabaseErrorMessage(saveError, '自動儲存失敗。'));
  }, []);

  const batchAutosave = useRowAutosave({
    rows: batches,
    setRows: setBatches,
    saveRow: useCallback(async (batch: ProjectMaterialBatch) => {
      const saved = await dbAdapter.updateProjectMaterialBatch(batch.id, {
        batch_name: batch.batch_name,
        ordered_at: batch.ordered_at,
        notes: batch.notes,
      });
      const result = saved.planned_receipt_at === batch.planned_receipt_at
        ? saved
        : await dbAdapter.updateMaterialReceiptPlan(batch.id, batch.planned_receipt_at);
      return result;
    }, []),
    validate: batch => batch.batch_name.trim() ? null : '批次名稱不可留白。',
    onError: handleAutosaveError,
    delay: 700,
  });

  const materialAutosave = useRowAutosave({
    rows: materials,
    setRows: setMaterials,
    saveRow: useCallback(async (material: ProjectMaterial) => {
      const saved = await dbAdapter.updateProjectMaterial(material.id, {
        item_name: material.item_name,
        specification: material.specification,
        quantity: material.quantity,
        unit: material.unit,
        reminder_enabled: material.reminder_enabled,
        reminder_days_before: material.reminder_enabled ? material.reminder_days_before : null,
        include_in_purchase_request: material.include_in_purchase_request,
        delivery_destination: material.delivery_destination,
        delivery_destination_note: material.delivery_destination === 'OTHER' ? material.delivery_destination_note : null,
        notes: material.notes,
      });
      return saved;
    }, []),
    validate: material => {
      if (!material.item_name.trim()) return '品項名稱不可留白。';
      if (!material.unit.trim()) return '單位不可留白。';
      if (!Number.isFinite(material.quantity) || material.quantity <= 0) return '數量必須大於 0。';
      if (material.reminder_enabled && material.reminder_days_before === null) return '請填寫提醒提前天數。';
      return null;
    },
    onError: handleAutosaveError,
    delay: 700,
  });

  const orderedBatches = useMemo(() => [...batches].sort((left, right) => {
    const leftComplete = deriveBatchProcurementSummary(left, materials.filter(row => row.batch_id === left.id)).status === 'RECEIVED';
    const rightComplete = deriveBatchProcurementSummary(right, materials.filter(row => row.batch_id === right.id)).status === 'RECEIVED';
    if (leftComplete !== rightComplete) return leftComplete ? 1 : -1;
    return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id);
  }), [batches, materials]);

  const createBatch = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentUser || !newBatchName.trim() || !canEdit) return;
    setBusyId('new-batch');
    setError(null);
    try {
      const created = await dbAdapter.createProjectMaterialBatch({
        project_id: projectId,
        batch_name: newBatchName,
        ordered_at: fromDatetimeLocalValue(newBatchOrderedAt),
        planned_receipt_at: newBatchPlannedReceiptAt || null,
        same_day_delivery: true,
        received_at: null,
        notes: null,
        created_by: currentUser.id,
      });
      setBatches(current => [created, ...current]);
      setExpandedBatchIds(new Set([created.id]));
      setShowBatchCreate(false);
      setNewBatchName('');
      setNewBatchOrderedAt('');
      setNewBatchPlannedReceiptAt('');
      setNotice('叫料批次已新增。');
    } catch (createError) {
      setError(getDatabaseErrorMessage(createError, '新增叫料批次失敗。'));
    } finally {
      setBusyId(null);
    }
  };

  const openBatchCreate = () => {
    setNewBatchName(`第 ${batches.length + 1} 次叫料`);
    setNewBatchOrderedAt(toDatetimeLocalValue(new Date().toISOString()));
    setNewBatchPlannedReceiptAt(new Date().toISOString());
    setShowBatchCreate(true);
    setError(null);
  };

  const deleteBatch = async (batch: ProjectMaterialBatch, batchMaterials: ProjectMaterial[]) => {
    const message = batchMaterials.length > 0
      ? `刪除「${batch.batch_name}」會一併刪除此批次內 ${batchMaterials.length} 筆物料，確定要繼續嗎？`
      : `確定刪除「${batch.batch_name}」嗎？`;
    if (!window.confirm(message)) return;
    batchAutosave.cancel(batch.id);
    batchMaterials.forEach(material => materialAutosave.cancel(material.id));
    setBusyId(batch.id);
    setError(null);
    try {
      await dbAdapter.deleteProjectMaterialBatch(batch.id);
      setBatches(current => current.filter(row => row.id !== batch.id));
      setMaterials(current => current.filter(row => row.batch_id !== batch.id));
      setExpandedBatchIds(current => {
        const next = new Set(current);
        next.delete(batch.id);
        return next;
      });
      setNotice(`已刪除「${batch.batch_name}」。`);
    } catch (deleteError) {
      setError(getDatabaseErrorMessage(deleteError, '刪除叫料批次失敗。'));
    } finally {
      setBusyId(null);
    }
  };

  const deleteMaterial = async (material: ProjectMaterial) => {
    if (!window.confirm(`確定刪除「${material.item_name}」嗎？`)) return;
    materialAutosave.cancel(material.id);
    setBusyId(material.id);
    setError(null);
    try {
      await dbAdapter.deleteProjectMaterial(material.id);
      setMaterials(current => current.filter(row => row.id !== material.id));
      setNotice(`已刪除「${material.item_name}」。`);
    } catch (deleteError) {
      setError(getDatabaseErrorMessage(deleteError, '刪除物料失敗。'));
    } finally {
      setBusyId(null);
    }
  };

  const addMaterial = async (input: ProjectMaterialCreateInput) => {
    setBusyId(`add-${input.batch_id}`);
    setError(null);
    try {
      const created = await dbAdapter.createProjectMaterial({
        ...input,
        expected_delivery_at: input.expected_delivery_at ?? null,
      });
      setMaterials(current => [...current, created]);
      setNotice(`已加入「${created.item_name}」。`);
      return created;
    } catch (createError) {
      setError(getDatabaseErrorMessage(createError, '加入物料失敗。'));
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const setBatchSameDay = async (batch: ProjectMaterialBatch, sameDayDelivery: boolean) => {
    if (sameDayDelivery) {
      const hasOverrides = materials.some(material => material.batch_id === batch.id
        && !material.received_at
        && material.procurement_status !== 'RECEIVED'
        && Boolean(material.expected_delivery_at));
      if (hasOverrides && !window.confirm('改回同日到貨會清除未完成物料的個別到貨時間，並合併其作用中收料排程。確定繼續嗎？')) return;
    }
    setBusyId(`same-day-${batch.id}`);
    setError(null);
    try {
      const saved = await dbAdapter.setMaterialBatchSameDay(batch.id, sameDayDelivery);
      setBatches(current => current.map(row => row.id === batch.id ? saved : row));
      if (sameDayDelivery) setMaterials(current => current.map(material => (
        material.batch_id === batch.id && !material.received_at && material.procurement_status !== 'RECEIVED'
          ? { ...material, expected_delivery_at: null }
          : material
      )));
      setNotice(sameDayDelivery ? '已改為同日到貨。' : '已允許個別物料覆寫到貨時間。');
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '更新同日到貨設定失敗。'));
    } finally {
      setBusyId(null);
    }
  };

  const updateMaterialReceiptTime = async (material: ProjectMaterial, expectedDeliveryAt: string | null) => {
    setMaterials(current => current.map(row => row.id === material.id ? { ...row, expected_delivery_at: expectedDeliveryAt } : row));
    setError(null);
    try {
      const saved = await dbAdapter.updateMaterialReceiptOverride(material.id, expectedDeliveryAt);
      setMaterials(current => current.map(row => row.id === material.id ? saved : row));
    } catch (saveError) {
      setMaterials(current => current.map(row => row.id === material.id ? material : row));
      setError(getDatabaseErrorMessage(saveError, '更新物料到貨時間失敗。'));
    }
  };

  const refreshReceiptState = useCallback(async () => {
    const [batchRows, materialRows, receiptRows] = await Promise.all([
      dbAdapter.listProjectMaterialBatches(projectId),
      dbAdapter.listProjectMaterials(projectId),
      dbAdapter.listMaterialReceipts(),
    ]);
    setBatches(batchRows);
    setMaterials(materialRows);
    setReceipts(receiptRows);
  }, [projectId]);

  const toggleBatch = (id: string) => setExpandedBatchIds(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  if (loading) return <div className="rounded-xl border border-theme-border bg-card/40 p-10 text-center text-secondary">物料載入中...</div>;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-theme-border bg-card/50 p-4">
      <div><h3 className="flex items-center gap-2 font-semibold text-primary"><PackagePlus size={18} className="text-accent" />叫料批次</h3><p className="mt-1 text-xs text-secondary">{batches.length} 個批次，{materials.length} 筆物料</p></div>
      {canEdit && <button type="button" onClick={openBatchCreate} className="flex min-h-10 items-center gap-2 rounded-lg bg-accent px-3 text-sm font-semibold text-white hover:bg-accent-hover"><Plus size={16} />新增叫料批次</button>}
    </div>
    {showBatchCreate && <form onSubmit={createBatch} className="grid gap-3 rounded-xl border border-accent/30 bg-accent/5 p-4 sm:grid-cols-[minmax(12rem,1fr)_12rem_12rem_auto_auto] sm:items-end">
      <label className="text-xs text-secondary">批次名稱<input autoFocus value={newBatchName} onChange={event => setNewBatchName(event.target.value)} className={`${compactInputClass} mt-1 h-10`} /></label>
      <label className="text-xs text-secondary">叫料日期＋時間<input type="datetime-local" step="60" value={newBatchOrderedAt} onChange={event => setNewBatchOrderedAt(event.target.value)} className={`${compactInputClass} mt-1 h-10`} /></label>
      <label className="text-xs text-secondary">預計收料日期＋時間<div className="mt-1"><ReceiptDateTimeInput required label="新批次預計收料" value={newBatchPlannedReceiptAt || null} onChange={value => setNewBatchPlannedReceiptAt(value || '')} /></div></label>
      <button type="button" onClick={() => setShowBatchCreate(false)} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-secondary hover:bg-page">取消</button>
      <button type="submit" disabled={!newBatchName.trim() || !newBatchPlannedReceiptAt || busyId !== null} className="h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{busyId === 'new-batch' ? '新增中...' : '新增批次'}</button>
    </form>}
    {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>}
    {notice && <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">{notice}</div>}
    {orderedBatches.length === 0 ? <div className="rounded-xl border border-dashed border-theme-border p-10 text-center text-secondary">尚未建立叫料批次。</div> : orderedBatches.map(batch => {
      const batchMaterials = materials.filter(material => material.batch_id === batch.id);
      return <BatchCard key={batch.id} batch={batch} projectName={projectName} materials={batchMaterials} receipts={receipts} catalog={catalog} groups={groups} canEdit={canEdit} isExpanded={expandedBatchIds.has(batch.id)} isBusy={busyId !== null} batchSaveState={batchAutosave.stateFor(batch.id)} materialStateFor={materialAutosave.stateFor} onToggle={() => toggleBatch(batch.id)} onBatchChange={updates => batchAutosave.updateRow(batch.id, updates)} onBatchBlur={() => batchAutosave.flush(batch.id)} onSameDayChange={value => void setBatchSameDay(batch, value)} onDeleteBatch={() => void deleteBatch(batch, batchMaterials)} onMaterialChange={(id, updates) => materialAutosave.updateRow(id, updates)} onMaterialReceiptTimeChange={(material, value) => void updateMaterialReceiptTime(material, value)} onMaterialBlur={id => materialAutosave.flush(id)} onDeleteMaterial={material => void deleteMaterial(material)} onOpenHistory={setHistoryMaterial} onAddMaterial={addMaterial} onNotice={setNotice} onError={setError} currentUserId={currentUser?.id ?? null} />;
    })}
    {historyMaterial ? <MaterialReceiptHistoryDialog receipts={receipts} sourceType="PROJECT_MATERIAL" sourceId={historyMaterial.id} itemLabel={historyMaterial.specification?.trim() || historyMaterial.item_name} contextLabel={projectName} unit={historyMaterial.unit} canEdit={canEdit} onClose={() => setHistoryMaterial(null)} onChanged={refreshReceiptState} /> : null}
  </div>;
}

interface BatchCardProps {
  batch: ProjectMaterialBatch;
  projectName: string;
  materials: ProjectMaterial[];
  receipts: MaterialReceipt[];
  catalog: MaterialCatalogItem[];
  groups: MaterialGroup[];
  canEdit: boolean;
  isExpanded: boolean;
  isBusy: boolean;
  batchSaveState: RowAutosaveState;
  materialStateFor: (id: string) => RowAutosaveState;
  onToggle: () => void;
  onBatchChange: (updates: Partial<ProjectMaterialBatch>) => void;
  onBatchBlur: () => void;
  onSameDayChange: (value: boolean) => void;
  onDeleteBatch: () => void;
  onMaterialChange: (id: string, updates: Partial<ProjectMaterial>) => void;
  onMaterialReceiptTimeChange: (material: ProjectMaterial, value: string | null) => void;
  onMaterialBlur: (id: string) => void;
  onDeleteMaterial: (material: ProjectMaterial) => void;
  onOpenHistory: (material: ProjectMaterial) => void;
  onAddMaterial: (input: ProjectMaterialCreateInput) => Promise<ProjectMaterial | null>;
  onNotice: (message: string | null) => void;
  onError: (message: string | null) => void;
  currentUserId: string | null;
}

interface QuickAddSlot {
  id: string;
  groupId: string;
  catalogItemId: string;
  materialId: string | null;
  state: 'idle' | 'saving' | 'saved' | 'error';
}

interface CustomMaterialDraft {
  id: string;
  item_name: string;
  specification: string;
  quantity: number;
  unit: string;
  delivery_destination: DeliveryDestination;
  delivery_destination_note: string;
}

const createQuickSlots = (count: number): QuickAddSlot[] => Array.from({ length: count }, (_, index) => ({
  id: `quick-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
  groupId: '',
  catalogItemId: '',
  materialId: null,
  state: 'idle',
}));

const createCustomDraft = (): CustomMaterialDraft => ({
  id: `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  item_name: '',
  specification: '',
  quantity: 1,
  unit: '式',
  delivery_destination: 'SITE',
  delivery_destination_note: '',
});

function BatchCard({ batch, projectName, materials, receipts, catalog, groups, canEdit, isExpanded, isBusy, batchSaveState, materialStateFor, onToggle, onBatchChange, onBatchBlur, onSameDayChange, onDeleteBatch, onMaterialChange, onMaterialReceiptTimeChange, onMaterialBlur, onDeleteMaterial, onOpenHistory, onAddMaterial, onNotice, onError, currentUserId }: BatchCardProps) {
  const [showRegularAdd, setShowRegularAdd] = useState(false);
  const [quickSlots, setQuickSlots] = useState<QuickAddSlot[]>([]);
  const [customDrafts, setCustomDrafts] = useState<CustomMaterialDraft[]>([]);
  const activeGroups = useMemo(() => getActiveMaterialGroups(groups), [groups]);
  const summary = deriveBatchProcurementSummary(batch, materials);
  const copyCount = materials.filter(material => material.include_in_purchase_request).length;

  useEffect(() => {
    if (!showRegularAdd) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowRegularAdd(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showRegularAdd]);

  const openQuickAdd = () => {
    setShowRegularAdd(true);
    setQuickSlots(current => current.length > 0 ? current : createQuickSlots(5));
  };

  const updateQuickSlot = (id: string, updates: Partial<QuickAddSlot>) => {
    setQuickSlots(current => current.map(slot => slot.id === id ? { ...slot, ...updates } : slot));
  };

  const chooseQuickItem = async (slot: QuickAddSlot, catalogItemId: string) => {
    if (!currentUserId || slot.materialId) return;
    const item = catalog.find(candidate => candidate.id === catalogItemId);
    if (!item) return;
    updateQuickSlot(slot.id, { catalogItemId, state: 'saving' });
    const created = await onAddMaterial(buildProjectMaterialFromCatalog(batch.project_id, batch.id, item, currentUserId));
    updateQuickSlot(slot.id, created
      ? { catalogItemId, materialId: created.id, state: 'saved' }
      : { catalogItemId, state: 'error' });
  };

  const copyBatch = async () => {
    const text = buildPurchaseRequestText(projectName, batch, materials);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onNotice(`已複製「${batch.batch_name}」${copyCount} 筆請購內容。`);
      onError(null);
    } catch {
      onError('瀏覽器無法寫入剪貼簿，請確認剪貼簿權限。');
    }
  };

  return <section className="rounded-xl border border-theme-border bg-card/40">
    <div className="flex flex-wrap items-center gap-3 p-3" onBlur={onBatchBlur}>
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {isExpanded ? <ChevronDown size={18} className="shrink-0 text-secondary" /> : <ChevronRight size={18} className="shrink-0 text-secondary" />}
        <span className="min-w-0"><span className="block truncate text-sm font-semibold text-primary">{batch.batch_name}</span><span className="block text-xs text-secondary">{batch.same_day_delivery ? '整批共用預計到貨' : '可個別覆寫預計到貨'}</span></span>
      </button>
      <label className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-theme-border bg-page/40 px-2 text-xs font-semibold text-primary"><input type="checkbox" checked={batch.same_day_delivery} disabled={!canEdit || Boolean(batch.received_at) || isBusy} onChange={event => onSameDayChange(event.target.checked)} className="h-4 w-4 accent-accent" />同天到貨</label>
      <div className="flex min-w-[13.5rem] items-center gap-2"><span className="shrink-0 text-xs text-secondary">預設到貨</span><div className="min-w-0 flex-1"><ReceiptDateTimeInput compact required label={`${batch.batch_name}預設到貨`} disabled={!canEdit || Boolean(batch.received_at)} value={batch.planned_receipt_at} onChange={value => onBatchChange({ planned_receipt_at: value })} /></div></div>
      <span className={`rounded-full border px-2 py-1 text-xs ${statusClass[summary.status]}`}>{getProcurementStatusLabel(summary.status)}</span>
      <span className="text-xs text-secondary">{summary.received} / {summary.total} 筆已到貨</span>
      <button type="button" disabled={copyCount === 0} onClick={() => void copyBatch()} className="flex h-9 items-center gap-1 rounded-lg border border-theme-border px-2 text-xs text-primary hover:bg-page disabled:opacity-40"><Clipboard size={14} />複製請購內容</button>
      {canEdit && <details className="relative">
        <summary className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-lg border border-theme-border text-secondary hover:bg-page" aria-label={`編輯${batch.batch_name}`}><MoreHorizontal size={17} /></summary>
        <div className="absolute right-0 z-20 mt-2 w-72 space-y-3 rounded-xl border border-theme-border bg-card p-3 shadow-xl">
          <label className="block text-xs text-secondary">批次名稱<input value={batch.batch_name} onChange={event => onBatchChange({ batch_name: event.target.value })} className={`${compactInputClass} mt-1`} /></label>
          <label className="block text-xs text-secondary">叫料日期＋時間<input type="datetime-local" step="60" value={toDatetimeLocalValue(batch.ordered_at)} onChange={event => onBatchChange({ ordered_at: fromDatetimeLocalValue(event.target.value) })} className={`${compactInputClass} mt-1`} /></label>
          {batch.received_at ? <p className="text-xs font-semibold text-success">已收料 {toDatetimeLocalValue(batch.received_at).replace('T', ' ')}</p> : null}
          <label className="block text-xs text-secondary">備註<input value={batch.notes || ''} onChange={event => onBatchChange({ notes: event.target.value || null })} className={`${compactInputClass} mt-1`} /></label>
          <div className="flex items-center justify-between"><AutosaveStatus state={batchSaveState} /><button type="button" disabled={isBusy} onClick={onDeleteBatch} className="flex items-center gap-1 text-xs text-danger"><Trash2 size={14} />刪除批次</button></div>
        </div>
      </details>}
    </div>
    {isExpanded && <div className="border-t border-theme-border">
      {canEdit && <div className="flex flex-wrap items-end gap-2 border-b border-theme-border bg-page/20 p-2">
        <button type="button" onClick={openQuickAdd} className="h-8 rounded-md border border-theme-border px-2 text-xs text-primary hover:bg-card"><Plus size={13} className="mr-1 inline" />常規物料</button>
        <button type="button" onClick={() => setCustomDrafts(current => [...current, createCustomDraft()])} className="h-8 rounded-md border border-theme-border px-2 text-xs text-primary hover:bg-card"><Plus size={13} className="mr-1 inline" />自訂物料</button>
        <span className="text-[11px] text-secondary">編輯後 700ms 自動儲存；快速新增可按 ESC 離開</span>
      </div>}
      {showRegularAdd && <div className="border-b border-accent/25 bg-accent/5 p-2">
        <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium text-primary">快速新增常規物料（空白格不會建立資料）</span><button type="button" onClick={() => setShowRegularAdd(false)} className="text-xs text-secondary hover:text-primary">ESC 關閉</button></div>
        <div className="overflow-x-auto"><div className="min-w-[32rem] space-y-1">
          <div className="grid grid-cols-[2rem_9rem_minmax(14rem,1.5fr)_7rem] gap-1 px-2 text-[11px] font-medium text-secondary"><span>#</span><span>群組</span><span>品項／型號</span><span>數量</span></div>
          {quickSlots.map((slot, index) => {
            const groupItems = slot.groupId ? filterMaterialCatalogByGroupId(catalog, slot.groupId) : [];
            const selectedItem = catalog.find(item => item.id === slot.catalogItemId);
            const createdMaterial = materials.find(material => material.id === slot.materialId);
            return <div key={slot.id} className="grid grid-cols-[2rem_9rem_minmax(14rem,1.5fr)_7rem] items-center gap-1 rounded-md bg-card/50 px-2 py-1">
              <span className="text-xs text-secondary">{index + 1}</span>
              <select aria-label={`第${index + 1}格物料群組`} disabled={Boolean(slot.materialId) || slot.state === 'saving'} value={slot.groupId} onChange={event => updateQuickSlot(slot.id, { groupId: event.target.value, catalogItemId: '' })} className={compactInputClass}><option value="">選群組</option>{activeGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
              <select aria-label={`第${index + 1}格常備品項`} disabled={!slot.groupId || Boolean(slot.materialId) || slot.state === 'saving'} value={slot.catalogItemId} onChange={event => void chooseQuickItem(slot, event.target.value)} className={compactInputClass}><option value="">選品項／型號</option>{groupItems.map(item => <option key={item.id} value={item.id}>{item.name}{item.default_specification ? `｜${item.default_specification}` : ''}</option>)}</select>
              <div className="flex items-center gap-1"><input type="number" min="0.001" step="any" disabled={!createdMaterial} value={createdMaterial?.quantity ?? 1} onChange={event => createdMaterial && onMaterialChange(createdMaterial.id, { quantity: Number(event.target.value) })} onBlur={() => createdMaterial && onMaterialBlur(createdMaterial.id)} className={compactInputClass} /><span className="shrink-0 text-xs text-secondary">{selectedItem?.default_unit || ''}</span></div>
            </div>;
          })}
          <button type="button" onClick={() => setQuickSlots(current => [...current, ...createQuickSlots(5)])} className="ml-2 mt-1 h-8 rounded-md border border-theme-border px-3 text-xs text-primary hover:bg-card"><Plus size={13} className="mr-1 inline" />再加 5 格</button>
        </div></div>
      </div>}
      <div className="overflow-x-auto"><div className="min-w-[48rem]">
        <div className="grid grid-cols-[2rem_4.75rem_minmax(6.5rem,1fr)_5.25rem_5.25rem_9.75rem_7.5rem_2rem] gap-1 border-b border-theme-border bg-page/35 px-2 py-1.5 text-[11px] font-medium text-secondary"><span>請購</span><span>群組</span><span>型號／規格</span><span>數量／單位</span><span>送達</span><span>預計到貨</span><span>實際到貨</span><span>⋯</span></div>
        {materials.length === 0 && customDrafts.length === 0 ? <div className="p-6 text-center text-sm text-secondary">此批次尚無物料。</div> : <>
          {materials.map(material => <MaterialGridRow key={material.id} material={material} batch={batch} receipts={receipts} groupLabel={getProjectMaterialGroupLabel(material, catalog, groups)} canEdit={canEdit} isBusy={isBusy} saveState={materialStateFor(material.id)} onChange={updates => onMaterialChange(material.id, updates)} onBlur={() => onMaterialBlur(material.id)} onPlannedReceiptChange={value => onMaterialReceiptTimeChange(material, value)} onOpenHistory={() => onOpenHistory(material)} onDelete={() => onDeleteMaterial(material)} />)}
          {customDrafts.map(draft => <CustomDraftGridRow key={draft.id} draft={draft} batch={batch} currentUserId={currentUserId} onAddMaterial={onAddMaterial} onCreated={() => setCustomDrafts(current => current.filter(row => row.id !== draft.id))} onRemove={() => setCustomDrafts(current => current.filter(row => row.id !== draft.id))} />)}
        </>}
      </div></div>
    </div>}
  </section>;
}

function MaterialGridRow({ material, batch, receipts, groupLabel, canEdit, isBusy, saveState, onChange, onBlur, onPlannedReceiptChange, onOpenHistory, onDelete }: { material: ProjectMaterial; batch: ProjectMaterialBatch; receipts: MaterialReceipt[]; groupLabel: string; canEdit: boolean; isBusy: boolean; saveState: RowAutosaveState; onChange: (updates: Partial<ProjectMaterial>) => void; onBlur: () => void; onPlannedReceiptChange: (value: string | null) => void; onOpenHistory: () => void; onDelete: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const receiptSummary = summarizeMaterialReceipts(receipts, 'PROJECT_MATERIAL', material.id, Number(material.quantity));
  const finishOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
  };
  return <div className="border-b border-theme-border/70 last:border-b-0" onBlur={onBlur}>
    <div className="grid grid-cols-[2rem_4.75rem_minmax(6.5rem,1fr)_5.25rem_5.25rem_9.75rem_7.5rem_2rem] items-center gap-1 px-2 py-1">
      <input type="checkbox" disabled={!canEdit} checked={material.include_in_purchase_request} onChange={event => onChange({ include_in_purchase_request: event.target.checked })} className="h-4 w-4 accent-accent" aria-label={`${material.item_name}納入請購`} />
      <span className="truncate px-1 text-xs text-primary" title={groupLabel || material.item_name}>{groupLabel || material.item_name}</span>
      <input disabled={!canEdit} value={material.specification || ''} onChange={event => onChange({ specification: event.target.value || null })} onKeyDown={finishOnEnter} className={compactInputClass} aria-label="型號／規格" />
      <div className="flex items-center gap-1"><input type="number" min="0.001" step="any" disabled={!canEdit} value={material.quantity} onChange={event => onChange({ quantity: Number(event.target.value) })} onKeyDown={finishOnEnter} className={compactInputClass} aria-label="數量" /><span className="max-w-10 truncate text-xs text-secondary" title={material.unit}>{material.unit}</span></div>
      <div className="flex min-w-0 items-center gap-1">
        <select disabled={!canEdit} value={material.delivery_destination} onChange={event => onChange({ delivery_destination: event.target.value as DeliveryDestination, delivery_destination_note: event.target.value === 'OTHER' ? material.delivery_destination_note : null })} className={`${compactInputClass} ${material.delivery_destination === 'OTHER' ? 'w-20 shrink-0' : 'w-full'}`} aria-label={`${material.item_name}送達位置`}>{DELIVERY_DESTINATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        {material.delivery_destination === 'OTHER' ? <input disabled={!canEdit} maxLength={80} value={material.delivery_destination_note || ''} onChange={event => onChange({ delivery_destination_note: event.target.value || null })} onKeyDown={finishOnEnter} placeholder="自訂位置" className={compactInputClass} aria-label={`${material.item_name}其他送達位置`} /> : null}
      </div>
      {batch.same_day_delivery ? <span className="px-1 text-xs text-secondary">{formatCompactTaipeiReceiptTime(batch.planned_receipt_at)}</span> : <ReceiptDateTimeInput compact label={`${material.item_name}預計到貨`} disabled={!canEdit || Boolean(batch.received_at)} value={getEffectiveExpectedDeliveryAt(material, batch)} onChange={onPlannedReceiptChange} />}
      <button type="button" disabled={receiptSummary.effectiveQuantity <= 0} onClick={onOpenHistory} className="min-h-8 rounded-md px-1 text-left text-xs text-secondary hover:bg-page disabled:cursor-default disabled:hover:bg-transparent" aria-label={`${material.item_name}收料紀錄`}>{receiptSummary.status === 'PENDING' ? '—' : <><span className={`block font-bold ${receiptSummary.status === 'PARTIAL_RECEIVED' ? 'text-warning' : 'text-success'}`}>{receiptSummary.status === 'PARTIAL_RECEIVED' ? '未全' : '已收到'}</span><span className="block">{formatCompactTaipeiReceiptTime(receiptSummary.lastReceivedAt)}</span></>}</button>
      <button type="button" onClick={() => setShowDetails(current => !current)} className="flex h-8 items-center justify-center rounded-md text-secondary hover:bg-page" aria-label={`${material.item_name}更多設定`}><MoreHorizontal size={16} /></button>
    </div>
    {showDetails && <div className="mx-2 mb-2 grid gap-2 rounded-lg border border-theme-border bg-page/25 p-2 sm:grid-cols-[16rem_13rem_minmax(10rem,1fr)_auto] sm:items-end">
        <div className="grid grid-cols-2 gap-2"><label className="text-xs text-secondary">單位<input disabled={!canEdit} value={material.unit} onChange={event => onChange({ unit: event.target.value })} onKeyDown={finishOnEnter} className={`${compactInputClass} mt-1`} /></label><div className="text-xs text-secondary">採購狀態<span className={`mt-1 flex h-8 items-center rounded-md border px-2 ${statusClass[material.procurement_status]}`}>{getProcurementStatusLabel(material.procurement_status)}</span></div></div>
        <div className="flex items-end gap-2"><label className="flex h-8 items-center gap-1 text-xs text-secondary"><Bell size={14} /><input type="checkbox" disabled={!canEdit} checked={material.reminder_enabled} onChange={event => onChange({ reminder_enabled: event.target.checked, reminder_days_before: event.target.checked ? material.reminder_days_before ?? 7 : null })} className="h-4 w-4 accent-accent" />提醒</label><label className="text-xs text-secondary">提前天數<input type="number" min={0} max={3650} disabled={!canEdit || !material.reminder_enabled} value={material.reminder_days_before ?? 7} onChange={event => onChange({ reminder_days_before: Number(event.target.value) })} onKeyDown={finishOnEnter} className={`${compactInputClass} mt-1 w-20`} /></label></div>
        <label className="block text-xs text-secondary">備註<input disabled={!canEdit} value={material.notes || ''} onChange={event => onChange({ notes: event.target.value || null })} onKeyDown={finishOnEnter} className={`${compactInputClass} mt-1`} /></label>
        <div className="flex items-center justify-between"><AutosaveStatus state={saveState} />{canEdit && <button type="button" disabled={isBusy} onClick={onDelete} className="flex items-center gap-1 text-xs text-danger"><Trash2 size={14} />刪除</button>}</div>
      </div>}
    <div className="flex justify-end px-2 pb-1"><AutosaveStatus state={saveState} compact /></div>
  </div>;
}

function CustomDraftGridRow({ draft: initialDraft, batch, currentUserId, onAddMaterial, onCreated, onRemove }: {
  draft: CustomMaterialDraft;
  batch: ProjectMaterialBatch;
  currentUserId: string | null;
  onAddMaterial: (input: ProjectMaterialCreateInput) => Promise<ProjectMaterial | null>;
  onCreated: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [state, setState] = useState<RowAutosaveState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creatingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const persist = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const snapshot = draftRef.current;
    if (creatingRef.current || !currentUserId) return;
    if (!snapshot.item_name.trim()) { setState('idle'); return; }
    if (!snapshot.unit.trim() || !Number.isFinite(snapshot.quantity) || snapshot.quantity <= 0) {
      setState('error');
      return;
    }
    creatingRef.current = true;
    setState('saving');
    const created = await onAddMaterial(buildCustomProjectMaterial(batch.project_id, batch.id, currentUserId, snapshot));
    creatingRef.current = false;
    if (created) onCreated(); else setState('error');
  }, [batch.id, batch.project_id, currentUserId, onAddMaterial, onCreated]);

  const updateDraft = (updates: Partial<CustomMaterialDraft>) => {
    setDraft(current => {
      const next = { ...current, ...updates };
      draftRef.current = next;
      return next;
    });
    if (timerRef.current) clearTimeout(timerRef.current);
    setState('saving');
    timerRef.current = setTimeout(() => void persist(), 700);
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const finishOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
  };

  return <div className="border-b border-accent/20 bg-accent/5" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void persist(); }}>
    <div className="grid grid-cols-[2rem_4.75rem_minmax(6.5rem,1fr)_5.25rem_5.25rem_9.75rem_7.5rem_2rem] items-center gap-1 px-2 py-1">
      <input type="checkbox" checked readOnly className="h-4 w-4 accent-accent" aria-label="自訂物料納入請購" />
      <input autoFocus value={draft.item_name} onChange={event => updateDraft({ item_name: event.target.value })} onKeyDown={finishOnEnter} className={compactInputClass} placeholder="自訂品項" aria-label="自訂品項名稱" />
      <input value={draft.specification} onChange={event => updateDraft({ specification: event.target.value })} onKeyDown={finishOnEnter} className={compactInputClass} placeholder="型號／規格" aria-label="自訂型號／規格" />
      <div className="flex items-center gap-1"><input type="number" min="0.001" step="any" value={draft.quantity} onChange={event => updateDraft({ quantity: Number(event.target.value) })} onKeyDown={finishOnEnter} className={compactInputClass} aria-label="自訂數量" /><input value={draft.unit} onChange={event => updateDraft({ unit: event.target.value })} onKeyDown={finishOnEnter} className={`${compactInputClass} w-12 px-1`} aria-label="自訂單位" /></div>
      <div className="flex min-w-0 items-center gap-1"><select value={draft.delivery_destination} onChange={event => updateDraft({ delivery_destination: event.target.value as DeliveryDestination, delivery_destination_note: event.target.value === 'OTHER' ? draft.delivery_destination_note : '' })} className={`${compactInputClass} ${draft.delivery_destination === 'OTHER' ? 'w-20 shrink-0' : 'w-full'}`} aria-label="自訂物料送達位置">{DELIVERY_DESTINATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{draft.delivery_destination === 'OTHER' ? <input maxLength={80} value={draft.delivery_destination_note} onChange={event => updateDraft({ delivery_destination_note: event.target.value })} onKeyDown={finishOnEnter} placeholder="自訂位置" className={compactInputClass} aria-label="自訂物料其他送達位置" /> : null}</div>
      <span className="px-1 text-xs text-secondary">{formatCompactTaipeiReceiptTime(batch.planned_receipt_at)}</span>
      <span className="px-1 text-xs text-secondary">—</span>
      <button type="button" onClick={onRemove} className="flex h-8 items-center justify-center rounded-md text-secondary hover:bg-page" aria-label="移除空白自訂列"><Trash2 size={15} /></button>
    </div>
    <div className="flex justify-end px-2 pb-1"><AutosaveStatus state={state} compact /></div>
  </div>;
}

function AutosaveStatus({ state, compact = false }: { state: RowAutosaveState; compact?: boolean }) {
  const className = compact ? 'text-[10px]' : 'text-xs';
  if (state === 'saving') return <span className={`${className} text-secondary`}>儲存中…</span>;
  if (state === 'saved') return <span className={`${className} text-success`}>已儲存</span>;
  if (state === 'error') return <span className={`${className} text-danger`}>儲存失敗</span>;
  return <span className={`${className} text-secondary`}>自動儲存</span>;
}
