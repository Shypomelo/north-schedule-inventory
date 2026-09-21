'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/db/supabaseClient';
import { equipmentSourceLabel, groupMaintenanceEquipmentRecords, type MaintenanceEquipmentRecord } from '@/lib/db/maintenance-usage';
import { MaintenanceEquipmentModal } from './MaintenanceEquipmentModal';
import { useUser } from './UserContext';

export function MaintenanceEquipmentRecords({ taskId, beforeAdd }: { taskId: string; beforeAdd?: () => boolean }) {
  const { currentUser } = useUser();
  const [rows, setRows] = useState<MaintenanceEquipmentRecord[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MaintenanceEquipmentRecord | undefined>();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setRows(null); setError('');
    void (async () => {
      const result = await supabase.from('maintenance_equipment_records').select('*')
        .eq('schedule_task_id', taskId).order('replaced_at', { ascending: false });
      if (!active) return;
      if (result.error) setError('設備維修紀錄載入失敗，請重新開啟。');
      else setRows(result.data as MaintenanceEquipmentRecord[]);
    })();
    return () => { active = false; };
  }, [taskId, revision]);
  const canEdit = !!currentUser && currentUser.role !== 'VIEWER';
  const groups = groupMaintenanceEquipmentRecords(rows || []);
  return <section className="mt-3 rounded-xl border border-[var(--border)] p-3 text-sm" aria-label="設備維修紀錄">
    <h3 className="font-bold">設備維修紀錄</h3>
    {error ? <p role="alert">{error}</p> : rows === null ? <p className="mt-2">載入中…</p> : rows.length === 0 ? <p className="mt-2 text-[var(--modal-muted)]">尚無設備維修紀錄</p> : <ul className="mt-2 divide-y divide-[var(--border)]">{groups.map(group => <li key={group.key} className="py-1">
      <button type="button" aria-expanded={expanded.includes(group.key)} onClick={() => setExpanded(current => current.includes(group.key) ? current.filter(key => key !== group.key) : [...current, group.key])} className="flex min-h-12 w-full items-center justify-between gap-2 py-1 text-left">
        <span className="min-w-0"><span className="block break-words font-semibold">{group.records[0].model_snapshot} ×{group.records.length}</span><span className="text-xs text-[var(--modal-muted)]">{new Date(group.records[0].replaced_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} · {equipmentSourceLabel[group.records[0].source_type]}</span></span>
        <span className="shrink-0 text-xs">{expanded.includes(group.key) ? '收合 ⌄' : '展開 ›'}</span>
      </button>
      {expanded.includes(group.key) && <ul className="border-t border-[var(--border)]">{group.records.map(row => <li key={row.id} className="flex items-start justify-between gap-2 py-1">
        <div className="min-w-0 py-2"><div className="break-all text-xs">{row.serial_snapshot}</div>{row.notes && <p className="whitespace-pre-wrap break-words text-xs text-[var(--modal-muted)]">{row.notes}</p>}</div>
        <button type="button" disabled={!canEdit} aria-label={`修改 ${row.serial_snapshot}`} onClick={() => { if (!beforeAdd || beforeAdd()) { setEditing(row); setOpen(true); } }} className="min-h-10 shrink-0 px-2 text-xs text-[var(--accent)] disabled:opacity-50">修改</button>
      </li>)}</ul>}
    </li>)}</ul>}
    <button type="button" disabled={!canEdit} onClick={() => { if (!beforeAdd || beforeAdd()) { setEditing(undefined); setOpen(true); } }} className="mt-2 min-h-10 rounded-lg border border-[var(--border)] px-3 disabled:opacity-50">＋新增設備維修</button>
    {open && <MaintenanceEquipmentModal key={editing?.id || 'new'} taskId={taskId} record={editing} onClose={() => setOpen(false)} onRegistered={() => setRevision(value => value + 1)} />}
  </section>;
}
