import { mockDbAdapter } from './mock';
import { supabaseDbAdapter } from './supabase';
import { pocSupabaseAdapter } from './poc-supabase';

const hasSupabase = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Use mock for everything except schedule tasks (which go to POC adapter if enabled)
export const dbAdapter = {
  ...mockDbAdapter,
  getUsers: hasSupabase ? pocSupabaseAdapter.getUsers : mockDbAdapter.getUsers,
  createUser: hasSupabase ? pocSupabaseAdapter.createUser : mockDbAdapter.createUser,
  updateUser: hasSupabase ? pocSupabaseAdapter.updateUser : mockDbAdapter.updateUser,
  getScheduleTasks: hasSupabase ? pocSupabaseAdapter.getScheduleTasks : mockDbAdapter.getScheduleTasks,
  createScheduleTask: hasSupabase ? pocSupabaseAdapter.createScheduleTask : mockDbAdapter.createScheduleTask,
  updateScheduleTask: hasSupabase ? pocSupabaseAdapter.updateScheduleTask : mockDbAdapter.updateScheduleTask,
  deleteScheduleTask: hasSupabase ? pocSupabaseAdapter.deleteScheduleTask : mockDbAdapter.deleteScheduleTask,

  // Contractors
  getContractors: hasSupabase ? pocSupabaseAdapter.getContractors : mockDbAdapter.getContractors,
  createContractor: hasSupabase ? pocSupabaseAdapter.createContractor : mockDbAdapter.createContractor,
  updateContractor: hasSupabase ? pocSupabaseAdapter.updateContractor : mockDbAdapter.updateContractor,
  deleteContractor: hasSupabase ? pocSupabaseAdapter.deleteContractor : mockDbAdapter.deleteContractor,

  // Projects
  getProjects: hasSupabase ? pocSupabaseAdapter.getProjects : mockDbAdapter.getProjects,
  createProject: hasSupabase ? pocSupabaseAdapter.createProject : mockDbAdapter.createProject,
  updateProject: hasSupabase ? pocSupabaseAdapter.updateProject : mockDbAdapter.updateProject,
  deleteProject: hasSupabase ? pocSupabaseAdapter.deleteProject : mockDbAdapter.deleteProject,
};
