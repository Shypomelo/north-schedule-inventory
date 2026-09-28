'use client';
import { useCallback, useEffect, useState } from 'react';
import { dbAdapter } from '@/lib/db';
import { supabase } from '@/lib/db/supabaseClient';
import type { MaterialReceipt, Project, ProjectMaterial, SESupplyRecord } from '@/lib/db/types';
import { createReceivingApi, ReceivingSourceDetails } from '@/lib/db/receiving-routing';
import { receiptRouteSummary } from '@/lib/receiving-allocation';
import { formatTaipeiReceivingTime, PendingReceivingItem } from '@/lib/material-receiving';
import { ReceivingDetailDialog, useRequest } from './ReceivingInventoryRouting';
import { ReceiptDateTimeInput } from './ReceiptDateTimeInput';
import { ReceivingProjectCombobox } from './ReceivingProjectCombobox';

const api = createReceivingApi(supabase);
const button = 'min-h-10 rounded-lg border border-theme-border px-3 py-2 text-sm disabled:opacity-40';
const field = 'min-h-10 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm';
const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失敗，請重新載入';

export function ReceivingSourceRow({ item, expanded, canEdit, projects, onToggle, onChanged, onHistory }: {
 item: PendingReceivingItem; expanded: boolean; canEdit: boolean; projects: Project[]; onToggle: () => void;
 onChanged: () => void | Promise<void>; onHistory: () => void;
}) {
 const [data, setData] = useState<ReceivingSourceDetails | null>(null);
 const [error, setError] = useState('');
 const [action, setAction] = useState<'cancel' | 'hide' | null>(null);
 const [reason, setReason] = useState('');
 const [busy, setBusy] = useState(false);
 const request = useRequest();
 const refresh = useCallback(async () => { setData(await api.sourceDetails(item.sourceType, item.sourceId)); }, [item.sourceType, item.sourceId]);
 useEffect(() => { let active = true; api.sourceDetails(item.sourceType, item.sourceId).then(value => { if (active) setData(value); }).catch(e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [item.sourceType, item.sourceId, item.receivedQuantity]);
 const changed = async () => { await refresh(); await onChanged(); };
 const receipts = data?.receipts.filter(r => r.event_type !== 'REVERSAL' && r.receipt_location !== 'SITE') || [];
 const summaries = data ? receipts.filter(r => r.inventory_linked).map(r => receiptRouteSummary(r, data)) : [];
 const latest = receipts[0];
 async function cancel() {
  if (busy || !reason.trim()) return;
  setBusy(true); setError('');
  try { await api.cancelArrival(request({ p_source_type: item.sourceType, p_source_id: item.sourceId, p_notes: reason.trim(), p_hide_only: action === 'hide' })); await onChanged(); }
  catch (e) { setError(errorText(e)); } finally { setBusy(false); }
 }
 return <article className="rounded-xl border border-theme-border bg-card" data-receiving-source={item.sourceId}>
  <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left">
   <span><strong className="block text-sm">{item.itemLabel}</strong><span className="text-xs text-secondary">{item.contextLabel} · {item.status === 'RECEIVED' ? '已收到' : item.status === 'PARTIAL_RECEIVED' ? '未全' : '待收'}</span></span>
   <span className="text-sm">需求 {item.quantity}｜已收 {item.receivedQuantity}｜待收 {item.remainingQuantity}<span className="block text-xs text-secondary">{data?.inventoryItem?.requires_serial ? `序號 ${data.entries.filter(e => !e.retired_at).length} / ${item.quantity} · ` : ''}{item.status === 'RECEIVED' && latest ? `${formatTaipeiReceivingTime(latest.received_at)} 北辦收到` : item.expectedDeliveryAt ? `預計 ${formatTaipeiReceivingTime(item.expectedDeliveryAt)}` : '未排到貨時間'} · {expanded ? '收合' : '展開'}</span></span>
  </button>
  {summaries.length > 0 && <p className="px-3 pb-2 text-xs text-secondary">後續用途：庫存 {summaries.reduce((n,s) => n+s.stock,0)}｜SE預留／使用 {summaries.reduce((n,s) => n+s.se,0)}｜案場 {summaries.reduce((n,s) => n+s.site,0)}{summaries.some(s => s.other) ? `｜既有其他用途 ${summaries.reduce((n,s) => n+s.other,0)}` : ''}</p>}
  {expanded && <div className="space-y-3 border-t border-theme-border p-3">
   {canEdit && item.remainingQuantity > 0 && <ExpectedArrival item={item} onChanged={onChanged} />}
   {canEdit && item.remainingQuantity > 0 && <ReceivingDetailDialog inline key={item.sourceId + ':' + item.receivedQuantity} item={item} onClose={onToggle} onChanged={changed} />}
   {data && receipts.map(receipt => <ReceiptRoutes key={receipt.id} receipt={receipt} item={item} data={data} projects={projects} canEdit={canEdit} onChanged={changed} />)}
   {!receipts.length && item.receivedQuantity > 0 && <p className="text-sm text-warning">舊收貨沒有 receipt 關聯，需先確認歷史。</p>}
   <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={onHistory}>收貨歷程</button>
    {canEdit && <button type="button" className={button} onClick={() => { setAction('cancel'); setReason(''); }}>{item.receivedQuantity > 0 ? '撤銷收貨' : '取消待收'}</button>}
   </div>
   {canEdit && <details className="text-xs text-secondary"><summary className="cursor-pointer py-2">管理操作</summary><button type="button" className={button} onClick={() => { setAction('hide'); setReason(''); }}>從列表隱藏</button><p className="mt-1">只隱藏列表，庫存與收貨紀錄不變。</p></details>}
   {action && <form className="space-y-2 rounded-lg border border-warning/40 p-3" onSubmit={e => { e.preventDefault(); void cancel(); }}>
    <p className="text-sm">{action === 'hide' ? '從列表隱藏：不撤銷庫存。' : item.receivedQuantity > 0 ? '撤銷所有有效北辦收貨並同步更正庫存；已預留、出庫或關帳時會拒絕。' : '取消待收並退役預登序號，不影響庫存。'}</p>
    <label className="block text-sm">原因<input required value={reason} onChange={e => setReason(e.target.value)} className={field} /></label>
    <button disabled={busy || !reason.trim()} className={button}>{busy ? '處理中…' : action === 'hide' ? '確認隱藏' : '確認取消這筆到貨'}</button><button type="button" disabled={busy} className={button + ' ml-2'} onClick={() => setAction(null)}>返回</button>
   </form>}
  </div>}
  {error && <p role="alert" className="p-3 text-sm text-danger">{error}</p>}
 </article>;
}

function ReceiptRoutes({ receipt, item, data, projects, canEdit, onChanged }: { receipt: MaterialReceipt; item: PendingReceivingItem; data: ReceivingSourceDetails; projects: Project[]; canEdit: boolean; onChanged: () => void | Promise<void> }) {
 const summary = receiptRouteSummary(receipt, data);
 const inventoryItem = data.inventoryItem;
 const [mode, setMode] = useState<'SE' | 'SITE' | null>(null);
 const [selected, setSelected] = useState<string[]>([]);
 const [quantity, setQuantity] = useState('1');
 const [projectId, setProjectId] = useState('');
 const [materialId, setMaterialId] = useState('');
 const [materials, setMaterials] = useState<ProjectMaterial[]>([]);
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const [at, setAt] = useState(() => new Date().toISOString());
 const request = useRequest();
 useEffect(() => { let active=true; setMaterials([]); setMaterialId(''); if(projectId) dbAdapter.listProjectMaterials(projectId).then(rows=>{if(active)setMaterials(rows);}).catch(e=>{if(active)setError(errorText(e));}); return ()=>{active=false;}; },[projectId]);
 const candidates=materials.filter(m=>m.delivery_destination==='SITE' && m.procurement_status!=='RECEIVED' && m.unit===item.unit && (m.inventory_item_id===inventoryItem?.id || (!m.inventory_item_id && [inventoryItem?.code,inventoryItem?.name].includes(m.item_name))));
 const projectName=(id: string | null | undefined)=>projects.find(p=>p.id===id)?.name || '未指定案件';
 async function route() {
  if(busy) return; setBusy(true);setError('');
  try { await api.routeReceipt(request({p_receipt_id:receipt.id,p_route_type:mode,p_quantity:summary.serialized?selected.length:Number(quantity),p_serial_ids:summary.serialized?selected:[],p_project_id:projectId||null,p_material_id:materialId==='NEW'?null:materialId||null,p_create_new:materialId==='NEW',p_received_at:at,p_notes:null})); setMode(null);setSelected([]);await onChanged(); }
  catch(e){setError(errorText(e));}finally{setBusy(false);}
 }
 if(!receipt.inventory_linked) return <p className="text-xs text-warning">{formatTaipeiReceivingTime(receipt.received_at)} 舊收貨 · 庫存關聯待確認</p>;
 return <details className="rounded-lg border border-theme-border p-3">
  <summary className="cursor-pointer text-sm font-semibold">{formatTaipeiReceivingTime(receipt.received_at)} 北辦收到 {receipt.quantity_received} {item.unit} · 後續用途</summary>
  <div className="mt-3 space-y-3">
   <p className="text-sm">本批有效 {summary.quantity} · 留庫存 {summary.stock} · SE預留／使用 {summary.se} · 案場 {summary.site}{summary.reversed>0?` · 已更正 ${summary.reversed}`:''}</p>
   <p className="break-all text-xs text-secondary">Inventory 關聯：{receipt.inventory_transaction_id || '既有在庫序號認領（沒有重複入庫）'}</p>
   {summary.serials.map(serial=>{
    const allocation=summary.allocations.find(a=>a.inventory_serial_id===serial.id);
    const se=data.seRecords.find(s=>s.inventory_serial_id===serial.id && !s.cancelled_at && !s.receiving_only);
    const material=data.materials.find(m=>m.id===allocation?.project_material_id);
    return <div key={serial.id} className="space-y-1 border-t border-theme-border py-2 text-sm"><p className="break-all">{serial.serial_number} · {allocation?.route_type==='SITE'?`已送 ${projectName(material?.project_id)}`:se?`${se.replace_date?'已維修使用':'SE預留'}：${projectName(se.project_id)}`:serial.status==='在庫'?'留庫存':`${serial.status}（既有庫存歷程）`}</p>
     {allocation && <p className="text-xs text-secondary">{formatTaipeiReceivingTime(allocation.created_at)} {allocation.route_type==='SITE'?'送達案場':'SE 預留'}</p>}
     {se?.replace_date && <p className="text-xs text-secondary">{se.replace_date} 現場完成更換；修改請走設備更正。</p>}
     {se && allocation?.route_type==='SE' && !se.replace_date && canEdit && <SEActions record={se} projects={projects} onChanged={onChanged} />}
     {allocation?.route_type==='SITE' && <button className={button} disabled title="送達更正需同步 SITE reversal 與 OUT correction，本輪暫不提供">更正送達（待支援）</button>}
    </div>;
   })}
   {!summary.serialized && summary.allocations.map(a=><p key={a.id} className="text-sm">{a.quantity} / {receipt.quantity_received} → {projectName(data.materials.find(m=>m.id===a.project_material_id)?.project_id)} · {formatTaipeiReceivingTime(a.created_at)} <button className={button} disabled>更正送達（待支援）</button></p>)}
   {data.allocations.filter(a=>a.office_receipt_id===receipt.id&&a.cancelled_at).map(a=><p key={a.id} className="text-xs text-secondary">{formatTaipeiReceivingTime(a.created_at)} SE預留 → {formatTaipeiReceivingTime(a.cancelled_at!)} 已取消，回留庫存</p>)}
   {canEdit && summary.stock>0 && <div className="flex flex-wrap gap-2">{inventoryItem?.requires_serial && inventoryItem.is_se_maintenance_equipment && <button className={button} onClick={()=>{setMode('SE');setSelected([]);setAt(new Date().toISOString());}}>加入 SE 供貨</button>}<button className={button} onClick={()=>{setMode('SITE');setSelected([]);setAt(new Date().toISOString());}}>送至案場</button></div>}
   {mode && <form className="space-y-3" onSubmit={e=>{e.preventDefault();void route();}}><fieldset disabled={busy} className="space-y-3">
    <ReceivingProjectCombobox projects={projects} value={projectId} onChange={setProjectId} />
    {summary.serialized?<fieldset><legend className="text-sm">只選這筆收貨的在庫序號 · 已選 {selected.length}</legend>{summary.availableSerials.map(s=><label key={s.id} className="flex min-h-10 gap-2 items-center text-sm"><input type="checkbox" checked={selected.includes(s.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,s.id]:ids.filter(id=>id!==s.id))}/>{s.serial_number}</label>)}</fieldset>:<label className="block text-sm">本批可分配 {summary.stock} · 本次數量<input className={field} required type="number" min="0.001" step="any" max={summary.stock} value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>}
    {mode==='SITE'&&<><label className="block text-sm">案場物料需求<select required className={field} value={materialId} onChange={e=>setMaterialId(e.target.value)}><option value="">請選擇</option>{candidates.map(m=><option key={m.id} value={m.id}>{m.item_name} · {m.quantity} {m.unit}</option>)}<option value="NEW">建立新的案場物料</option></select></label><p className="text-xs text-secondary">確認表示已實際離開北辦並送達案場，會出庫並留下案場收料紀錄。</p></>}
    <button className={button+' bg-accent text-white'} disabled={busy || (summary.serialized&&!selected.length) || (mode==='SITE'&&(!projectId||!materialId))}>{mode==='SE'?'確認預留':'確認已送達'}</button><button type="button" className={button+' ml-2'} onClick={()=>setMode(null)}>取消</button>
   </fieldset></form>}
   {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
  </div>
 </details>;
}
function SEActions({record,projects,onChanged}:{record:SESupplyRecord;projects:Project[];onChanged:()=>void|Promise<void>}){
 const [editing,setEditing]=useState(false);const [project,setProject]=useState(record.project_id||'');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 async function run(cancel:boolean){if(busy)return;setBusy(true);setError('');try{if(cancel)await api.cancelReservation(record);else await api.changeSEProject(record,project||null);setEditing(false);await onChanged();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 return <div className="space-y-2"><div className="flex gap-2"><button disabled={busy} className={button} onClick={()=>setEditing(!editing)}>修改 SE 案件</button><button disabled={busy} className={button} onClick={()=>void run(true)}>取消預留，回留庫存</button></div>{editing&&<div><ReceivingProjectCombobox projects={projects} value={project} onChange={setProject}/><button disabled={busy} className={button} onClick={()=>void run(false)}>儲存案件</button></div>}{error&&<p role="alert" className="text-danger text-sm">{error}</p>}</div>;
}

function ExpectedArrival({item,onChanged}:{item:PendingReceivingItem;onChanged:()=>void|Promise<void>}) {
 const [editing,setEditing]=useState(false);const [expectedAt,setExpectedAt]=useState(item.expectedDeliveryAt);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 async function save(){if(!expectedAt||busy)return;setBusy(true);setError('');try{
  if(item.sourceType==='PROJECT_MATERIAL') {
   if(item.batchSameDayDelivery&&item.batchId) await dbAdapter.updateMaterialReceiptPlan(item.batchId,expectedAt);
   else await dbAdapter.updateMaterialReceiptOverride(item.sourceId,expectedAt);
  } else await dbAdapter.updateSESupplyRecord(item.sourceId,{expected_delivery_at:expectedAt});
  setEditing(false);await onChanged();
 }catch(e){setError(errorText(e));}finally{setBusy(false);}}
 return <div><button type="button" className={button} onClick={()=>setEditing(!editing)}>修改預計到貨</button>{editing&&<div className="mt-2 flex flex-wrap gap-2"><ReceiptDateTimeInput required label="預計到貨" value={expectedAt} onChange={setExpectedAt}/><button disabled={busy||!expectedAt} type="button" className={button} onClick={()=>void save()}>儲存預計</button></div>}{error&&<p role="alert" className="text-danger text-sm">{error}</p>}</div>;
}
