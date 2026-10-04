import { actualRows, projectLabel, type ActualRow, type Arrival, type ArrivalLine } from './receiving-v5';
import { receivedItemGroups, type ReceivedGroup, type ReceivingHistoryRow, type ReceivingV6Snapshot } from './receiving-v6';

export interface ReceivingBatchView {
  id: string; arrival: Arrival; lines: ArrivalLine[]; groups: ReceivedGroup[];
  lineGroups: { key: string; label: string; quantity: number; unit: string; serials: string[] }[];
  label: string; at: string; day: string; project: string;
  total: number; itemCount: number; workCount: number; unresolvedCount: number;
  history: ReceivingHistoryRow[]; searchText: string;
}

export function receivingTaipeiDay(value: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export function receivingBatchViews(data: ReceivingV6Snapshot, history: ReceivingHistoryRow[]): ReceivingBatchView[] {
  const linesByArrival = new Map<string, ArrivalLine[]>();
  for (const line of data.lines) linesByArrival.set(line.arrival_id, [...(linesByArrival.get(line.arrival_id) || []), line]);
  const rowsByArrival = new Map<string, ActualRow[]>();
  for (const row of actualRows(data)) if (row.arrival) rowsByArrival.set(row.arrival.id, [...(rowsByArrival.get(row.arrival.id) || []), row]);
  const historyByLine = new Map<string, ReceivingHistoryRow[]>();
  for (const row of history) if (row.arrivalLineId) historyByLine.set(row.arrivalLineId,
    [...(historyByLine.get(row.arrivalLineId) || []), row]);
  const serialsByLine = new Map<string, string[]>();
  for (const entry of data.observations) if (entry.arrival_line_id) serialsByLine.set(entry.arrival_line_id,
    [...(serialsByLine.get(entry.arrival_line_id) || []), entry.normalized_serial]);
  return data.arrivals.map(arrival => {
    const lines = linesByArrival.get(arrival.id) || [];
    const groups = receivedItemGroups(data, arrival.id, rowsByArrival.get(arrival.id) || []);
    const batchHistory = lines.flatMap(line => historyByLine.get(line.id) || []);
    const labels = lines.map(line => data.items.find(item => item.id === line.inventory_item_id)).filter(Boolean);
    const serials = lines.flatMap(line => serialsByLine.get(line.id) || []);
    const lineGroupsMap = new Map<string, ReceivingBatchView['lineGroups'][number]>();
    for (const line of lines) {
      const key = `${line.inventory_item_id || 'UNRESOLVED'}:${line.unit || ''}`;
      const group = lineGroupsMap.get(key) || { key, label: data.items.find(item => item.id === line.inventory_item_id)?.code || '待確認',
        quantity: 0, unit: line.unit || '', serials: [] };
      group.quantity += Number(line.quantity);
      group.serials.push(...(serialsByLine.get(line.id) || []));
      lineGroupsMap.set(key, group);
    }
    const lineGroups = Array.from(lineGroupsMap.values());
    const at = arrival.actual_received_at || arrival.created_at;
    const label = arrival.batch_kind === 'BOX' ? `箱 ${arrival.batch_position || 1}`
      : arrival.batch_kind === 'LOOSE' ? '散料' : '收貨批次';
    const project = projectLabel(data.projects, arrival.project_id);
    const unresolvedCount = groups.filter(group => group.states.includes('UNRESOLVED'))
      .reduce((sum, group) => sum + group.quantity, 0);
    const workCount = groups.reduce((sum, group) => sum + group.quantity, 0);
    return { id: arrival.id, arrival, lines, groups, lineGroups, label, at, day: receivingTaipeiDay(at), project,
      total: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
      itemCount: new Set(lines.map(line => line.inventory_item_id || 'UNRESOLVED')).size,
      workCount, unresolvedCount, history: batchHistory,
      searchText: [label, receivingTaipeiDay(at), receivingTaipeiDay(at).slice(5).replace('-', '/'), at.slice(0, 10), project, arrival.notes || '',
        ...labels.flatMap(item => [item!.code, item!.name]), ...serials,
        ...batchHistory.flatMap(row => [row.item, row.actor, row.type, row.state, row.projectLabel])].join(' ').toLocaleLowerCase(),
    };
  }).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

export function receivingBatchMatches(batch: ReceivingBatchView, query: string): boolean {
  return batch.searchText.includes(query.trim().toLocaleLowerCase());
}
