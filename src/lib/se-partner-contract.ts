export interface SEPartnerItemV1 { name: string; qty: number }
export interface SEPartnerOrderV1 {
  orderNo: string; caseNumbers: string[]; siteName: string; items: SEPartnerItemV1[];
  status: string; statusLabel: string; carrier: string; trackingNos: string[];
  createdAt: string; updatedAt: string;
}
export interface SEPartnerRemovedV1 { orderNo: string; removedAt: string; reason: 'deleted' | 'reassigned' }
export interface SEPartnerResponseV1 {
  apiVersion: '1.0'; total: number; count: number; hasMore: boolean;
  nextCursor: string | null; orders: SEPartnerOrderV1[]; removed: SEPartnerRemovedV1[];
}

/** Validate known v1 fields while tolerating future extra fields and status codes. */
export function parseSEPartnerResponse(value: unknown): SEPartnerResponseV1 {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string');
  const iso = (v: unknown) => typeof v === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
  if (!object(value) || value.apiVersion !== '1.0' || !Number.isSafeInteger(value.total)
    || (value.total as number) < 0 || !Number.isSafeInteger(value.count)
    || typeof value.hasMore !== 'boolean' || !(value.nextCursor === null || typeof value.nextCursor === 'string')
    || !Array.isArray(value.orders) || !Array.isArray(value.removed)
    || value.count !== value.orders.length || (value.hasMore && !value.nextCursor))
    throw new Error('SE_RESPONSE_INVALID');
  for (const order of value.orders) {
    if (!object(order) || typeof order.orderNo !== 'string' || !order.orderNo
      || !strings(order.caseNumbers) || typeof order.siteName !== 'string' || !Array.isArray(order.items)
      || typeof order.status !== 'string' || !order.status || typeof order.statusLabel !== 'string'
      || typeof order.carrier !== 'string' || !strings(order.trackingNos)
      || typeof order.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(order.createdAt)
      || !(order.updatedAt === '' || iso(order.updatedAt))) throw new Error('SE_ORDER_INVALID');
    for (const item of order.items) {
      if (!object(item) || typeof item.name !== 'string' || !item.name.trim()
        || typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0)
        throw new Error('SE_ITEM_INVALID');
    }
  }
  for (const removal of value.removed) {
    if (!object(removal) || typeof removal.orderNo !== 'string' || !removal.orderNo
      || !iso(removal.removedAt) || !['deleted', 'reassigned'].includes(String(removal.reason)))
      throw new Error('SE_REMOVED_INVALID');
  }
  return value as unknown as SEPartnerResponseV1;
}
