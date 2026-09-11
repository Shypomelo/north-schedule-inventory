export interface WorkZone {id:string;owner_member_id:string;name:string;sort_order:number;is_active:boolean}
export interface WorkItem {id:string;owner_member_id:string;work_zone_id:string;project_id:string|null;title:string;content:string|null;source_todo_id:string|null;received_at:string;expected_start_date:string|null;due_date:string|null;status:'待處理'|'進行中'|'已完成';completed_at:string|null;created_at:string}
export function sortWorkItems(items:WorkItem[],today:string) {
 const bucket=(i:WorkItem)=>i.status==='已完成'?4:!i.due_date?3:i.due_date<today?0:i.due_date===today?1:2;
 return [...items].sort((a,b)=>bucket(a)-bucket(b)||(a.due_date||'9999').localeCompare(b.due_date||'9999')||a.received_at.localeCompare(b.received_at)||a.id.localeCompare(b.id));
}
export function workItemTimeline(item:WorkItem) {
 return [{label:'收到',date:item.received_at?.slice(0,10)},{label:'預計開始',date:item.expected_start_date},{label:'預計完成',date:item.due_date},{label:'實際完成',date:item.completed_at?.slice(0,10)}].filter(point=>point.date);
}
