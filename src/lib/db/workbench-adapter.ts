import {supabase} from './supabaseClient';
import type {WorkItem,WorkZone} from '../workbench';
import type {ProjectMilestone} from './types';
export const workbenchAdapter={
 async getMilestones(projectIds:string[]):Promise<ProjectMilestone[]> {
  if(!projectIds.length)return [];
  const {data,error}=await supabase.from('project_milestones').select('*').in('project_id',projectIds).is('deleted_at',null);if(error)throw error;return data||[];
 },
 async getAssignedProjectIds(memberId:string):Promise<string[]> {
  const {data,error}=await supabase.from('project_position_assignments').select('project_id').eq('member_id',memberId);if(error)throw error;return Array.from(new Set((data||[]).map(row=>row.project_id as string)));
 },
 async getZones(ownerId:string):Promise<WorkZone[]> {const {data,error}=await supabase.from('work_zones').select('*').eq('owner_member_id',ownerId).eq('is_active',true).order('sort_order');if(error)throw error;return data||[];},
 async getItems(ownerId:string):Promise<WorkItem[]> {const {data,error}=await supabase.from('work_items').select('*').eq('owner_member_id',ownerId);if(error)throw error;return data||[];},
 async configure(zones:{id?:string;name:string}[],moveTo:string|null) {const {error}=await supabase.rpc('configure_my_work_zones',{p_zones:zones,p_move_to:moveTo});if(error)throw error;},
 async promote(todoId:string,zoneId:string,projectId:string|null,projectLabel:string|null,start:string|null,due:string|null) {const {error}=await supabase.rpc('promote_private_todo_to_work_item',{p_todo_id:todoId,p_work_zone_id:zoneId,p_project_id:projectId,p_project_label:projectLabel,p_expected_start_date:start,p_due_date:due});if(error)throw error;},
 async updateItem(item:WorkItem,fields:Pick<WorkItem,'title'|'content'|'project_id'|'project_label'|'received_at'|'expected_start_date'|'due_date'|'status'>) {
  const {data,error}=await supabase.from('work_items').update({...fields,completed_at:fields.status==='已完成'?(item.completed_at||new Date().toISOString()):null}).eq('id',item.id).eq('owner_member_id',item.owner_member_id).select('id').single();if(error||!data)throw error||new Error('Work item not updated');
 },
};
