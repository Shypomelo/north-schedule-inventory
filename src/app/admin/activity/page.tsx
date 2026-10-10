'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@/components/UserContext';
import { useSystemOwner } from '@/components/useSystemOwner';
import { supabase } from '@/lib/db/supabaseClient';
import { actionLabel, activityDifferences, activitySummary, targetTypeLabel } from '@/lib/activity-presentation';
import { loadActivityTargetData, resolveBusinessTarget, type BusinessTarget } from '@/lib/activity-targets';

type Tab = 'schedule' | 'inventory' | 'project' | 'receiving' | 'other';
type Row = {
  id: string; created_at: string; action: string; action_type: string | null;
  target_type: string; target_id: string; target_label: string | null;
  actor_name: string | null; user_name: string | null; project_id: string | null; project_name: string | null;
  before_value: string | null; after_value: string | null;
  message: string | null; description: string | null; changes: unknown;
};
const PAGE_SIZE = 50;
const TABS: { key: Tab; label: string }[] = [
  { key: 'schedule', label: '排程' }, { key: 'inventory', label: '庫存' },
  { key: 'project', label: '案場' }, { key: 'receiving', label: '物料／收貨' },
  { key: 'other', label: '其他' },
];
// Exact action values from the existing INVENTORY_TRANSACTION audit records.
const RECEIVING_ACTIONS = [
  'ARRIVAL_CREATED', 'ARRIVAL_FIRST_POST', 'ARRIVAL_MATCH', 'ARRIVAL_METADATA',
  'ARRIVAL_ROUTE_POST', 'ARRIVAL_STAGED', 'DELETE_RECEIVING_PENDING',
  'RECEIVING_INVENTORY', 'RESERVE_INVENTORY_FOR_SE', 'ROUTE_RECEIVING',
];
const RECEIVING_FILTER = `(${RECEIVING_ACTIONS.join(',')})`;
const KNOWN_TARGETS = '(ScheduleTask,PROJECT_MILESTONE,PROJECT_WORKFLOW,INVENTORY_TRANSACTION)';
const dayStart = (date: string) => new Date(`${date}T00:00:00+08:00`).toISOString();
const nextDayStart = (date: string) => new Date(new Date(dayStart(date)).getTime() + 86400000).toISOString();

export default function SystemActivityPage() {
  const { currentUser } = useUser();
  const isOwner = useSystemOwner();
  const [tab, setTab] = useState<Tab>('schedule');
  const [rows, setRows] = useState<Row[]>([]);
  const [targets, setTargets] = useState<Record<string, BusinessTarget>>({});
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [rowsKey, setRowsKey] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const generation = useRef(0);
  const queryKey = `${tab}|${fromDate}|${toDate}|${search}|${refresh}`;

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (append: boolean, currentRows: Row[], requestGeneration: number) => {
    if (!isOwner) return;
    setLoading(true);
    setError('');
    let request = supabase.from('activity_logs').select('*');
    if (tab === 'schedule') request = request.eq('target_type', 'ScheduleTask');
    if (tab === 'project') request = request.in('target_type', ['PROJECT_MILESTONE', 'PROJECT_WORKFLOW']);
    if (tab === 'receiving') request = request.eq('target_type', 'INVENTORY_TRANSACTION').in('action', RECEIVING_ACTIONS);
    if (tab === 'inventory') request = request.eq('target_type', 'INVENTORY_TRANSACTION').not('action', 'in', RECEIVING_FILTER);
    if (tab === 'other') request = request.not('target_type', 'in', KNOWN_TARGETS);
    if (fromDate) request = request.gte('created_at', dayStart(fromDate));
    if (toDate) request = request.lt('created_at', nextDayStart(toDate));
    if (search) {
      // Quote the value for PostgREST's raw .or() syntax and treat LIKE metacharacters literally.
      const pattern = JSON.stringify(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
      request = request.or(
        ['actor_name', 'user_name', 'action_type', 'action', 'target_type',
          'target_id', 'target_label', 'project_name', 'message', 'description']
          .map(column => `${column}.ilike.${pattern}`).join(','),
      );
    }
    if (append && currentRows.length) {
      const last = currentRows[currentRows.length - 1];
      request = request.or(`created_at.lt.${last.created_at},and(created_at.eq.${last.created_at},id.lt.${last.id})`);
    }
    const { data, error: readError } = await request
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (generation.current !== requestGeneration) return;
    if (readError) setError(readError.message);
    else {
      const page = (data || []) as Row[];
      const loaded = page.slice(0, PAGE_SIZE);
      const related = await loadActivityTargetData(loaded).catch(() => null);
      if (generation.current !== requestGeneration) return;
      const pageTargets = Object.fromEntries(loaded.map(row => [row.id, related
        ? resolveBusinessTarget(row, related)
        : { lines: ['無法辨識對象'], recognized: false }]));
      setRows(append ? [...currentRows, ...loaded] : loaded);
      setTargets(current => append ? { ...current, ...pageTargets } : pageTargets);
      setRowsKey(queryKey);
      setHasMore(page.length > PAGE_SIZE);
    }
    setLoading(false);
  }, [isOwner, tab, fromDate, toDate, search, queryKey]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setRows([]);
    setTargets({});
    setHasMore(false);
    setExpandedId(null);
    void load(false, [], requestGeneration);
    return () => { generation.current++; };
  }, [load, refresh]);

  const visible = rowsKey === queryKey && query.trim() === search ? rows : [];

  if (!currentUser || !isOwner) return <main className="p-6 text-secondary">僅系統擁有者可查看操作流水。</main>;
  return <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold text-primary">操作流水</h1>
      <button type="button" onClick={() => setRefresh(value => value + 1)} className="rounded border border-theme-border px-3 py-2 text-sm text-primary">重新整理</button>
    </div>
    <nav aria-label="異動流水功能分頁" className="flex gap-1 overflow-x-auto rounded-xl border border-theme-border bg-card/60 p-1">
      {TABS.map(item => <button key={item.key} type="button" aria-current={tab === item.key ? 'page' : undefined}
        onClick={() => setTab(item.key)}
        className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium ${tab === item.key ? 'bg-accent text-white' : 'text-secondary hover:bg-page hover:text-primary'}`}>{item.label}</button>)}
    </nav>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm text-secondary">開始日期<input type="date" value={fromDate} max={toDate || undefined} onChange={event => setFromDate(event.target.value)} className="mt-1 block rounded border border-theme-border bg-page px-3 py-2 text-primary" /></label>
      <label className="text-sm text-secondary">結束日期<input type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)} className="mt-1 block rounded border border-theme-border bg-page px-3 py-2 text-primary" /></label>
      <input type="search" aria-label="搜尋操作流水" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜尋操作者、動作、對象" className="min-w-60 flex-1 rounded border border-theme-border bg-page px-3 py-2 text-primary" />
    </div>
    <p className="text-xs text-secondary">每次載入最多 {PAGE_SIZE} 筆；詳細排程與庫存歷程仍可在原功能查看。</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="overflow-x-auto rounded border border-theme-border"><table className="w-full min-w-[920px] table-fixed text-left text-sm">
      <colgroup><col className="w-[170px]" /><col className="w-[130px]" /><col className="w-[180px]" /><col className="w-[240px]" /><col /></colgroup>
      <thead className="bg-card text-secondary"><tr><th className="p-3">時間</th><th className="p-3">操作者</th><th className="p-3">動作</th><th className="p-3">對象</th><th className="p-3">內容</th></tr></thead><tbody>
      {visible.map(row => {
        const target = targets[row.id] || { lines: ['無法辨識對象'], recognized: false };
        const isExpanded = expandedId === row.id;
        const differences = isExpanded ? activityDifferences(row) : [];
        return <Fragment key={row.id}>
          <tr className="border-t border-theme-border/60 align-top">
            <td className="whitespace-nowrap p-3">{new Date(row.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td>
            <td className="truncate whitespace-nowrap p-3" title={row.actor_name || row.user_name || '系統'}>{row.actor_name || row.user_name || '系統'}</td>
            <td className="truncate whitespace-nowrap p-3" title={row.action_type || row.action}>{actionLabel(row.action_type || row.action)}</td>
            <td className="p-3" title={target.lines.join('｜')}>
              {target.lines.map((line, index) => <div key={index} className={`truncate ${index === 0 ? 'font-medium' : 'text-xs text-secondary'}`}>{line}</div>)}
            </td>
            <td className="p-3"><div className="truncate" title={activitySummary(row)}>{activitySummary(row)}</div>
              <button type="button" aria-expanded={isExpanded} aria-controls={`activity-detail-${row.id}`}
                onClick={() => setExpandedId(isExpanded ? null : row.id)}
                className="mt-1 text-xs text-accent hover:underline">{isExpanded ? '收合詳細資訊' : '查看詳細資訊'}</button>
            </td>
          </tr>
          {isExpanded && <tr id={`activity-detail-${row.id}`} className="border-t border-theme-border/40 bg-card/50">
            <td colSpan={5} className="p-4"><div className="min-w-0 max-w-full space-y-3">
              <div className="text-xs text-secondary">{targetTypeLabel(row.target_type)} · 原始 ID：<span className="break-all">{row.target_id}</span></div>
              {differences.length ? <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {differences.map(change => <div key={change.field} className="min-w-0 border-b border-theme-border/40 pb-2">
                  <div className="font-medium text-primary">{change.label}</div>
                  <div className="break-words text-secondary">{change.before} → {change.after}</div>
                </div>)}
              </div> : <p className="text-secondary">此筆沒有可讀的欄位差異。</p>}
              <details><summary className="cursor-pointer text-xs text-accent">查看原始紀錄</summary>
                <pre className="mt-2 max-h-96 max-w-full overflow-auto rounded bg-page p-3 text-xs text-secondary">{JSON.stringify(row, null, 2)}</pre>
              </details>
            </div></td>
          </tr>}
        </Fragment>;
      })}
      {!loading && visible.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-secondary">沒有符合的紀錄</td></tr>}
    </tbody></table></div>
    {loading && <p className="text-secondary">載入中…</p>}
    {!loading && hasMore && rowsKey === queryKey && <button type="button" onClick={() => void load(true, rows, generation.current)} className="rounded border border-theme-border px-4 py-2 text-sm text-primary">載入更多</button>}
  </main>;
}
