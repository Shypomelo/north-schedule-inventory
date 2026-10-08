import type { Project } from './db/types';
import type { PendingRow } from './receiving-v5';

// SolarEdge Taiwan Partner API v1.0 response fields. This fixture is UI-only.
export interface SEPartnerItemV1 { name: string; qty: number }
export interface SEPartnerOrderV1 {
  orderNo: string;
  caseNumbers: string[];
  siteName: string;
  items: SEPartnerItemV1[];
  status: string;
  statusLabel: string;
  carrier: string;
  trackingNos: string[];
  createdAt: string;
  updatedAt: string;
}
export interface SEPartnerRemovedV1 { orderNo: string; removedAt: string; reason: 'deleted' | 'reassigned' }
export interface SEPartnerResponseV1 {
  apiVersion: '1.0';
  total: number;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  orders: SEPartnerOrderV1[];
  removed: SEPartnerRemovedV1[];
}

export const seOrderMockResponse: SEPartnerResponseV1 = {
  apiVersion: '1.0', total: 3, count: 3, hasMore: false, nextCursor: null,
  orders: [
    {
      orderNo: 'SO-20261002-153000', caseNumbers: ['7000001', '7000001-2'], siteName: '範例北部案場 A',
      items: [{ name: 'RSESU-RW0S0NNN4', qty: 1 }, { name: 'RSESU-RW0S0NNN4', qty: 2 }],
      status: 'shipped', statusLabel: '已出貨', carrier: '大榮', trackingNos: ['12345678901', '12345678902'],
      createdAt: '2026-10-02', updatedAt: '2026-10-02T07:52:30.000Z',
    },
    {
      orderNo: 'SO-20261003-091500', caseNumbers: [], siteName: '待確認案場',
      items: [{ name: 'SE-MOCK-5K', qty: 1 }], status: 'partner_review', statusLabel: '待人工確認',
      carrier: '', trackingNos: [], createdAt: '2026-10-03', updatedAt: '',
    },
    {
      orderNo: 'SO-20261004-101500', caseNumbers: ['7000003'], siteName: '範例北部案場 C',
      items: [{ name: 'SE-MOCK-8K', qty: 3 }], status: 'cancelled', statusLabel: '已取消',
      carrier: '自取-倉庫', trackingNos: [], createdAt: '2026-10-04', updatedAt: '2026-10-04T02:15:00.000Z',
    },
  ],
  // Simulates the first page of a query with since; later pages omit removed.
  removed: [
    { orderNo: 'SO-20260930-101500', removedAt: '2026-10-03T02:10:00.000Z', reason: 'deleted' },
    { orderNo: 'SO-20260929-101500', removedAt: '2026-10-04T02:10:00.000Z', reason: 'reassigned' },
  ],
};

// UI projection only. A removed notification does not contain order details.
export interface SEOrderView { orderNo: string; order: SEPartnerOrderV1 | null; removal: SEPartnerRemovedV1 | null }
export function seOrderViews(response: SEPartnerResponseV1): SEOrderView[] {
  return [
    ...response.orders.map(order => ({ orderNo: order.orderNo, order, removal: null })),
    ...response.removed.map(removal => ({ orderNo: removal.orderNo, order: null, removal })),
  ];
}

const knownStatuses = new Set(['pending', 'accepted', 'outofstock', 'arranging', 'shipped', 'done', 'cancelled']);
export function seOrderStatus(view: SEOrderView): { filter: string; label: string } {
  if (view.removal) return { filter: 'removed', label: `已失效（${view.removal.reason}）` };
  const order = view.order!;
  return { filter: order.status, label: knownStatuses.has(order.status) ? (order.statusLabel || order.status) : `${order.statusLabel || order.status}（${order.status}）` };
}

export type SEOrderProjectMatch = { state: 'UNCONFIRMED' | 'INVALID'; project: Project | null };
export function matchSEOrderProject(view: SEOrderView, projects: Project[]): SEOrderProjectMatch {
  if (!view.order || view.order.status === 'cancelled') return { state: 'INVALID', project: null };
  // An exact site name is only a review candidate, never authoritative team scope.
  const matches = projects.filter(project => !project.deleted_at && project.name.trim() === view.order!.siteName.trim());
  return { state: 'UNCONFIRMED', project: matches.length === 1 ? matches[0] : null };
}

export function matchSEOrderPending(view: SEOrderView, pending: PendingRow[], project: Project | null): 'UNCONFIRMED' | 'CANDIDATE' | 'NONE' {
  if (!view.order || view.order.status === 'cancelled') return 'NONE';
  if (!project) return 'UNCONFIRMED';
  const models = new Set(view.order.items.map(item => item.name.trim().toUpperCase()));
  const candidates = pending.filter(row => row.projectId === project.id
    && Array.from(models).some(model => row.label.trim().toUpperCase() === model || row.label.trim().toUpperCase().startsWith(model + ' ·')));
  return candidates.length ? 'CANDIDATE' : 'UNCONFIRMED';
}

/** Reject invented fields in the raw fixture; UI fields belong in SEOrderView. */
export function validateSEOrderMockResponse(value: unknown): asserts value is SEPartnerResponseV1 {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>) => Object.keys(v).sort().join(',');
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string');
  if (!object(value) || keys(value) !== 'apiVersion,count,hasMore,nextCursor,orders,removed,total'
    || value.apiVersion !== '1.0' || !Number.isSafeInteger(value.total) || (value.total as number) < 0
    || !Number.isSafeInteger(value.count) || typeof value.hasMore !== 'boolean'
    || !(value.nextCursor === null || typeof value.nextCursor === 'string')
    || !Array.isArray(value.orders) || !Array.isArray(value.removed)
    || value.count !== value.orders.length) throw new Error('SE Mock response 不符合 Partner API v1.0');
  const seen = new Set<string>();
  for (const order of value.orders) {
    if (!object(order) || keys(order) !== 'carrier,caseNumbers,createdAt,items,orderNo,siteName,status,statusLabel,trackingNos,updatedAt'
      || typeof order.orderNo !== 'string' || !order.orderNo || seen.has(order.orderNo)
      || !strings(order.caseNumbers) || typeof order.siteName !== 'string' || !Array.isArray(order.items)
      || typeof order.status !== 'string' || !order.status || typeof order.statusLabel !== 'string'
      || typeof order.carrier !== 'string' || !strings(order.trackingNos)
      || typeof order.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(order.createdAt)
      || typeof order.updatedAt !== 'string' || (order.updatedAt !== ''
        && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(order.updatedAt) || Number.isNaN(Date.parse(order.updatedAt)))))
      throw new Error('SE Mock 訂單欄位不符合 Partner API v1.0');
    seen.add(order.orderNo);
    for (const item of order.items) {
      if (!object(item) || keys(item) !== 'name,qty' || typeof item.name !== 'string' || !item.name
        || !Number.isFinite(item.qty) || (item.qty as number) <= 0) throw new Error('SE Mock 品項欄位不符合 Partner API v1.0');
    }
  }
  for (const removal of value.removed) {
    if (!object(removal) || keys(removal) !== 'orderNo,reason,removedAt'
      || typeof removal.orderNo !== 'string' || !removal.orderNo || seen.has(removal.orderNo)
      || typeof removal.removedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(removal.removedAt)
      || Number.isNaN(Date.parse(removal.removedAt))
      || !['deleted', 'reassigned'].includes(String(removal.reason))) throw new Error('SE Mock removed 欄位不符合 Partner API v1.0');
    seen.add(removal.orderNo);
  }
}
