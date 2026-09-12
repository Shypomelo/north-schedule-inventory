'use client';
import {useEffect,useState} from 'react';
import type {User} from '@/lib/db/types';
import type {DashboardView,MemberDashboardView} from '@/lib/dashboard-perspectives';
import {perspectiveAdapter} from '@/lib/db/perspective-adapter';
import {useDashboardView} from './DashboardViewContext';
export function DashboardViewAssignments({members}:{members:User[]}) {
 const [views,setViews]=useState<DashboardView[]>([]),[rows,setRows]=useState<MemberDashboardView[]>([]),[error,setError]=useState('');
 const load=async()=>{try{const [v,r]=await Promise.all([perspectiveAdapter.getDashboardViews(),perspectiveAdapter.getMemberDashboardViews()]);setViews(v.filter(x=>x.is_active));setRows(r);setError('');}catch{setError('無法載入視角設定，請確認 candidate migration。');}};
 useEffect(()=>{void load();},[]);
 return <section className="space-y-3 rounded border border-theme-border p-4"><h2 className="font-bold">可用工作視角／預設視角</h2><p className="text-sm text-secondary">與權限、職位及排程工作群組分開設定。ADMIN 永遠可用全部啟用視角。</p>{error&&<p role="alert">{error}</p>}{views.length>0&&members.filter(m=>m.is_active).map(member=><Editor key={member.id+JSON.stringify(rows.filter(r=>r.member_id===member.id))} member={member} views={views} rows={rows.filter(r=>r.member_id===member.id)} onSaved={load}/>)}</section>;
}
function Editor({member,views,rows,onSaved}:{member:User;views:DashboardView[];rows:MemberDashboardView[];onSaved:()=>Promise<void>}) {
 const [ids,setIds]=useState(rows.map(r=>r.dashboard_view_id)),[defaultId,setDefaultId]=useState(rows.find(r=>r.is_default)?.dashboard_view_id||''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const {reload}=useDashboardView();
 async function save(){setSaving(true);setError('');try{const assigned=member.role==='ADMIN'&&defaultId?Array.from(new Set([...ids,defaultId])):ids;await perspectiveAdapter.setMemberDashboardViews(member.id,assigned,defaultId||null);await onSaved();reload();}catch{setError('儲存失敗，原設定未變更。');}finally{setSaving(false);}}
 return <fieldset disabled={saving} className="min-w-0 rounded border border-theme-border p-3"><legend>{member.name}</legend><div className="flex flex-wrap gap-3">{views.map(view=><label key={view.id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={ids.includes(view.id)} onChange={e=>{setIds(e.target.checked?[...ids,view.id]:ids.filter(id=>id!==view.id));if(!e.target.checked&&defaultId===view.id&&member.role!=='ADMIN')setDefaultId('');}}/>{view.name}</label>)}</div><label>預設視角 <select className="min-h-11 max-w-full bg-theme-card" value={defaultId} onChange={e=>setDefaultId(e.target.value)}><option value="">相容預設</option>{views.filter(v=>member.role==='ADMIN'||ids.includes(v.id)).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><button type="button" className="ml-2 min-h-11 rounded border px-3" onClick={()=>void save()}>儲存視角</button>{error&&<p role="alert">{error}</p>}</fieldset>;
}
