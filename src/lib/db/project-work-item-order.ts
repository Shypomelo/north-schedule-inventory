import { supabase } from './supabaseClient';
import type { ProjectWorkItem } from '../project-work-item-order';

export async function getProjectWorkItemPositions(projectId: string): Promise<Record<string,number>> {
  const { data,error } = await supabase.from('project_work_item_positions')
    .select('item_kind,item_id,position').eq('project_id',projectId);
  if (error) throw error;
  return Object.fromEntries((data || []).map(row => [`${row.item_kind}:${row.item_id}`,Number(row.position)]));
}

export async function reorderProjectWorkItems(projectId: string, items: ProjectWorkItem[], expectedPositions: Record<string,number>): Promise<void> {
  const { error } = await supabase.rpc('reorder_project_work_items', {
    p_project_id: projectId,
    p_items: items.map(item => ({ kind: item.kind, id: item.id,
      expected_position: expectedPositions[`${item.kind}:${item.id}`] ?? null })),
  });
  if (error) throw error;
}
