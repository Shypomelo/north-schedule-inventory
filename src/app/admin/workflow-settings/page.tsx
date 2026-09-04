"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Layers3, ListChecks, Plus, Shapes } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { dbAdapter } from '@/lib/db';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import type { WorkflowPhase, WorkflowTemplate, WorkflowTemplateStep, WorkflowType } from '@/lib/db/types';

type Tab = 'steps' | 'phases' | 'types';
const inputClass = 'w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent disabled:opacity-50';

export default function AdminWorkflowSettingsPage() {
  const router = useRouter();
  const { currentUser, isLoading: contextLoading } = useUser();
  const isAdmin = currentUser?.role === 'ADMIN';
  const [tab, setTab] = useState<Tab>('steps');
  const [phases, setPhases] = useState<WorkflowPhase[]>([]);
  const [types, setTypes] = useState<WorkflowType[]>([]);
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [steps, setSteps] = useState<WorkflowTemplateStep[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [phaseRows, typeRows, defaultTemplate] = await Promise.all([
        dbAdapter.getWorkflowPhases(true),
        dbAdapter.getWorkflowTypes(true),
        dbAdapter.getDefaultWorkflowTemplate(),
      ]);
      setPhases(phaseRows as WorkflowPhase[]);
      setTypes(typeRows as WorkflowType[]);
      setTemplate(defaultTemplate as WorkflowTemplate | null);
      setSteps(defaultTemplate
        ? await dbAdapter.getWorkflowTemplateSteps(defaultTemplate.id, true) as WorkflowTemplateStep[]
        : []);
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '無法載入專案流程設定'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (contextLoading) return;
    if (!isAdmin) {
      router.replace('/');
      return;
    }
    void load();
  }, [contextLoading, isAdmin, load, router]);

  const runSave = async (id: string, operation: () => Promise<unknown>, message: string) => {
    setSavingId(id);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setNotice(message);
      await load();
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '儲存專案流程設定失敗'));
    } finally {
      setSavingId(null);
    }
  };

  if (contextLoading || !isAdmin) return <div className="p-8 text-center text-secondary">驗證權限中...</div>;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header className="rounded-xl border border-theme-border bg-card p-6 shadow-sm">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-primary"><ListChecks className="text-accent" />專案流程設定</h1>
        <p className="mt-2 text-sm text-secondary">管理未來案場使用的 NORTH_DEFAULT 範本。修改不會回寫既有案場快照。</p>
      </header>

      <nav className="flex gap-1 rounded-xl border border-theme-border bg-card/60 p-1">
        {([
          ['steps', '流程項目', ListChecks],
          ['phases', 'Phase', Layers3],
          ['types', 'Type', Shapes],
        ] as const).map(([key, label, Icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${tab === key ? 'bg-accent text-white' : 'text-secondary hover:bg-page hover:text-primary'}`}><Icon size={16} />{label}</button>
        ))}
      </nav>

      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>}
      {notice && <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">{notice}</div>}

      {isLoading ? <div className="rounded-xl border border-theme-border bg-card p-10 text-center text-secondary">載入中...</div> : (
        <>
          {tab === 'phases' && <ClassificationManager kind="phase" items={phases} savingId={savingId} onItemsChange={setPhases} onSave={runSave} />}
          {tab === 'types' && <ClassificationManager kind="type" items={types} savingId={savingId} onItemsChange={setTypes} onSave={runSave} />}
          {tab === 'steps' && <TemplateStepManager template={template} phases={phases} types={types} steps={steps} savingId={savingId} onStepsChange={setSteps} onSave={runSave} />}
        </>
      )}
    </div>
  );
}

function ClassificationManager({ kind, items, savingId, onItemsChange, onSave }: {
  kind: 'phase' | 'type';
  items: (WorkflowPhase | WorkflowType)[];
  savingId: string | null;
  onItemsChange: (items: any[]) => void;
  onSave: (id: string, operation: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [newName, setNewName] = useState('');
  const title = kind === 'phase' ? 'Phase' : 'Type';
  const ordered = useMemo(() => [...items].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)), [items]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const sortOrder = items.reduce((max, item) => Math.max(max, item.sort_order), 0) + 10;
    await onSave('new', () => kind === 'phase'
      ? dbAdapter.createWorkflowPhase({ name, sort_order: sortOrder })
      : dbAdapter.createWorkflowType({ name, sort_order: sortOrder }), `已新增 ${title}。`);
    setNewName('');
  };

  const updateLocal = (id: string, updates: Record<string, unknown>) => {
    onItemsChange(items.map(item => item.id === id ? { ...item, ...updates } : item));
  };

  return (
    <section className="rounded-xl border border-theme-border bg-card/40 p-5">
      <form onSubmit={create} className="mb-5 flex gap-3"><input value={newName} onChange={event => setNewName(event.target.value)} placeholder={`新增 ${title} 名稱`} className={inputClass} /><button type="submit" disabled={!newName.trim() || savingId !== null} className="flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"><Plus size={16} />新增</button></form>
      <div className="space-y-2">
        {ordered.map(item => (
          <div key={item.id} className={`grid grid-cols-[minmax(12rem,1fr)_7rem_6rem_auto] items-end gap-3 rounded-xl border border-theme-border p-3 ${item.is_active ? 'bg-page/35' : 'bg-page/20 opacity-60'}`}>
            <label className="text-xs text-secondary">名稱<input value={item.name} onChange={event => updateLocal(item.id, { name: event.target.value })} className={`${inputClass} mt-1`} /></label>
            <label className="text-xs text-secondary">排序<input type="number" min={0} value={item.sort_order} onChange={event => updateLocal(item.id, { sort_order: Number(event.target.value) })} className={`${inputClass} mt-1`} /></label>
            <label className="flex h-10 items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={item.is_active} onChange={event => updateLocal(item.id, { is_active: event.target.checked })} className="h-4 w-4 accent-accent" />啟用</label>
            <button type="button" disabled={savingId !== null || !item.name.trim()} onClick={() => void onSave(item.id, () => kind === 'phase'
              ? dbAdapter.updateWorkflowPhase(item.id, { name: item.name.trim(), sort_order: item.sort_order, is_active: item.is_active })
              : dbAdapter.updateWorkflowType(item.id, { name: item.name.trim(), sort_order: item.sort_order, is_active: item.is_active }), `${title} 已儲存。`)} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-primary hover:bg-card disabled:opacity-50">{savingId === item.id ? '儲存中...' : '儲存'}</button>
            <div className="col-span-4 text-[11px] text-secondary">technical key：{'phase_key' in item ? item.phase_key : item.type_key}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TemplateStepManager({ template, phases, types, steps, savingId, onStepsChange, onSave }: {
  template: WorkflowTemplate | null;
  phases: WorkflowPhase[];
  types: WorkflowType[];
  steps: WorkflowTemplateStep[];
  savingId: string | null;
  onStepsChange: (steps: WorkflowTemplateStep[]) => void;
  onSave: (id: string, operation: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const activePhases = useMemo(() => phases.filter(item => item.is_active), [phases]);
  const activeTypes = useMemo(() => types.filter(item => item.is_active), [types]);
  const [newStep, setNewStep] = useState({ label: '', phase_id: '', type_id: '', default_is_applicable: true });
  const ordered = useMemo(() => [...steps].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)), [steps]);

  useEffect(() => {
    setNewStep(current => ({
      ...current,
      phase_id: current.phase_id || activePhases[0]?.id || '',
      type_id: current.type_id || activeTypes[0]?.id || '',
    }));
  }, [activePhases, activeTypes]);

  if (!template) return <div className="rounded-xl border border-danger/30 bg-danger/10 p-6 text-danger">找不到 NORTH_DEFAULT 流程範本。</div>;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!newStep.label.trim() || !newStep.phase_id || !newStep.type_id) return;
    const sortOrder = steps.reduce((max, item) => Math.max(max, item.sort_order), 0) + 10;
    await onSave('new', () => dbAdapter.createWorkflowTemplateStep({
      template_id: template.id,
      label: newStep.label.trim(),
      phase_id: newStep.phase_id,
      type_id: newStep.type_id,
      sort_order: sortOrder,
      default_is_applicable: newStep.default_is_applicable,
    }), '流程項目已新增。');
    setNewStep(current => ({ ...current, label: '', default_is_applicable: true }));
  };
  const updateLocal = (id: string, updates: Partial<WorkflowTemplateStep>) => onStepsChange(steps.map(step => step.id === id ? { ...step, ...updates } : step));

  return (
    <section className="rounded-xl border border-theme-border bg-card/40 p-5">
      <div className="mb-4 text-sm text-secondary">目前範本：<strong className="text-primary">{template.name}</strong>（{template.template_key}）</div>
      <form onSubmit={create} className="mb-5 grid grid-cols-[minmax(12rem,1fr)_10rem_10rem_7rem_auto] items-end gap-3 rounded-xl border border-theme-border bg-page/30 p-4">
        <label className="text-xs text-secondary">項目名稱<input value={newStep.label} onChange={event => setNewStep({ ...newStep, label: event.target.value })} className={`${inputClass} mt-1`} /></label>
        <Select label="Phase" value={newStep.phase_id} onChange={value => setNewStep({ ...newStep, phase_id: value })} items={activePhases} />
        <Select label="Type" value={newStep.type_id} onChange={value => setNewStep({ ...newStep, type_id: value })} items={activeTypes} />
        <label className="flex h-10 items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={newStep.default_is_applicable} onChange={event => setNewStep({ ...newStep, default_is_applicable: event.target.checked })} className="h-4 w-4 accent-accent" />預設適用</label>
        <button type="submit" disabled={savingId !== null || !newStep.label.trim() || !newStep.phase_id || !newStep.type_id} className="flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"><Plus size={16} />新增</button>
      </form>

      <div className="space-y-2">
        {ordered.map(step => (
          <div key={step.id} className={`rounded-xl border border-theme-border p-3 ${step.is_active ? 'bg-page/35' : 'bg-page/20 opacity-60'}`}>
            <div className="grid grid-cols-[minmax(12rem,1fr)_10rem_10rem_6rem_7rem_5rem_auto] items-end gap-3">
              <label className="text-xs text-secondary">名稱<input value={step.label} onChange={event => updateLocal(step.id, { label: event.target.value })} className={`${inputClass} mt-1`} /></label>
              <Select label="Phase" value={step.phase_id} onChange={value => updateLocal(step.id, { phase_id: value })} items={phases} />
              <Select label="Type" value={step.type_id} onChange={value => updateLocal(step.id, { type_id: value })} items={types} />
              <label className="text-xs text-secondary">排序<input type="number" min={0} value={step.sort_order} onChange={event => updateLocal(step.id, { sort_order: Number(event.target.value) })} className={`${inputClass} mt-1`} /></label>
              <label className="flex h-10 items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={step.default_is_applicable} onChange={event => updateLocal(step.id, { default_is_applicable: event.target.checked })} className="h-4 w-4 accent-accent" />預設適用</label>
              <label className="flex h-10 items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={step.is_active} onChange={event => updateLocal(step.id, { is_active: event.target.checked })} className="h-4 w-4 accent-accent" />啟用</label>
              <button type="button" disabled={savingId !== null || !step.label.trim()} onClick={() => void onSave(step.id, () => dbAdapter.updateWorkflowTemplateStep(step.id, {
                label: step.label.trim(), phase_id: step.phase_id, type_id: step.type_id, sort_order: step.sort_order, default_is_applicable: step.default_is_applicable, is_active: step.is_active,
              }), '流程項目已儲存。')} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-primary hover:bg-card disabled:opacity-50">{savingId === step.id ? '儲存中...' : '儲存'}</button>
            </div>
            <div className="mt-2 text-[11px] text-secondary">technical key：{step.step_key}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Select<T extends { id: string; name: string; is_active: boolean }>({ label, value, onChange, items }: { label: string; value: string; onChange: (value: string) => void; items: T[] }) {
  return <label className="text-xs text-secondary">{label}<select value={value} onChange={event => onChange(event.target.value)} className={`${inputClass} mt-1`}>{items.map(item => <option key={item.id} value={item.id}>{item.name}{item.is_active ? '' : '（停用）'}</option>)}</select></label>;
}
