import { mockDbAdapter } from './mock';
import { supabaseDbAdapter } from './supabase';
import { pocSupabaseAdapter } from './poc-supabase';

const hasSupabase = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Use mock for everything except schedule tasks (which go to POC adapter if enabled)
export const dbAdapter = {
  ...mockDbAdapter,
  getScheduleTasks: hasSupabase ? pocSupabaseAdapter.getScheduleTasks : mockDbAdapter.getScheduleTasks,
  createScheduleTask: hasSupabase ? pocSupabaseAdapter.createScheduleTask : mockDbAdapter.createScheduleTask,
  updateScheduleTask: hasSupabase ? pocSupabaseAdapter.updateScheduleTask : mockDbAdapter.updateScheduleTask,
  deleteScheduleTask: hasSupabase ? pocSupabaseAdapter.deleteScheduleTask : mockDbAdapter.deleteScheduleTask,
};
