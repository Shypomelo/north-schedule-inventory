import { receivingHistory, type ReceivingHistoryRow, type ReceivingV6Snapshot } from './receiving-v6';

export type AllocationState = '待分配' | '部分分配' | '已分配' | '已取消到貨' | '無法確認';
export interface ReceivingLedgerRow {
  event: ReceivingHistoryRow;
  source: string;
  state: AllocationState;
  original: number | null;
  effective: number | null;
  allocated: number | null;
  unallocated: number | null;
  destinations: { label: string; quantity: number }[];
  serials: string[];
  history: { id: string; at: string; label: string; quantity: number; reason: string | null }[];
}

const sourceName: Record<string, string> = {
  PROJECT_MATERIAL: '案場物料', SE_SUPPLY: '既有 SE 供貨', ARRIVAL: '實際到貨', ARRIVAL_ROUTE: '實際到貨',
};

export function receivingLedger(data: ReceivingV6Snapshot): ReceivingLedgerRow[] {
  const recorded = receivingHistory(data);
  const allocationEvents: ReceivingHistoryRow[] = [];
  for (const [receiptId, scope] of Object.entries(data.scopes)) {
    const parent = recorded.find(value => value.receiptId === receiptId);
    if (!parent) continue;
    for (const allocation of scope.allocations) {
      const serial = data.inventorySerials.find(value => value.id === allocation.inventory_serial_id);
      const serials = serial ? [{ entryId: '', inventorySerialId: serial.id, serialNumber: serial.serial_number }] : [];
      const base: ReceivingHistoryRow = { ...parent, receiptId, transactionId: null, serials, reversibleSerials: [], reversibleQuantity: 0, returnToReceived: false };
      allocationEvents.push({ ...base, id: `allocation:${allocation.id}`, at: allocation.created_at,
        type: allocation.supersedes_allocation_id ? '分配更正' : '分配', state: allocation.route_type,
        quantity: Number(allocation.quantity) });
      if (allocation.cancelled_at) allocationEvents.push({ ...base, id: `allocation-cancel:${allocation.id}`,
        at: allocation.cancelled_at, type: '分配撤回', state: allocation.route_type, quantity: -Number(allocation.quantity) });
    }
  }
  const events = [...recorded, ...allocationEvents].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  const byId = new Map(data.receipts.map(receipt => [receipt.id, receipt]));
  return events.map(event => {
    const line = data.lines.find(value => value.id === event.arrivalLineId);
    const receipt = event.receiptId ? byId.get(event.receiptId) : undefined;
    const cancellations = data.cancellations.filter(value => value.arrival_line_id === line?.id);
    const isPhysical = event.type === '實際到貨' || event.type === '取消實際到貨';
    const original = isPhysical && line ? Number(line.quantity)
      : receipt?.event_type === 'RECEIVE' ? Number(receipt.quantity_received) : null;
    const effective = isPhysical && line ? Number(line.quantity) - cancellations.reduce((sum, value) => sum + Number(value.quantity), 0)
      : receipt?.event_type === 'RECEIVE' ? Number(receipt.quantity_received)
        - data.receipts.filter(value => value.event_type === 'REVERSAL' && value.reversal_of_id === receipt.id)
          .reduce((sum, value) => sum + Number(value.quantity_received), 0) : null;
    const serials = event.type === '取消實際到貨' && line
      ? data.observations.filter(value => value.arrival_line_id === line.id && cancellations.some(cancel => `cancel:${cancel.id}` === event.id && cancel.entry_ids.includes(value.id)))
        .map(value => value.normalized_serial)
      : event.type === '實際到貨' && line
        ? data.observations.filter(value => value.arrival_line_id === line.id).map(value => value.normalized_serial)
        : event.serials.map(value => value.serialNumber);
    const related = line ? events.filter(value => value.arrivalLineId === line.id) : receipt
      ? events.filter(value => value.receiptId === receipt.id || (value.receiptId && byId.get(value.receiptId)?.reversal_of_id === receipt.id)) : [event];
    const history = related.map(value => ({
      id: value.id, at: value.at, label: value.type, quantity: value.quantity,
      reason: value.id.startsWith('cancel:') ? data.cancellations.find(cancel => `cancel:${cancel.id}` === value.id)?.reason || null
        : value.receiptId ? byId.get(value.receiptId)?.notes || null : null,
    }));
    let state: AllocationState = '無法確認';
    let allocated: number | null = null, unallocated: number | null = null;
    let destinations: ReceivingLedgerRow['destinations'] = [];
    if (event.type === '取消實際到貨' || (event.type === '實際到貨' && effective !== null && effective <= 0)) state = '已取消到貨';
    else if (event.type === '實際到貨' && line && effective !== null && effective > 0) {
      const posted = data.receipts.some(value => value.event_type === 'RECEIVE'
        && (value.arrival_line_id === line.id || value.route_arrival_line_id === line.id));
      if (!posted) { state = '待分配'; allocated = 0; unallocated = effective; }
    } else if (receipt?.event_type === 'RECEIVE' && receipt.receipt_location === 'SITE') {
      allocated = effective; unallocated = 0; state = '已分配';
      destinations = [{ label: event.projectLabel === '未指定案件' ? '案場' : event.projectLabel, quantity: effective || 0 }];
    } else if (receipt?.event_type === 'RECEIVE' && receipt.receipt_location === 'OFFICE' && receipt.inventory_linked) {
      const scope = data.scopes[receipt.id];
      if (scope && !data.scopeErrors[receipt.id]) {
        destinations = scope.allocations.filter(value => !value.cancelled_at).map(value => {
          const route = value.route_type === 'SE' ? 'SE 供貨追蹤' : value.route_type === 'PROJECT_PREP' ? '案場備料' : '案場送達';
          const projectId = data.supplies.find(source => source.id === value.se_supply_record_id)?.project_id
            || data.materials.find(source => source.id === value.project_material_id)?.project_id
            || data.transactions.find(tx => tx.id === value.inventory_transaction_id)?.project_id;
          const project = data.projects.find(candidate => candidate.id === projectId);
          return { label: project ? `${route} · ${project.name}` : route, quantity: Number(value.quantity) };
        });
        allocated = destinations.reduce((sum, value) => sum + value.quantity, 0);
        // "other" includes stock effects whose destination cannot be attributed to this receipt.
        if (Number(scope.other) === 0 && allocated <= Number(scope.received)) {
          unallocated = Number(scope.received) - allocated;
          state = allocated === 0 ? '待分配' : unallocated === 0 ? '已分配' : '部分分配';
        }
      }
    }
    return { event, source: receipt ? sourceName[receipt.source_type] || receipt.source_type : '實際到貨',
      state, original, effective, allocated, unallocated, destinations, serials: Array.from(new Set(serials)), history };
  });
}
