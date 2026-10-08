import type { SupabaseClient } from '@supabase/supabase-js';
import type { SEOrderView, SEItemGroup, SEItemLink, SEScopeState } from '../se-partner-view';
import type { SEPartnerItemV1, SEPartnerOrderV1 } from '../se-partner-contract';

interface OrderRow {
  order_no: string; case_numbers: string[]; site_name: string; raw_items: SEPartnerItemV1[];
  status: string; status_label: string; carrier: string; tracking_nos: string[];
  created_on: string | null; api_updated_at: string | null; scope_state: SEScopeState;
  project_id: string | null; removed_at: string | null; removed_reason: string | null;
}
interface ItemRow { id: string; order_no: string; model_name: string; quantity: number; is_active: boolean }
interface LinkRow { id: string; item_id: string; source_type: SEItemLink['sourceType']; source_id: string; project_id: string; quantity: number; cancelled_at: string | null }
interface SerialRow { item_id: string; serial_number: string }
export interface SECaseRule { caseNumber: string; scopeState: 'NORTH' | 'NOT_NORTH'; projectId: string | null }

export function createSEPartnerSnapshotApi(client: SupabaseClient) {
  async function rows<T>(table: string, columns: string, order: string): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client.from(table).select(columns).order(order).range(offset, offset + 499);
      if (error) throw new Error(error.message);
      result.push(...data as T[]);
      if (data.length < 500) return result;
    }
  }
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  return {
    async load(): Promise<SEOrderView[]> {
      // All four reads use RLS. Opening Receiving never invokes the external Partner API.
      const [orders, items, links, serials] = await Promise.all([
        rows<OrderRow>('se_orders', 'order_no,case_numbers,site_name,raw_items,status,status_label,carrier,tracking_nos,created_on,api_updated_at,scope_state,project_id,removed_at,removed_reason', 'order_no'),
        rows<ItemRow>('se_order_items', 'id,order_no,model_name,quantity,is_active', 'id'),
        rows<LinkRow>('se_order_item_links', 'id,item_id,source_type,source_id,project_id,quantity,cancelled_at', 'id'),
        rows<SerialRow>('se_order_item_serials', 'item_id,serial_number', 'id'),
      ]);
      return orders.map(row => {
        const order: SEPartnerOrderV1 | null = row.created_on ? {
          orderNo: row.order_no, caseNumbers: row.case_numbers, siteName: row.site_name,
          items: row.raw_items, status: row.status, statusLabel: row.status_label,
          carrier: row.carrier, trackingNos: row.tracking_nos,
          createdAt: row.created_on, updatedAt: row.api_updated_at || '',
        } : null;
        const groups: SEItemGroup[] = items.filter(item => item.order_no === row.order_no).map(item => ({
          id: item.id, name: item.model_name, quantity: Number(item.quantity), active: item.is_active,
          links: links.filter(link => link.item_id === item.id && !link.cancelled_at).map(link => ({
            id: link.id, sourceType: link.source_type, sourceId: link.source_id,
            projectId: link.project_id, quantity: Number(link.quantity),
          })),
          serials: serials.filter(serial => serial.item_id === item.id).map(serial => serial.serial_number),
        }));
        return { orderNo: row.order_no, order,
          removal: row.removed_at ? { orderNo: row.order_no, removedAt: row.removed_at,
            reason: row.removed_reason === 'reassigned' ? 'reassigned' as const : 'deleted' as const } : null,
          scopeState: row.scope_state, projectId: row.project_id, items: groups };
      });
    },
    async rules(): Promise<SECaseRule[]> {
      const source = await rows<{ case_number: string; scope_state: 'NORTH' | 'NOT_NORTH'; project_id: string | null }>(
        'se_case_scope_rules', 'case_number,scope_state,project_id', 'case_number');
      return source.map(row => ({ caseNumber: row.case_number, scopeState: row.scope_state, projectId: row.project_id }));
    },
    confirmScope: (orderNo: string, scope: SEScopeState, projectId: string | null) =>
      rpc<void>('se_confirm_order_scope', { p_order_no: orderNo, p_scope: scope, p_project_id: projectId }),
    setCaseRule: (caseNumber: string, scope: 'NORTH' | 'NOT_NORTH', projectId: string | null) =>
      rpc<void>('se_set_case_scope_rule', { p_case_number: caseNumber, p_scope: scope, p_project_id: projectId }),
    link: (itemId: string, sourceType: SEItemLink['sourceType'], sourceId: string, quantity: number) =>
      rpc<string>('se_link_order_item', { p_item_id: itemId, p_source_type: sourceType, p_source_id: sourceId, p_quantity: quantity }),
    unlink: (linkId: string) => rpc<void>('se_unlink_order_item', { p_link_id: linkId }),
  };
}
