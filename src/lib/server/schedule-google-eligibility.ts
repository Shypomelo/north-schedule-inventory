import type { SupabaseClient } from '@supabase/supabase-js';

export type ScheduleGoogleWorkGroup = {
  id: string;
  key: string;
  name: string;
  google_calendar_sync_enabled: boolean;
};

export type ScheduleGoogleEligibilityRow = {
  work_group_id: string;
  work_groups?: ScheduleGoogleWorkGroup | ScheduleGoogleWorkGroup[] | null;
};

export type ScheduleGoogleEligibility = {
  eligible: boolean;
  workGroup: ScheduleGoogleWorkGroup | null;
};

const getJoinedWorkGroup = (
  value: ScheduleGoogleEligibilityRow['work_groups'],
): ScheduleGoogleWorkGroup | null => (
  Array.isArray(value) ? value[0] || null : value || null
);

export function getScheduleGoogleEligibility(
  task: ScheduleGoogleEligibilityRow,
): ScheduleGoogleEligibility {
  const workGroup = getJoinedWorkGroup(task.work_groups);
  return {
    eligible: Boolean(
      workGroup
      && workGroup.id === task.work_group_id
      && workGroup.google_calendar_sync_enabled,
    ),
    workGroup,
  };
}

export async function resolveScheduleGoogleEligibility(
  supabase: SupabaseClient,
  taskId: string,
): Promise<ScheduleGoogleEligibility | null> {
  const { data, error } = await supabase
    .from('schedule_tasks')
    .select(`
      work_group_id,
      work_groups!inner (
        id,
        key,
        name,
        google_calendar_sync_enabled
      )
    `)
    .eq('id', taskId)
    .maybeSingle();
  if (error) throw error;
  return data ? getScheduleGoogleEligibility(data as unknown as ScheduleGoogleEligibilityRow) : null;
}
