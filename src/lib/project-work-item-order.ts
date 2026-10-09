import type { ProjectConstructionProgress, ProjectMilestone } from './db/types';

export type ProjectWorkItem =
  | { kind: 'MILESTONE'; id: string; milestone: ProjectMilestone }
  | { kind: 'CONSTRUCTION'; id: string; construction: ProjectConstructionProgress };

export function mergeProjectWorkItems(
  milestones: ProjectMilestone[],
  construction: ProjectConstructionProgress[],
  positions: Record<string, number>,
): ProjectWorkItem[] {
  const items: ProjectWorkItem[] = [
    ...milestones.filter(row => !row.deleted_at && !row.archived_at && row.milestone_key !== 'SITE_ENTRY')
      .map(milestone => ({ kind: 'MILESTONE' as const, id: milestone.id, milestone })),
    ...construction.filter(row => !row.deleted_at && row.status_override !== 'disabled')
      .map(row => ({ kind: 'CONSTRUCTION' as const, id: row.id, construction: row })),
  ];
  return items.sort((a, b) => {
    const left = positions[`${a.kind}:${a.id}`] ?? Number.MAX_SAFE_INTEGER;
    const right = positions[`${b.kind}:${b.id}`] ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
  });
}

export function moveProjectWorkItem(items: ProjectWorkItem[], dragged: string, target: string): ProjectWorkItem[] {
  const result = [...items];
  const from = result.findIndex(item => `${item.kind}:${item.id}` === dragged);
  const to = result.findIndex(item => `${item.kind}:${item.id}` === target);
  if (from < 0 || to < 0) throw new Error('工項順序已變更，請重新載入');
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}
