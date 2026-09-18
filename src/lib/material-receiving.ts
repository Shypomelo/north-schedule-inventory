import type {
  MaterialReceipt,
  MaterialReceiptSourceType,
  Project,
  ProjectMaterial,
  ProjectMaterialBatch,
  SESupplyRecord,
  User,
} from './db/types';
import { getEffectiveExpectedDeliveryAt } from './material-receipt-time';

export interface PendingReceivingItem {
  sourceType: MaterialReceiptSourceType;
  sourceId: string;
  expectedDeliveryAt: string | null;
  sourceLabel: '案場物料' | 'SE';
  contextLabel: string;
  projectId: string | null;
  batchId: string | null;
  batchName: string | null;
  batchSameDayDelivery: boolean | null;
  groupingIdentity: string;
  itemLabel: string;
  quantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
  unit: string;
  status: 'PENDING' | 'PARTIAL_RECEIVED' | 'RECEIVED';
  lastReceivedAt: string | null;
  receivedByLabels: string[];
}

export interface ReceiptHistoryItem {
  receipt: MaterialReceipt;
  sourceLabel: '案場物料' | 'SE';
  contextLabel: string;
  projectId: string | null;
  itemLabel: string;
  unit: string;
  receivedByLabel: string;
  reversibleQuantity: number;
}

export const getReceiptEventType = (receipt: MaterialReceipt): 'RECEIVE' | 'REVERSAL' => (
  receipt.event_type === 'REVERSAL' ? 'REVERSAL' : 'RECEIVE'
);

export const receiptQuantityEffect = (receipt: MaterialReceipt): number => (
  getReceiptEventType(receipt) === 'REVERSAL'
    ? -Number(receipt.quantity_received)
    : Number(receipt.quantity_received)
);

export const getSourceReceivedQuantity = (
  receipts: MaterialReceipt[],
  sourceType: MaterialReceiptSourceType,
  sourceId: string,
): number => receipts.reduce((total, receipt) => {
  if (receipt.source_type !== sourceType) return total;
  const receiptSourceId = sourceType === 'PROJECT_MATERIAL'
    ? receipt.project_material_id
    : receipt.se_supply_record_id;
  return receiptSourceId === sourceId ? total + receiptQuantityEffect(receipt) : total;
}, 0);

export const getReceiptReversibleQuantity = (
  receipt: MaterialReceipt,
  receipts: MaterialReceipt[],
): number => {
  if (getReceiptEventType(receipt) !== 'RECEIVE') return 0;
  const reversed = receipts.reduce((total, candidate) => (
    getReceiptEventType(candidate) === 'REVERSAL' && candidate.reversal_of_id === receipt.id
      ? total + Number(candidate.quantity_received)
      : total
  ), 0);
  return Math.max(0, Number(receipt.quantity_received) - reversed);
};

export interface MaterialReceiptSummary {
  effectiveQuantity: number;
  status: 'PENDING' | 'PARTIAL_RECEIVED' | 'RECEIVED';
  lastReceivedAt: string | null;
}

export function summarizeMaterialReceipts(
  receipts: MaterialReceipt[],
  sourceType: MaterialReceiptSourceType,
  sourceId: string,
  requestedQuantity: number,
): MaterialReceiptSummary {
  const sourceReceipts = receipts.filter(receipt => {
    if (receipt.source_type !== sourceType) return false;
    return sourceType === 'PROJECT_MATERIAL'
      ? receipt.project_material_id === sourceId
      : receipt.se_supply_record_id === sourceId;
  });
  const effectiveQuantity = Math.max(0, sourceReceipts.reduce(
    (total, receipt) => total + receiptQuantityEffect(receipt),
    0,
  ));
  const status = effectiveQuantity <= 0
    ? 'PENDING'
    : effectiveQuantity < requestedQuantity
      ? 'PARTIAL_RECEIVED'
      : 'RECEIVED';
  const lastReceivedAt = sourceReceipts
    .filter(receipt => getReceiptEventType(receipt) === 'RECEIVE')
    .map(receipt => receipt.received_at)
    .sort((left, right) => right.localeCompare(left))[0] || null;
  return { effectiveQuantity, status, lastReceivedAt };
}

const projectNameFor = (projectById: Map<string, Project>, projectId: string | null): string => (
  projectId ? projectById.get(projectId)?.name || '未知案場' : ''
);

const memberNameFor = (memberById: Map<string, User>, memberId: string | null): string => (
  memberId ? memberById.get(memberId)?.name || '未知成員' : '未指定'
);

const materialLabel = (material: ProjectMaterial): string => {
  const name = material.item_name.trim();
  const specification = material.specification?.trim() || '';
  return specification && specification !== name ? `${name}｜${specification}` : specification || name;
};

const seLabel = (record: SESupplyRecord): string => (
  record.new_model?.trim() || record.old_model?.trim() || ''
);

const compareNullableDate = (left: string | null, right: string | null): number => {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
};

const getTaipeiDateKey = (value: string | null): string => {
  if (!value) return 'unscheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unscheduled';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find(part => part.type === type)?.value || ''
  );
  return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
};

const sourceReceiptsFor = (
  receipts: MaterialReceipt[],
  sourceType: MaterialReceiptSourceType,
  sourceId: string,
): MaterialReceipt[] => receipts.filter(receipt => {
  if (receipt.source_type !== sourceType) return false;
  return sourceType === 'PROJECT_MATERIAL'
    ? receipt.project_material_id === sourceId
    : receipt.se_supply_record_id === sourceId;
});

const receivedByLabelsFor = (
  receipts: MaterialReceipt[],
  memberById: Map<string, User>,
): string[] => Array.from(new Set(receipts
  .filter(receipt => getReceiptEventType(receipt) === 'RECEIVE')
  .map(receipt => memberNameFor(memberById, receipt.received_by))));

export function selectReceivingItems({
  projects,
  batches,
  projectMaterials,
  seRecords,
  receipts,
  users,
}: {
  projects: Project[];
  batches: ProjectMaterialBatch[];
  projectMaterials: ProjectMaterial[];
  seRecords: SESupplyRecord[];
  receipts: MaterialReceipt[];
  users: User[];
}): PendingReceivingItem[] {
  const projectById = new Map(projects.map(project => [project.id, project]));
  const batchById = new Map(batches.map(batch => [batch.id, batch]));
  const memberById = new Map(users.map(user => [user.id, user]));

  const projectItems = projectMaterials.flatMap(material => {
    if (material.delivery_destination !== 'OFFICE' || material.receiving_archived_at) return [];
    const sourceReceipts = sourceReceiptsFor(receipts, 'PROJECT_MATERIAL', material.id);
    const receiptSummary = summarizeMaterialReceipts(
      receipts,
      'PROJECT_MATERIAL',
      material.id,
      Number(material.quantity),
    );
    const isLegacyReceived = sourceReceipts.length === 0 && (
      material.procurement_status === 'RECEIVED' || Boolean(material.received_at)
    );
    const receivedQuantity = isLegacyReceived
      ? Number(material.quantity)
      : receiptSummary.effectiveQuantity;
    const remainingQuantity = Math.max(0, Number(material.quantity) - receivedQuantity);
    const batch = batchById.get(material.batch_id);
    const expectedDeliveryAt = batch ? getEffectiveExpectedDeliveryAt(material, batch) : material.expected_delivery_at;
    return [{
      sourceType: 'PROJECT_MATERIAL' as const,
      sourceId: material.id,
      expectedDeliveryAt,
      sourceLabel: '案場物料' as const,
      contextLabel: projectNameFor(projectById, material.project_id),
      projectId: material.project_id,
      batchId: material.batch_id,
      batchName: batch?.batch_name || null,
      batchSameDayDelivery: batch?.same_day_delivery ?? null,
      groupingIdentity: material.project_id,
      itemLabel: materialLabel(material),
      quantity: Number(material.quantity),
      receivedQuantity,
      remainingQuantity,
      unit: material.unit,
      status: remainingQuantity <= 0
        ? 'RECEIVED' as const
        : receivedQuantity > 0
          ? 'PARTIAL_RECEIVED' as const
          : 'PENDING' as const,
      lastReceivedAt: isLegacyReceived ? material.received_at : receiptSummary.lastReceivedAt,
      receivedByLabels: receivedByLabelsFor(sourceReceipts, memberById),
    }];
  });

  const seItems = seRecords.flatMap(record => {
    if (record.receiving_archived_at) return [];
    const itemLabel = seLabel(record);
    if (!itemLabel) return [];
    const sourceReceipts = sourceReceiptsFor(receipts, 'SE_SUPPLY', record.id);
    const receiptSummary = summarizeMaterialReceipts(
      receipts,
      'SE_SUPPLY',
      record.id,
      Number(record.quantity),
    );
    const isLegacyReceived = sourceReceipts.length === 0 && (
      record.procurement_status === 'RECEIVED'
      || Boolean(record.received_at)
      || Boolean(record.receive_date)
    );
    const receivedQuantity = isLegacyReceived
      ? Number(record.quantity)
      : receiptSummary.effectiveQuantity;
    const remainingQuantity = Math.max(0, Number(record.quantity) - receivedQuantity);
    const projectLabel = projectNameFor(projectById, record.project_id);
    const applicantLabel = memberNameFor(memberById, record.requested_by);
    return [{
      sourceType: 'SE_SUPPLY' as const,
      sourceId: record.id,
      expectedDeliveryAt: record.expected_delivery_at,
      sourceLabel: 'SE' as const,
      contextLabel: projectLabel
        ? `${projectLabel}｜${applicantLabel}`
        : applicantLabel,
      projectId: record.project_id,
      batchId: null,
      batchName: null,
      batchSameDayDelivery: null,
      groupingIdentity: record.project_id || `applicant:${record.requested_by || record.id}`,
      itemLabel,
      quantity: Number(record.quantity),
      receivedQuantity,
      remainingQuantity,
      unit: record.unit,
      status: remainingQuantity <= 0
        ? 'RECEIVED' as const
        : receivedQuantity > 0
          ? 'PARTIAL_RECEIVED' as const
          : 'PENDING' as const,
      lastReceivedAt: isLegacyReceived
        ? record.received_at || (record.receive_date ? `${record.receive_date}T00:00:00+08:00` : null)
        : receiptSummary.lastReceivedAt,
      receivedByLabels: receivedByLabelsFor(sourceReceipts, memberById),
    }];
  });

  return [...projectItems, ...seItems].sort((left, right) => (
    compareNullableDate(left.expectedDeliveryAt, right.expectedDeliveryAt)
    || left.sourceLabel.localeCompare(right.sourceLabel, 'zh-TW')
    || left.contextLabel.localeCompare(right.contextLabel, 'zh-TW')
    || left.itemLabel.localeCompare(right.itemLabel, 'zh-TW')
  ));
}

export function selectPendingReceivingItems(
  input: Parameters<typeof selectReceivingItems>[0],
): PendingReceivingItem[] {
  return selectReceivingItems(input).filter(item => item.status !== 'RECEIVED');
}

export interface PendingReceivingGroup {
  key: string;
  sourceLabel: '案場物料' | 'SE' | '混合';
  contextLabel: string;
  batchName: string | null;
  expectedDeliveryAt: string | null;
  receiptDateKey: string;
  status: 'PENDING' | 'PARTIAL_RECEIVED' | 'RECEIVED';
  completedAt: string | null;
  receivedByLabels: string[];
  items: PendingReceivingItem[];
}

export function groupPendingReceivingItems(items: PendingReceivingItem[]): PendingReceivingGroup[] {
  const groups = new Map<string, PendingReceivingGroup>();
  for (const item of items) {
    const receiptDateKey = getTaipeiDateKey(item.expectedDeliveryAt);
    const key = `${item.groupingIdentity}::${receiptDateKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      if (existing.sourceLabel !== item.sourceLabel) existing.sourceLabel = '混合';
      if (existing.batchName !== item.batchName) existing.batchName = null;
    }
    else groups.set(key, {
      key,
      sourceLabel: item.sourceLabel,
      contextLabel: item.contextLabel,
      batchName: item.batchName,
      expectedDeliveryAt: item.expectedDeliveryAt,
      receiptDateKey,
      status: 'PENDING',
      completedAt: null,
      receivedByLabels: [],
      items: [item],
    });
  }
  return Array.from(groups.values()).map(group => {
    const allReceived = group.items.every(item => item.status === 'RECEIVED');
    const hasReceipts = group.items.some(item => item.receivedQuantity > 0);
    const completedAt = allReceived
      ? group.items.map(item => item.lastReceivedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null
      : null;
    return {
      ...group,
      status: allReceived ? 'RECEIVED' as const : hasReceipts ? 'PARTIAL_RECEIVED' as const : 'PENDING' as const,
      completedAt,
      receivedByLabels: Array.from(new Set(group.items.flatMap(item => item.receivedByLabels))),
    };
  }).sort((left, right) => (
    compareNullableDate(left.expectedDeliveryAt, right.expectedDeliveryAt)
    || left.contextLabel.localeCompare(right.contextLabel, 'zh-TW')
    || (left.batchName || '').localeCompare(right.batchName || '', 'zh-TW')
  ));
}

export const getReceivingGroupStatusLabel = (
  status: PendingReceivingGroup['status'],
): '待收' | '未全' | '已收到' => (
  status === 'RECEIVED' ? '已收到' : status === 'PARTIAL_RECEIVED' ? '未全' : '待收'
);

export const formatTaipeiReceivingDate = (value: string | null): string => {
  if (!value) return '未定';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未定';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

export function filterPendingReceivingItems(
  items: PendingReceivingItem[],
  search: string,
): PendingReceivingItem[] {
  const normalized = search.trim().toLocaleLowerCase('zh-TW');
  if (!normalized) return items;
  return items.filter(item => (
    `${item.contextLabel} ${item.itemLabel}`
      .toLocaleLowerCase('zh-TW')
      .includes(normalized)
  ));
}

export function buildReceiptHistoryItems({
  receipts,
  projectMaterials,
  seRecords,
  projects,
  users,
}: {
  receipts: MaterialReceipt[];
  projectMaterials: ProjectMaterial[];
  seRecords: SESupplyRecord[];
  projects: Project[];
  users: User[];
}): ReceiptHistoryItem[] {
  const materialById = new Map(projectMaterials.map(material => [material.id, material]));
  const seById = new Map(seRecords.map(record => [record.id, record]));
  const projectById = new Map(projects.map(project => [project.id, project]));
  const memberById = new Map(users.map(user => [user.id, user]));

  return receipts.map(receipt => {
    if (receipt.source_type === 'PROJECT_MATERIAL') {
      const material = receipt.project_material_id
        ? materialById.get(receipt.project_material_id)
        : undefined;
      return {
        receipt,
        sourceLabel: '案場物料' as const,
        contextLabel: material
          ? projectNameFor(projectById, material.project_id)
          : '未知案場',
        projectId: material?.project_id || null,
        itemLabel: material ? materialLabel(material) : '未知物料',
      unit: material?.unit || '',
      receivedByLabel: memberNameFor(memberById, receipt.received_by),
      reversibleQuantity: getReceiptReversibleQuantity(receipt, receipts),
      };
    }

    const seRecord = receipt.se_supply_record_id
      ? seById.get(receipt.se_supply_record_id)
      : undefined;
    const projectLabel = seRecord ? projectNameFor(projectById, seRecord.project_id) : '';
    const applicantLabel = seRecord
      ? memberNameFor(memberById, seRecord.requested_by)
      : '未知申請人';
    return {
      receipt,
      sourceLabel: 'SE' as const,
      contextLabel: projectLabel ? `${projectLabel}｜${applicantLabel}` : applicantLabel,
      projectId: seRecord?.project_id || null,
      itemLabel: seRecord ? seLabel(seRecord) || '未知物料' : '未知物料',
      unit: seRecord?.unit || '',
      receivedByLabel: memberNameFor(memberById, receipt.received_by),
      reversibleQuantity: getReceiptReversibleQuantity(receipt, receipts),
    };
  }).sort((left, right) => (
    right.receipt.received_at.localeCompare(left.receipt.received_at)
    || right.receipt.id.localeCompare(left.receipt.id)
  ));
}

export function formatReceivingQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function formatTaipeiReceivingTime(value: string | null): string {
  if (!value) return '未定';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未定';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
