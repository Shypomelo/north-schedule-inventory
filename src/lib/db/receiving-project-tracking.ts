import type { SupabaseClient } from '@supabase/supabase-js';

export async function receivingSiteEvidence(client: SupabaseClient, siteReceiptId: string, transactionId: string) {
  async function pages(table: string, columns: string, key: string, value: string) {
    const result: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client.from(table).select(columns).eq(key, value).order('id').range(offset, offset + 499);
      if (error) throw new Error(error.message);
      result.push(...(data as unknown as Record<string, unknown>[]));
      if (data.length < 500) return result;
    }
  }
  const [links, allocations] = await Promise.all([
    pages('inventory_transaction_serials', 'id,serial_no,inventory_serials(serial_number)', 'transaction_id', transactionId),
    pages('receiving_inventory_allocations', 'id,office_receipt_id', 'site_receipt_id', siteReceiptId),
  ]);
  return {
    serials: links.map(r => String(r.serial_no || (r.inventory_serials as { serial_number?: string } | null)?.serial_number || '')).filter(Boolean),
    officeReceiptIds: Array.from(new Set(allocations.map(r => String(r.office_receipt_id)))),
  };
}
