import { supabase } from './supabaseClient';
import type { Project } from './types';

export async function getProcurementProjectLabels(): Promise<Project[]> {
  const { data, error } = await supabase.rpc('get_procurement_project_labels');
  if (error) throw error;
  return (data || []) as Project[];
}
