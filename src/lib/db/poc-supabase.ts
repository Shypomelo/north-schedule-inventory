import { supabase } from './supabaseClient';
import { ScheduleTask, User, UserRole, Contractor, Project } from './types';

const mapUser = (row: any): User => ({
  id: row.id,
  name: row.name,
  short_name: row.name.charAt(0),
  email: row.email,
  role: (row.role || 'viewer').toUpperCase() as UserRole,
  category: (row.category || 'other').toUpperCase() as 'ENGINEERING' | 'OTHER',
  is_active: row.is_active ?? true,
  google_calendar_email: row.google_calendar_email || null,
  notes: row.notes || null,
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

const syncProjectProgress = async (projectId: string, p: Partial<Project>) => {
  const workTypes = ['racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other'];
  
  const { data: contractorsData } = await supabase.from('contractors').select('id, name');
  const contractorsMap = new Map((contractorsData || []).map((c: any) => [c.id, c.name]));

  const { data: existingProgress } = await supabase
    .from('project_construction_progress')
    .select('*')
    .eq('project_id', projectId);
    
  for (const type of workTypes) {
    const cidKey = `${type}_contractor_id` as keyof Project;
    const sDateKey = `${type}_expected_start_date` as keyof Project;
    const eDateKey = `${type}_completion_date` as keyof Project;
    const statusKey = `${type}_status` as keyof Project;
    const notesKey = `${type}_notes` as keyof Project;

    if (
      p[cidKey] === undefined && p[sDateKey] === undefined && 
      p[eDateKey] === undefined && p[statusKey] === undefined && 
      p[notesKey] === undefined
    ) {
      continue;
    }

    const existing = existingProgress?.find((x: any) => x.work_type === type);
    
    const payload: any = {
      project_id: projectId,
      work_type: type,
    };
    
    let hasData = false;
    
    if (p[cidKey] !== undefined) {
      payload.contractor_id = p[cidKey] || null;
      if (payload.contractor_id) {
         payload.contractor_name = contractorsMap.get(payload.contractor_id) || null;
      } else {
         payload.contractor_name = null;
      }
      hasData = true;
    } else if (existing) {
      payload.contractor_id = existing.contractor_id;
      payload.contractor_name = existing.contractor_name;
    }

    if (p[sDateKey] !== undefined) { payload.planned_start_date = p[sDateKey] || null; hasData = true; }
    else if (existing) { payload.planned_start_date = existing.planned_start_date; }

    if (p[eDateKey] !== undefined) { payload.completed_date = p[eDateKey] || null; hasData = true; }
    else if (existing) { payload.completed_date = existing.completed_date; }

    if (p[statusKey] !== undefined) { payload.status_override = p[statusKey] || null; hasData = true; }
    else if (existing) { payload.status_override = existing.status_override; }

    if (p[notesKey] !== undefined) { payload.notes = p[notesKey] || null; hasData = true; }
    else if (existing) { payload.notes = existing.notes; }

    if (hasData || existing) {
       const isNowEmpty = !payload.contractor_id && !payload.planned_start_date && !payload.completed_date && !payload.status_override && !payload.notes;
       
       if (existing) {
          if (isNowEmpty) {
             await supabase.from('project_construction_progress').update({ deleted_at: new Date().toISOString() }).eq('id', existing.id);
          } else {
             payload.deleted_at = null;
             await supabase.from('project_construction_progress').update(payload).eq('id', existing.id);
          }
       } else {
          if (!isNowEmpty) {
             await supabase.from('project_construction_progress').insert(payload);
          }
       }
    }
  }
};

export const pocSupabaseAdapter = {
  // --- Users (team_members) ---
  getUsers: async (): Promise<User[]> => {
    const { data, error } = await supabase
      .from('team_members')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
      
    if (error) {
      console.error('Error fetching team_members:', error);
      throw error;
    }
    
    return data.map(mapUser);
  },

  createUser: async (u: Omit<User, 'id'|'created_at'|'updated_at'>): Promise<User> => {
    const dbData = {
      name: u.name,
      email: u.email,
      role: u.role.toLowerCase(),
      category: u.category?.toLowerCase() || 'other',
      is_active: u.is_active,
      google_calendar_email: u.google_calendar_email || null,
      notes: u.notes || null,
    };
    
    const { data, error } = await supabase
      .from('team_members')
      .insert(dbData)
      .select()
      .single();
      
    if (error) {
      console.error('Error creating team_member:', error);
      throw error;
    }
    
    return mapUser(data);
  },

  updateUser: async (id: string, updates: Partial<Omit<User, 'id'|'created_at'|'updated_at'>>): Promise<User> => {
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.email !== undefined) dbUpdates.email = updates.email;
    if (updates.role !== undefined) dbUpdates.role = updates.role.toLowerCase();
    if (updates.category !== undefined) dbUpdates.category = updates.category.toLowerCase();
    if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;
    if (updates.google_calendar_email !== undefined) dbUpdates.google_calendar_email = updates.google_calendar_email;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    
    // updated_at can be handled by trigger, but we set it here just in case
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('team_members')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();
      
    if (error) {
      console.error('Error updating team_member:', error);
      throw error;
    }
    
    return mapUser(data);
  },

  // --- Schedule Tasks ---
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
  },

  // --- Contractors ---
  getContractors: async (): Promise<Contractor[]> => {
    const { data, error } = await supabase
      .from('contractors')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
      
    if (error) {
      console.error('Error fetching contractors:', error);
      throw error;
    }
    
    return data as Contractor[];
  },

  createContractor: async (c: Omit<Contractor, 'id' | 'created_at' | 'updated_at'>): Promise<Contractor> => {
    const dbData = {
      name: c.name,
      contractor_type: c.contractor_type,
      contact_person: c.contact_person || null,
      phone: c.phone || null,
      notes: c.notes || null,
      is_active: c.is_active ?? true,
    };
    
    const { data, error } = await supabase
      .from('contractors')
      .insert(dbData)
      .select()
      .single();
      
    if (error) {
      console.error('Error creating contractor:', error);
      throw error;
    }
    
    return data as Contractor;
  },

  updateContractor: async (id: string, updates: Partial<Contractor>): Promise<Contractor> => {
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.contractor_type !== undefined) dbUpdates.contractor_type = updates.contractor_type;
    if (updates.contact_person !== undefined) dbUpdates.contact_person = updates.contact_person;
    if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;
    
    // updated_at is handled by trigger
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('contractors')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();
      
    if (error) {
      console.error('Error updating contractor:', error);
      throw error;
    }
    
    return data as Contractor;
  },

  deleteContractor: async (id: string): Promise<void> => {
    // Soft delete
    const { error } = await supabase
      .from('contractors')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', id);

    if (error) {
      console.error('Error deleting contractor:', error);
      throw error;
    }
  },

  // --- Projects (Step 3: Basic Data + Step 4: Progress) ---
  
  getProjects: async (): Promise<Project[]> => {
    const { data, error } = await supabase
      .from('projects')
      .select('*, project_construction_progress(*)')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching projects:', error);
      throw error;
    }

    return data.map((row: any) => {
      const pData: any = {};
      if (row.project_construction_progress) {
        row.project_construction_progress.forEach((prog: any) => {
          if (prog.deleted_at) return;
          const type = prog.work_type; // 'racking', 'electrical', etc.
          pData[`${type}_contractor_id`] = prog.contractor_id;
          pData[`${type}_contractor_name`] = prog.contractor_name;
          pData[`${type}_expected_start_date`] = prog.planned_start_date;
          pData[`${type}_completion_date`] = prog.completed_date;
          pData[`${type}_status`] = prog.status_override;
          pData[`${type}_notes`] = prog.notes;
        });
      }

      return {
        id: row.id,
        project_code: row.project_code || null,
        name: row.project_name || '',
        short_name: row.project_short_name || null,
        capacity: row.capacity_kw || null,
        address: row.address || null,
        region: row.region || null,
        manager: row.responsible_member_name || null,
        status: row.status || '開案',
        meter_expected_date: row.meter_date || null,
        notes: row.notes || null,
        is_active: row.deleted_at === null,
        created_at: row.created_at || new Date().toISOString(),
        updated_at: row.updated_at || new Date().toISOString(),
        
        owner_name: null, contact_name: null, contact_phone: null, project_type: null,
        owner_phone: null, data_source: null, warranty_status: null, completion_date: row.completed_at ? row.completed_at.split('T')[0] : null,
        warranty_years: null, warranty_end_date: null, has_maintenance_contract: null,
        maintenance_start_date: null, maintenance_end_date: null, maintenance_notes: null,
        inverter_brand: null, inverter_warranty: null, monitoring_system: null, module_mounting_type: null,
        last_inspection_date: null, inspection_cycle_months: null, next_inspection_date: null,
        inspection_reminder_days: null, report_base_date: null, report_section: row.stage || null,
        
        bracket_status: null, power_status: null, inspection_status: null, inspection_expected_date: null,
        inspection_completion_date: null, meter_status: null, meter_completion_date: null,
        roof_status: null, start_date: null,
        
        racking_contractor_id: pData.racking_contractor_id || null,
        racking_contractor_name: pData.racking_contractor_name || null,
        racking_expected_start_date: pData.racking_expected_start_date || null,
        racking_completion_date: pData.racking_completion_date || null,
        racking_status: pData.racking_status || null,
        racking_notes: pData.racking_notes || null,
        
        electrical_contractor_id: pData.electrical_contractor_id || null,
        electrical_contractor_name: pData.electrical_contractor_name || null,
        electrical_expected_start_date: pData.electrical_expected_start_date || null,
        electrical_completion_date: pData.electrical_completion_date || null,
        electrical_status: pData.electrical_status || null,
        electrical_notes: pData.electrical_notes || null,
        
        steel_contractor_id: pData.steel_contractor_id || null,
        steel_contractor_name: pData.steel_contractor_name || null,
        steel_expected_start_date: pData.steel_expected_start_date || null,
        steel_completion_date: pData.steel_completion_date || null,
        steel_status: pData.steel_status || null,
        steel_notes: pData.steel_notes || null,
        
        roof_cover_contractor_id: pData.roof_cover_contractor_id || null,
        roof_cover_contractor_name: pData.roof_cover_contractor_name || null,
        roof_cover_expected_start_date: pData.roof_cover_expected_start_date || null,
        roof_cover_completion_date: pData.roof_cover_completion_date || null,
        roof_cover_status: pData.roof_cover_status || null,
        roof_cover_notes: pData.roof_cover_notes || null,
        
        civil_contractor_id: pData.civil_contractor_id || null,
        civil_contractor_name: pData.civil_contractor_name || null,
        civil_expected_start_date: pData.civil_expected_start_date || null,
        civil_completion_date: pData.civil_completion_date || null,
        civil_status: pData.civil_status || null,
        civil_notes: pData.civil_notes || null,
        
        other_contractor_id: pData.other_contractor_id || null,
        other_contractor_name: pData.other_contractor_name || null,
        other_expected_start_date: pData.other_expected_start_date || null,
        other_completion_date: pData.other_completion_date || null,
        other_status: pData.other_status || null,
        other_notes: pData.other_notes || null,
      };
    });
  },

  createProject: async (p: Partial<Project>): Promise<Project> => {
    // Current user context is not easily available here unless passed down. 
    // We'll skip created_by/updated_by for now or assume it's handled by trigger/rls later if needed.
    const dbData: any = {
      project_code: p.project_code || null,
      project_name: p.name || '未命名案場',
      project_short_name: p.short_name || null,
      capacity_kw: p.capacity || null,
      address: p.address || null,
      region: p.region || null,
      responsible_member_name: p.manager || null,
      status: p.status || '開案',
      stage: p.report_section || null,
      meter_date: p.meter_expected_date || null,
      notes: p.notes || null,
    };

    if (dbData.status === '已結案') {
      dbData.completed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('projects')
      .insert(dbData)
      .select()
      .single();

    if (error) {
      console.error('Error creating project:', error);
      throw error;
    }
    
    await syncProjectProgress(data.id, p);

    return {
      ...p,
      id: data.id,
      name: data.project_name,
      status: data.status,
      created_at: data.created_at,
      updated_at: data.updated_at,
    } as Project;
  },

  updateProject: async (id: string, p: Partial<Project>): Promise<Project> => {
    const dbUpdates: any = {};
    if (p.project_code !== undefined) dbUpdates.project_code = p.project_code;
    if (p.name !== undefined) dbUpdates.project_name = p.name;
    if (p.short_name !== undefined) dbUpdates.project_short_name = p.short_name;
    if (p.capacity !== undefined) dbUpdates.capacity_kw = p.capacity;
    if (p.address !== undefined) dbUpdates.address = p.address;
    if (p.region !== undefined) dbUpdates.region = p.region;
    if (p.manager !== undefined) dbUpdates.responsible_member_name = p.manager;
    if (p.status !== undefined) {
      dbUpdates.status = p.status;
      if (p.status === '已結案') {
        dbUpdates.completed_at = new Date().toISOString();
      }
    }
    if (p.meter_expected_date !== undefined) dbUpdates.meter_date = p.meter_expected_date;
    if (p.notes !== undefined) dbUpdates.notes = p.notes;
    if (p.report_section !== undefined) dbUpdates.stage = p.report_section;

    // handled by trigger
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('projects')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating project:', error);
      throw error;
    }

    await syncProjectProgress(id, p);

    return {
      ...p,
      id: data.id,
      name: data.project_name,
      status: data.status,
      updated_at: data.updated_at,
    } as Project;
  },

  deleteProject: async (id: string): Promise<void> => {
    const { error } = await supabase
      .from('projects')
      .update({ deleted_at: new Date().toISOString(), status: '作廢' })
      .eq('id', id);

    if (error) {
      console.error('Error deleting project:', error);
      throw error;
    }
  }
};
