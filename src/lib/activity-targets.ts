import { supabase } from './db/supabaseClient';
import { parseNestedJson, type ActivityPresentationRow } from './activity-presentation';

type Named = { id: string; project_name?: string | null };
type Schedule = Named & { title: string | null; task_type: string | null; project_id: string | null };
type Milestone = { id: string; label: string | null; project_id: string | null };
type Transaction = Named & { item_id: string | null; quantity: number | null; unit: string | null; transaction_type: string | null; project_id: string | null };
type Item = { id: string; name: string | null; unit: string | null };
type Material = { id: string; project_id: string | null; item_name: string | null; specification: string | null; quantity: number | null; unit: string | null; inventory_item_id: string | null };
type Supply = Named & { project_id: string | null; new_model: string | null; old_model: string | null; quantity: number | null; unit: string | null; inventory_item_id: string | null };
type Arrival = { id: string; project_id: string | null };
type ArrivalLine = { id: string; arrival_id: string | null; inventory_item_id: string | null; quantity: number | null; unit: string | null };
type ArrivalMatch = { id: string; arrival_line_id: string | null; project_material_id: string | null; se_supply_record_id: string | null };
type Receipt = { id: string; project_material_id: string | null; se_supply_record_id: string | null; inventory_transaction_id: string | null; arrival_line_id: string | null; quantity_received: number | null };
type Project = { id: string; project_name: string | null };

export type ActivityTargetData = {
  schedules: Map<string, Schedule>;
  milestones: Map<string, Milestone>;
  transactions: Map<string, Transaction>;
  items: Map<string, Item>;
  materials: Map<string, Material>;
  supplies: Map<string, Supply>;
  arrivals: Map<string, Arrival>;
  lines: Map<string, ArrivalLine>;
  matches: Map<string, ArrivalMatch>;
  receipts: Map<string, Receipt>;
  projects: Map<string, Project>;
};
export type BusinessTarget = { lines: string[]; recognized: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mapRows = <T extends { id: string }>(rows: T[]) => new Map(rows.map(row => [row.id, row]));
const validIds = (ids: Iterable<string | null | undefined>) => Array.from(new Set(Array.from(ids).filter((id): id is string => !!id && UUID.test(id))));
const nonempty = (value: unknown): string | null => typeof value === 'string' && value.trim() && !UUID.test(value.trim()) ? value.trim() : null;
const object = (value: unknown): Record<string, unknown> | null => {
  const parsed = parseNestedJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
};
const textAt = (value: Record<string, unknown> | null, key: string) => nonempty(value?.[key]);
const idAt = (value: Record<string, unknown> | null, key: string) => {
  const id = value?.[key];
  return typeof id === 'string' && UUID.test(id) ? id : null;
};

function snapshots(row: ActivityPresentationRow): Record<string, unknown>[] {
  const changes = object(row.changes);
  return [object(changes?.after ?? row.after_value), object(changes?.before ?? row.before_value)]
    .filter((value): value is Record<string, unknown> => value !== null);
}

// Only explicit foreign-key fields in the audit snapshot are used; names never join records.
function references(row: ActivityPresentationRow) {
  const ids = {
    projects: new Set<string>(), items: new Set<string>(), materials: new Set<string>(),
    supplies: new Set<string>(), arrivals: new Set<string>(),
  };
  if (row.project_id && UUID.test(row.project_id)) ids.projects.add(row.project_id);
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) { value.forEach(part => visit(part, depth + 1)); return; }
    const entry = object(value);
    if (!entry) return;
    for (const [field, bucket] of [
      ['project_id', ids.projects], ['item_id', ids.items],
      ['inventory_item_id', ids.items], ['project_material_id', ids.materials],
      ['se_supply_record_id', ids.supplies], ['arrival_id', ids.arrivals],
    ] as const) {
      const id = idAt(entry, field);
      if (id) bucket.add(id);
    }
    for (const part of Object.values(entry)) if (part && typeof part === 'object') visit(part, depth + 1);
  };
  snapshots(row).forEach(snapshot => visit(snapshot, 0));
  return ids;
}

function unique(values: Iterable<string | null | undefined>): string[] {
  return Array.from(new Set(Array.from(values).filter((value): value is string => !!value)));
}

function snapshotNames(value: unknown, fields: string[], depth = 0): string[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.flatMap(part => snapshotNames(part, fields, depth + 1));
  const entry = object(value);
  if (!entry) return [];
  return unique([
    ...fields.map(field => textAt(entry, field)),
    ...Object.values(entry).flatMap(part =>
      part && typeof part === 'object' ? snapshotNames(part, fields, depth + 1) : []),
  ]);
}

async function batch<T extends { id: string }>(
  table: string, columns: string, field: string, ids: Iterable<string | null | undefined>,
): Promise<Map<string, T>> {
  const keys = validIds(ids);
  if (!keys.length) return new Map();
  const { data, error } = await supabase.from(table).select(columns).in(field, keys);
  // Missing SELECT permission or a deleted canonical row leaves the audit record readable.
  return error ? new Map() : mapRows((data || []) as unknown as T[]);
}

export async function loadActivityTargetData(rows: ActivityPresentationRow[]): Promise<ActivityTargetData> {
  const refs = rows.map(references);
  const targetIds = (type: string) => rows.filter(row => row.target_type === type).map(row => row.target_id);
  const arrivalIds = validIds([
    ...rows.filter(row => row.action === 'ARRIVAL_CREATED' || row.action === 'ARRIVAL_METADATA').map(row => row.target_id),
    ...refs.flatMap(ref => Array.from(ref.arrivals)),
  ]);
  const lineIds = rows.filter(row => row.action === 'ARRIVAL_STAGED' || row.action === 'ARRIVAL_FIRST_POST').map(row => row.target_id);
  const directTransactionIds = rows.filter(row =>
    row.target_type === 'INVENTORY_TRANSACTION' &&
    ['CREATE_TRANSACTION', 'VOID_TRANSACTION', 'REVERSE_IN', 'REENTER_IN', 'ARRIVAL_ROUTE_POST'].includes(row.action),
  ).map(row => row.target_id);
  const [schedules, milestones, transactions, directMaterials, directSupplies, arrivals, directLines, arrivalLines, matches, receipts] = await Promise.all([
    batch<Schedule>('schedule_tasks', 'id,title,task_type,project_id,project_name', 'id', targetIds('ScheduleTask')),
    batch<Milestone>('project_milestones', 'id,label,project_id', 'id', targetIds('PROJECT_MILESTONE')),
    batch<Transaction>('inventory_transactions', 'id,item_id,quantity,unit,transaction_type,project_id,project_name', 'id', directTransactionIds),
    batch<Material>('project_materials', 'id,project_id,item_name,specification,quantity,unit,inventory_item_id', 'id',
      rows.filter(row => row.action === 'DELETE_RECEIVING_PENDING').map(row => row.target_id)),
    batch<Supply>('se_supply_records', 'id,project_id,project_name,new_model,old_model,quantity,unit,inventory_item_id', 'id',
      rows.filter(row => row.action === 'DELETE_RECEIVING_PENDING' || row.action === 'RESERVE_INVENTORY_FOR_SE').map(row => row.target_id)),
    batch<Arrival>('receiving_arrivals', 'id,project_id', 'id', arrivalIds),
    batch<ArrivalLine>('receiving_arrival_lines', 'id,arrival_id,inventory_item_id,quantity,unit', 'id', lineIds),
    batch<ArrivalLine>('receiving_arrival_lines', 'id,arrival_id,inventory_item_id,quantity,unit', 'arrival_id', arrivalIds),
    batch<ArrivalMatch>('receiving_arrival_matches', 'id,arrival_line_id,project_material_id,se_supply_record_id', 'id',
      rows.filter(row => row.action === 'ARRIVAL_MATCH').map(row => row.target_id)),
    batch<Receipt>('material_receipts', 'id,project_material_id,se_supply_record_id,inventory_transaction_id,arrival_line_id,quantity_received', 'id',
      rows.filter(row => ['RECEIVING_INVENTORY', 'DELIVER_INVENTORY_TO_PROJECT', 'ROUTE_RECEIVING'].includes(row.action)).map(row => row.target_id)),
  ]);
  const matchedLines = await batch<ArrivalLine>(
    'receiving_arrival_lines', 'id,arrival_id,inventory_item_id,quantity,unit', 'id',
    [...Array.from(matches.values()).map(match => match.arrival_line_id), ...Array.from(receipts.values()).map(receipt => receipt.arrival_line_id)],
  );
  const lines = new Map<string, ArrivalLine>(Array.from(directLines).concat(Array.from(arrivalLines), Array.from(matchedLines)));
  const [linkedTransactions, linkedArrivals] = await Promise.all([
    batch<Transaction>('inventory_transactions', 'id,item_id,quantity,unit,transaction_type,project_id,project_name', 'id',
      Array.from(receipts.values()).map(receipt => receipt.inventory_transaction_id)),
    batch<Arrival>('receiving_arrivals', 'id,project_id', 'id',
      Array.from(lines.values()).map(line => line.arrival_id)),
  ]);
  linkedTransactions.forEach((value, key) => transactions.set(key, value));
  linkedArrivals.forEach((value, key) => arrivals.set(key, value));
  const relatedMaterials = await batch<Material>(
    'project_materials', 'id,project_id,item_name,specification,quantity,unit,inventory_item_id', 'id',
    [...refs.flatMap(ref => Array.from(ref.materials)), ...Array.from(matches.values()).map(match => match.project_material_id),
      ...Array.from(receipts.values()).map(receipt => receipt.project_material_id)],
  );
  const materials = new Map<string, Material>(Array.from(directMaterials).concat(Array.from(relatedMaterials)));
  const relatedSupplies = await batch<Supply>(
    'se_supply_records', 'id,project_id,project_name,new_model,old_model,quantity,unit,inventory_item_id', 'id',
    [...refs.flatMap(ref => Array.from(ref.supplies)), ...Array.from(matches.values()).map(match => match.se_supply_record_id),
      ...Array.from(receipts.values()).map(receipt => receipt.se_supply_record_id)],
  );
  const supplies = new Map<string, Supply>(Array.from(directSupplies).concat(Array.from(relatedSupplies)));
  const projectIds = [
    ...refs.flatMap(ref => Array.from(ref.projects)),
    ...[...Array.from(schedules.values()), ...Array.from(milestones.values()), ...Array.from(transactions.values()),
      ...Array.from(materials.values()), ...Array.from(supplies.values()), ...Array.from(arrivals.values())].map(value => value.project_id),
  ];
  const itemIds = [
    ...refs.flatMap(ref => Array.from(ref.items)),
    ...Array.from(transactions.values()).map(value => value.item_id),
    ...[...Array.from(materials.values()), ...Array.from(supplies.values()), ...Array.from(lines.values())].map(value => value.inventory_item_id),
  ];
  const [projects, items] = await Promise.all([
    batch<Project>('projects', 'id,project_name', 'id', projectIds),
    batch<Item>('inventory_items', 'id,name,unit', 'id', itemIds),
  ]);
  return { schedules, milestones, transactions, items, materials, supplies, arrivals, lines, matches, receipts, projects };
}

function quantityLine(quantity: unknown, unit: unknown, transactionType?: string | null): string | null {
  if (quantity === null || quantity === undefined || quantity === '') return null;
  const amount = typeof quantity === 'number' || typeof quantity === 'string' ? String(quantity) : null;
  if (!amount || !/^\d+(?:\.\d+)?$/.test(amount)) return null;
  const kind: Record<string, string> = { IN: '入庫', OUT: '出庫', RETURN: '退料', ADJUST: '調整', IN_REVERSAL: '入庫沖銷' };
  return [transactionType ? kind[transactionType] || '異動' : '異動', amount, nonempty(unit) || ''].filter(Boolean).join(' ');
}

export function resolveBusinessTarget(row: ActivityPresentationRow, data: ActivityTargetData): BusinessTarget {
  const refs = references(row);
  const snapshot = snapshots(row)[0] || null;
  const original = snapshots(row)[1] || null;
  const named = (...values: unknown[]) => unique(values.map(nonempty));
  const projectIds = new Set(Array.from(refs.projects));
  const itemIds = new Set(Array.from(refs.items));
  const materialIds = new Set(Array.from(refs.materials));
  const supplyIds = new Set(Array.from(refs.supplies));
  const transaction = data.transactions.get(row.target_id);
  const schedule = data.schedules.get(row.target_id);
  const milestone = data.milestones.get(row.target_id);
  const arrival = data.arrivals.get(row.target_id);
  const directLine = data.lines.get(row.target_id);
  const match = data.matches.get(row.target_id);
  const receipt = data.receipts.get(row.target_id);
  if (transaction?.project_id) projectIds.add(transaction.project_id);
  if (transaction?.item_id) itemIds.add(transaction.item_id);
  if (schedule?.project_id && UUID.test(schedule.project_id)) projectIds.add(schedule.project_id);
  if (milestone?.project_id) projectIds.add(milestone.project_id);
  if (arrival?.project_id) projectIds.add(arrival.project_id);
  if (directLine?.inventory_item_id) itemIds.add(directLine.inventory_item_id);
  if (directLine?.arrival_id) {
    const linkedArrival = data.arrivals.get(directLine.arrival_id);
    if (linkedArrival?.project_id) projectIds.add(linkedArrival.project_id);
  }
  if (match?.project_material_id) materialIds.add(match.project_material_id);
  if (match?.se_supply_record_id) supplyIds.add(match.se_supply_record_id);
  if (receipt?.project_material_id) materialIds.add(receipt.project_material_id);
  if (receipt?.se_supply_record_id) supplyIds.add(receipt.se_supply_record_id);
  if (receipt?.inventory_transaction_id) {
    const linkedTransaction = data.transactions.get(receipt.inventory_transaction_id);
    if (linkedTransaction?.item_id) itemIds.add(linkedTransaction.item_id);
  }
  if (receipt?.arrival_line_id) {
    const line = data.lines.get(receipt.arrival_line_id);
    if (line?.inventory_item_id) itemIds.add(line.inventory_item_id);
    if (line?.arrival_id) {
      const linkedArrival = data.arrivals.get(line.arrival_id);
      if (linkedArrival?.project_id) projectIds.add(linkedArrival.project_id);
    }
  }
  if (match?.arrival_line_id) {
    const line = data.lines.get(match.arrival_line_id);
    if (line?.inventory_item_id) itemIds.add(line.inventory_item_id);
    if (line?.arrival_id) {
      const linkedArrival = data.arrivals.get(line.arrival_id);
      if (linkedArrival?.project_id) projectIds.add(linkedArrival.project_id);
    }
  }
  if (row.action === 'ARRIVAL_CREATED' || row.action === 'ARRIVAL_METADATA') {
    Array.from(data.lines.values()).forEach(line => {
      if (line.arrival_id === row.target_id && line.inventory_item_id) itemIds.add(line.inventory_item_id);
    });
  }
  if (row.action === 'DELETE_RECEIVING_PENDING' || row.action === 'RESERVE_INVENTORY_FOR_SE') {
    if (data.materials.has(row.target_id)) materialIds.add(row.target_id);
    if (data.supplies.has(row.target_id)) supplyIds.add(row.target_id);
  }
  Array.from(materialIds).forEach(id => {
    const material = data.materials.get(id);
    if (material?.project_id) projectIds.add(material.project_id);
    if (material?.inventory_item_id) itemIds.add(material.inventory_item_id);
  });
  Array.from(supplyIds).forEach(id => {
    const supply = data.supplies.get(id);
    if (supply?.project_id) projectIds.add(supply.project_id);
    if (supply?.inventory_item_id) itemIds.add(supply.inventory_item_id);
  });
  const snapshotProjects = named(...snapshotNames(snapshot, ['project_name']),
    ...snapshotNames(original, ['project_name']), row.project_name);
  const canonicalProjects = unique(Array.from(projectIds).map(id => nonempty(data.projects.get(id)?.project_name)));
  const linkedProjectNames = unique(Array.from(supplyIds).map(id => nonempty(data.supplies.get(id)?.project_name)));
  const project = projectIds.size > 1 || snapshotProjects.length > 1 || canonicalProjects.length > 1 || linkedProjectNames.length > 1
    ? null : snapshotProjects[0] || canonicalProjects[0] || linkedProjectNames[0]
      || nonempty(schedule?.project_name) || nonempty(transaction?.project_name) || null;
  const label = nonempty(row.target_label);
  const validLabel = label && label !== row.action && label !== row.action_type && label !== row.target_type ? label : null;

  if (row.target_type === 'ScheduleTask') {
    const task = named(validLabel, textAt(snapshot, 'title'), textAt(original, 'title'), schedule?.title)[0];
    return { lines: [project || '無法辨識案場', task || '無法辨識對象'], recognized: !!task };
  }
  if (row.target_type === 'PROJECT_MILESTONE' || row.target_type === 'PROJECT_WORKFLOW') {
    const work = named(validLabel, milestone?.label)[0] || (row.target_type === 'PROJECT_WORKFLOW' ? '案場流程' : null);
    return { lines: [project || '無法辨識案場', work || '無法辨識對象'], recognized: !!work };
  }
  if (row.target_type === 'INVENTORY_TRANSACTION') {
    const materials = unique(Array.from(materialIds).map(id => {
      const material = data.materials.get(id);
      return nonempty(material?.item_name) || nonempty(material?.specification);
    }));
    const models = unique(Array.from(supplyIds).map(id => nonempty(data.supplies.get(id)?.new_model)));
    const inventoryNames = unique(Array.from(itemIds).map(id => nonempty(data.items.get(id)?.name)));
    const auditNames = unique([
      ...snapshotNames(snapshot, ['item_name', 'material_name', 'new_model']),
      ...snapshotNames(original, ['item_name', 'material_name', 'new_model']),
    ]);
    const names = auditNames.length ? auditNames : materials.length ? materials : models.length ? models : inventoryNames;
    // Different item IDs can share a model name, but never resolve one ID from that name.
    const item = names.length === 1 ? names[0] : names.length > 1 ? names.join('、') : null;
    const quantity = quantityLine(snapshot?.quantity ?? original?.quantity ?? transaction?.quantity,
      snapshot?.unit ?? original?.unit ?? transaction?.unit,
      String(snapshot?.transaction_type ?? original?.transaction_type ?? transaction?.transaction_type ?? ''));
    if (row.action === 'CREATE_TRANSACTION' || row.action === 'VOID_TRANSACTION' || row.action === 'REVERSE_IN' || row.action === 'REENTER_IN') {
      return { lines: [item || '無法辨識對象', quantity].filter((line): line is string => !!line), recognized: !!item };
    }
    return { lines: [project || '無法辨識案場', item || '無法辨識對象'], recognized: !!item };
  }
  return { lines: [validLabel || textAt(snapshot, 'title') || textAt(original, 'title') || '無法辨識對象'], recognized: !!validLabel };
}
