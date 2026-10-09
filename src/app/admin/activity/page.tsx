'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/components/UserContext';
import { useSystemOwner } from '@/components/useSystemOwner';
import { supabase } from '@/lib/db/supabaseClient';

type ActivityRow = {
  id: string; created_at: string; action: string | null; action_type: string | null;
  target_type: string | null; target_id: string | null; actor_name: string | null;
  message: string | null; description: string | null;
};

export default function SystemActivityPage() {
  const { currentUser } = useUser();
  const isOwner = useSystemOwner();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true); setError('');
    const { data, error: readError } = await supabase.rpc('read_activity_logs', {
      p_kind: 'ALL', p_target_id: null, p_limit: 500,
    });
    if (readError) setError(readError.message);
    else setRows((data || []) as ActivityRow[]);
    setLoading(false);
  }, [isOwner]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => rows.filter(row =>
    [row.actor_name,row.action_type,row.action,row.target_type,row.target_id,row.message,row.description]
      .join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [rows,query]);

  if (!currentUser || !isOwner) return <main className="p-6 text-secondary">僅系統擁有者可查看操作流水。</main>;
  return <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold text-primary">操作流水</h1><button type="button" onClick={() => void load()} className="rounded border border-theme-border px-3 py-2 text-sm text-primary">重新整理</button></div>
    <input type="search" aria-label="搜尋操作流水" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜尋操作者、動作、對象" className="w-full rounded border border-theme-border bg-page px-3 py-2 text-primary" />
    <p className="text-xs text-secondary">顯示最近 500 筆紀錄；詳細排程與庫存歷程仍可在原功能查看。</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {loading ? <p className="text-secondary">載入中…</p> : <div className="overflow-x-auto rounded border border-theme-border"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-card text-secondary"><tr><th className="p-3">時間</th><th className="p-3">操作者</th><th className="p-3">動作</th><th className="p-3">對象</th><th className="p-3">內容</th></tr></thead><tbody>{visible.map(row => <tr key={row.id} className="border-t border-theme-border/60"><td className="whitespace-nowrap p-3">{new Date(row.created_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}</td><td className="p-3">{row.actor_name || '系統'}</td><td className="p-3">{row.action_type || row.action}</td><td className="p-3">{row.target_type} · {row.target_id}</td><td className="break-words p-3">{row.message || row.description || '—'}</td></tr>)}{visible.length===0&&<tr><td colSpan={5} className="p-6 text-center text-secondary">沒有符合的紀錄</td></tr>}</tbody></table></div>}
  </main>;
}
