import type { Project } from './db/types';
import type { PendingRow } from './receiving-v5';
import type { SEPartnerOrderV1, SEPartnerRemovedV1 } from './se-partner-contract';

export type SEScopeState = 'UNREVIEWED' | 'NORTH' | 'NOT_NORTH';
export interface SEItemLink {
  id: string;
  sourceType: 'PROJECT_MATERIAL' | 'SE_SUPPLY';
  sourceId: string;
  projectId: string;
  quantity: number;
}
export interface SEItemGroup {
  id: string;
  name: string;
  quantity: number;
  active: boolean;
  links: SEItemLink[];
  serials: string[];
}
export interface SEOrderView {
  orderNo: string;
  order: SEPartnerOrderV1 | null;
  removal: SEPartnerRemovedV1 | null;
  scopeState: SEScopeState;
  projectId: string | null;
  items: SEItemGroup[];
}

const knownStatuses = new Set(['pending', 'accepted', 'outofstock', 'arranging', 'shipped', 'done', 'cancelled']);
export function seOrderStatus(view: SEOrderView): { filter: string; label: string } {
  if (view.removal) return { filter: 'removed', label: `已失效（${view.removal.reason}）` };
  if (!view.order) return { filter: 'unknown', label: '訂單資料未提供' };
  const { status, statusLabel } = view.order;
  return { filter: status, label: knownStatuses.has(status) ? (statusLabel || status) : `${statusLabel || status}（${status}）` };
}

export function seOrderProject(view: SEOrderView, projects: Project[]): Project | null {
  return view.scopeState === 'NORTH' && view.projectId
    ? projects.find(project => project.id === view.projectId && !project.deleted_at) || null : null;
}

export function linkedPendingKeys(view: SEOrderView, pending: PendingRow[]): string[] {
  const keys = new Set(pending.map(row => row.key));
  return Array.from(new Set(view.items.flatMap(item => item.links.map(link =>
    `${link.sourceType}:${link.sourceId}`)))).filter(key => keys.has(key));
}

// Possible choices are shown only for manual review. Names never create links or team scope.
export function pendingCandidates(view: SEOrderView, item: SEItemGroup, pending: PendingRow[]): PendingRow[] {
  if (view.scopeState !== 'NORTH' || !item.active || view.removal || view.order?.status === 'cancelled') return [];
  return pending.filter(row => (!view.projectId || row.projectId === view.projectId)
    && row.projectId && row.fulfilment.remaining > 0
    && row.label.trim().toUpperCase().split(' · ')[0] === item.name.trim().toUpperCase());
}
