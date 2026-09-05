import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConstructionWorkType, ProjectConstructionProgress } from './types';
import { validateConstructionWorkName } from '../construction-progress';
import type { ConstructionConflictRow } from '../construction-progress';
import { supabase } from './supabaseClient';

export type ConstructionUpdate = Partial<Pick<ProjectConstructionProgress,
  'contractor_id' | 'contractor_name' | 'planned_start_date' | 'planned_end_date'
  | 'is_completed' | 'actual_completed_date' | 'work_name' | 'notes' | 'status_override'>>;
export type ConstructionCreate = ConstructionUpdate & { work_type: ConstructionWorkType; sort_order: number };

// Both UI entrances use this row-ID contract; no flattened Project fields or milestone writes.
export function createConstructionProgressAdapter(client: SupabaseClient) {
  return {
    async conflicts(projectId: string): Promise<ConstructionConflictRow[]> {
      const { data, error } = await client.from('project_construction_progress')
        .select('project_id,contractor_id,planned_start_date,planned_end_date,projects!inner(project_name)')
        .neq('project_id', projectId).is('deleted_at', null).is('projects.deleted_at', null)
        .or('status_override.is.null,status_override.neq.disabled');
      if (error) throw error;
      return data as unknown as ConstructionConflictRow[];
    },
    async list(projectId: string): Promise<ProjectConstructionProgress[]> {
      const { data, error } = await client.from('project_construction_progress').select('*')
        .eq('project_id', projectId).is('deleted_at', null)
        .order('sort_order').order('created_at').order('id');
      if (error) throw error;
      return data as ProjectConstructionProgress[];
    },
    async create(projectId: string, values: ConstructionCreate): Promise<ProjectConstructionProgress> {
      if (values.work_type === 'other') {
        const error = validateConstructionWorkName(values.work_name ?? null);
        if (error) throw new Error(error);
      }
      const { data, error } = await client.from('project_construction_progress')
        .insert({ ...values, project_id: projectId }).select('*').single();
      if (error) throw error;
      return data as ProjectConstructionProgress;
    },
    async update(projectId: string, id: string, values: ConstructionUpdate): Promise<ProjectConstructionProgress> {
      if (values.work_name !== undefined) {
        const error = validateConstructionWorkName(values.work_name);
        if (error) throw new Error(error);
      }
      const { data, error } = await client.from('project_construction_progress').update(values)
        .eq('project_id', projectId).eq('id', id).is('deleted_at', null).select('*').single();
      if (error) throw error;
      return data as ProjectConstructionProgress;
    },
    async removeOther(projectId: string, id: string): Promise<void> {
      const { error } = await client.from('project_construction_progress')
        .update({ deleted_at: new Date().toISOString() }).eq('project_id', projectId)
        .eq('id', id).eq('work_type', 'other').is('deleted_at', null).select('id').single();
      if (error) throw error;
    },
  };
}

export const constructionProgressAdapter = createConstructionProgressAdapter(supabase);
