import type { MaterialReceipt } from './db/types';
import type { ReceivingSourceDetails } from './db/receiving-routing';

export function receiptRouteSummary(receipt: MaterialReceipt, data: ReceivingSourceDetails) {
  const reversed = data.receipts.filter(r => r.event_type === 'REVERSAL' && r.reversal_of_id === receipt.id).reduce((n, r) => n + Number(r.quantity_received), 0);
  const quantity = Math.max(0, Number(receipt.quantity_received) - reversed);
  const allocations = data.allocations.filter(a => a.office_receipt_id === receipt.id && !a.cancelled_at);
  const entries = data.entries.filter(e => e.active_receipt_id === receipt.id && !e.retired_at);
  const serials = data.serials.filter(s => entries.some(e => e.inventory_serial_id === s.id));
  const reserved = data.seRecords.filter(s => s.inventory_serial_id && !s.cancelled_at && !s.receiving_only);
  const availableSerials = serials.filter(s => s.status === '在庫' && !allocations.some(a => a.inventory_serial_id === s.id) && !reserved.some(r => r.inventory_serial_id === s.id));
  const se = allocations.filter(a => a.route_type === 'SE').reduce((n, a) => n + Number(a.quantity), 0);
  const site = allocations.filter(a => a.route_type === 'SITE').reduce((n, a) => n + Number(a.quantity), 0);
  const serialized = data.links.some(l => l.receipt_id === receipt.id);
  // Never present an already-used legacy identity as available stock.
  const stock = serialized ? availableSerials.length : Math.max(0, quantity - se - site);
  return { quantity, reversed, allocations, serials, availableSerials, se, site, stock, serialized, other: Math.max(0, quantity - stock - se - site) };
}
