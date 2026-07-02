import { supabase } from './supabaseClient';
import { ScheduleTask } from './types';

export const pocSupabaseAdapter = {
  getScheduleTasks: async (): Promise<ScheduleTask[]> => {
    const { data, error } = await supabase
      .from('schedule_tasks')
      .select('*');
    if (error) {
      console.error('Error fetching schedule_tasks:', error);
      throw error;
    }

    // Map Supabase schema back to frontend ScheduleTask
    return data.map((row: any) => ({
      id: row.id,
      task_type: row.task_type || '',
      title: row.title || '',
      project_id: row.project_id || null,
      project_name: row.project_name || null,
      address: row.address || null,
      task_date: row.task_date || '',
      start_time: row.start_time || null,
      end_time: row.end_time || null,
      is_all_day: !!row.is_all_day,
      is_tentative: !!row.is_tentative,
      status: row.status || '未開始',
      main_assignee_id: row.primary_member_id || null,
      description: row.notes || null,
      source_todo_id: null,
      google_calendar_id: null,
      created_by: row.created_by || 'system',
      created_at: row.created_at || new Date().toISOString(),
      updated_at: row.updated_at || new Date().toISOString(),
    })) as ScheduleTask[];
  },

  createScheduleTask: async (
    t: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>,
    newMemberIds: string[] = [] // members are handled in dbAdapter.createScheduleTask
  ): Promise<ScheduleTask> => {
    const taskData = {
      project_id: t.project_id,
      project_name: t.project_name,
      task_type: t.task_type,
      title: t.title,
      notes: t.description || null,
      task_date: t.task_date,
      start_time: t.start_time || null,
      end_time: t.end_time || null,
      is_all_day: t.is_all_day,
      primary_member_id: t.main_assignee_id,
      primary_member_name: null,
      assistant_member_ids: newMemberIds || [],
      assistant_member_names: [],
      status: t.status,
      is_tentative: t.is_tentative || false,
      address: t.address || null,
      google_maps_url: null,
      created_by: 'system',
      updated_by: 'system',
    };

    const { data, error } = await supabase
      .from('schedule_tasks')
      .insert(taskData)
      .select()
      .single();

    if (error) {
      console.error('Error creating schedule_task:', error);
      throw error;
    }
    
    // Convert back
    return {
      ...t,
      id: data.id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    } as ScheduleTask;
  },

  updateScheduleTask: async (
    id: string,
    updates: Partial<ScheduleTask>,
    newMemberIds?: string[]
  ): Promise<ScheduleTask> => {
    const dbUpdates: any = {};
    if (updates.project_id !== undefined) dbUpdates.project_id = updates.project_id;
    if (updates.project_name !== undefined) dbUpdates.project_name = updates.project_name;
    if (updates.task_type !== undefined) dbUpdates.task_type = updates.task_type;
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.notes = updates.description;
    if (updates.task_date !== undefined) dbUpdates.task_date = updates.task_date;
    if (updates.start_time !== undefined) dbUpdates.start_time = updates.start_time;
    if (updates.end_time !== undefined) dbUpdates.end_time = updates.end_time;
    if (updates.is_all_day !== undefined) dbUpdates.is_all_day = updates.is_all_day;
    if (updates.main_assignee_id !== undefined) dbUpdates.primary_member_id = updates.main_assignee_id;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.is_tentative !== undefined) dbUpdates.is_tentative = updates.is_tentative;
    if (updates.address !== undefined) dbUpdates.address = updates.address;
    if (newMemberIds !== undefined) dbUpdates.assistant_member_ids = newMemberIds;
    
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('schedule_tasks')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating schedule_task:', error);
      throw error;
    }
    
    return {
      id: data.id,
      task_type: data.task_type || '',
      title: data.title || '',
      project_id: data.project_id || null,
      project_name: data.project_name || null,
      address: data.address || null,
      task_date: data.task_date || '',
      start_time: data.start_time || null,
      end_time: data.end_time || null,
      is_all_day: !!data.is_all_day,
      is_tentative: !!data.is_tentative,
      status: data.status || '未開始',
      main_assignee_id: data.primary_member_id || null,
      description: data.notes || null,
      source_todo_id: null,
      google_calendar_id: null,
      created_by: data.created_by || 'system',
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
    } as ScheduleTask;
  },

  deleteScheduleTask: async (id: string): Promise<void> => {
    // For POC, hard delete to keep it simple
    const { error } = await supabase
      .from('schedule_tasks')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting schedule_task:', error);
      throw error;
    }
  }
};
