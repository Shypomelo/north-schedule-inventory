import type {
  DeliveryDestination,
  MaterialCatalogItem,
  MaterialGroup,
  ProcurementStatus,
  ProjectMaterial,
  ProjectMaterialBatch,
  ProjectMaterialCreateInput,
} from './db/types';

export const DELIVERY_DESTINATION_OPTIONS: ReadonlyArray<{
  value: DeliveryDestination;
  label: string;
}> = [
  { value: 'OFFICE', label: '北辦' },
  { value: 'SITE', label: '案場' },
  { value: 'WAREHOUSE', label: '倉庫出貨' },
  { value: 'OTHER', label: '其他' },
];

export const getDeliveryDestinationLabel = (destination: DeliveryDestination): string => (
  DELIVERY_DESTINATION_OPTIONS.find(option => option.value === destination)?.label || destination
);

export const PROCUREMENT_STATUS_OPTIONS: ReadonlyArray<{
  value: ProcurementStatus;
  label: string;
}> = [
  { value: 'NOT_ORDERED', label: '未叫料' },
  { value: 'ORDERED', label: '已叫料' },
  { value: 'PARTIAL_RECEIVED', label: '部分到貨' },
  { value: 'RECEIVED', label: '已到齊' },
];

export const getProcurementStatusLabel = (status: ProcurementStatus): string => (
  PROCUREMENT_STATUS_OPTIONS.find(option => option.value === status)?.label || status
);

export const UNGROUPED_MATERIAL_CATALOG_VALUE = '__UNGROUPED__';

export const getMaterialCatalogGroups = (items: MaterialCatalogItem[]): string[] => {
  const groups = new Set(items.map(item => item.group_name?.trim() || UNGROUPED_MATERIAL_CATALOG_VALUE));
  return Array.from(groups).sort((left, right) => {
    if (left === UNGROUPED_MATERIAL_CATALOG_VALUE) return 1;
    if (right === UNGROUPED_MATERIAL_CATALOG_VALUE) return -1;
    return left.localeCompare(right, 'zh-TW');
  });
};

export const filterMaterialCatalogByGroup = (
  items: MaterialCatalogItem[],
  group: string,
): MaterialCatalogItem[] => items.filter(item => (
  (item.group_name?.trim() || UNGROUPED_MATERIAL_CATALOG_VALUE) === group
));

export const getActiveMaterialGroups = (groups: MaterialGroup[]): MaterialGroup[] => (
  groups
    .filter(group => group.is_active)
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'zh-TW'))
);

export const filterMaterialCatalogByGroupId = (
  items: MaterialCatalogItem[],
  groupId: string,
): MaterialCatalogItem[] => items
  .filter(item => item.is_active && item.group_id === groupId)
  .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'zh-TW'));

export const filterSelectableMaterialCatalogItems = (
  items: MaterialCatalogItem[],
  groups: MaterialGroup[],
): MaterialCatalogItem[] => {
  const activeGroupIds = new Set(getActiveMaterialGroups(groups).map(group => group.id));
  return items
    .filter(item => item.is_active && item.group_id !== null && activeGroupIds.has(item.group_id))
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'zh-TW'));
};

export const getProjectMaterialGroupLabel = (
  material: Pick<ProjectMaterial, 'catalog_item_id'>,
  catalog: MaterialCatalogItem[],
  groups: MaterialGroup[],
): string => {
  if (!material.catalog_item_id) return '自訂';
  const catalogItem = catalog.find(item => item.id === material.catalog_item_id);
  if (!catalogItem) return '';
  const canonicalGroup = catalogItem.group_id
    ? groups.find(group => group.id === catalogItem.group_id)
    : null;
  return canonicalGroup?.name || catalogItem.group_name?.trim() || '';
};

export const toDatetimeLocalValue = (value: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const fromDatetimeLocalValue = (value: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export interface BatchProcurementSummary {
  status: ProcurementStatus;
  total: number;
  received: number;
}

export const deriveBatchProcurementSummary = (
  batch: ProjectMaterialBatch,
  materials: ProjectMaterial[],
): BatchProcurementSummary => {
  if (batch.received_at) {
    return { status: 'RECEIVED', total: materials.length, received: materials.length };
  }
  const received = materials.filter(material => (
    material.procurement_status === 'RECEIVED' || Boolean(material.received_at)
  )).length;
  if (materials.length > 0 && received === materials.length) {
    return { status: 'RECEIVED', total: materials.length, received };
  }
  if (received > 0 || materials.some(material => material.procurement_status === 'PARTIAL_RECEIVED')) {
    return { status: 'PARTIAL_RECEIVED', total: materials.length, received };
  }
  if (batch.ordered_at || materials.some(material => material.procurement_status === 'ORDERED')) {
    return { status: 'ORDERED', total: materials.length, received };
  }
  return { status: 'NOT_ORDERED', total: materials.length, received };
};

export const buildProjectMaterialFromCatalog = (
  projectId: string,
  batchId: string,
  catalogItem: MaterialCatalogItem,
  createdBy: string,
): ProjectMaterialCreateInput => ({
  project_id: projectId,
  batch_id: batchId,
  catalog_item_id: catalogItem.id,
  item_name: catalogItem.name,
  specification: catalogItem.default_specification,
  quantity: 1,
  unit: catalogItem.default_unit,
  procurement_status: 'NOT_ORDERED',
  ordered_on: null,
  expected_delivery_on: null,
  received_on: null,
  expected_delivery_at: null,
  received_at: null,
  reminder_enabled: catalogItem.default_reminder_enabled,
  reminder_days_before: catalogItem.default_reminder_enabled
    ? catalogItem.default_reminder_days_before
    : null,
  include_in_purchase_request: true,
  delivery_destination: catalogItem.default_delivery_destination,
  delivery_destination_note: null,
  notes: null,
  created_by: createdBy,
});

export const buildCustomProjectMaterial = (
  projectId: string,
  batchId: string,
  createdBy: string,
  draft: Partial<Pick<ProjectMaterialCreateInput,
    'item_name' | 'specification' | 'quantity' | 'unit' | 'expected_delivery_at' | 'received_at' | 'delivery_destination' | 'delivery_destination_note'
  >> = {},
): ProjectMaterialCreateInput => ({
  project_id: projectId,
  batch_id: batchId,
  catalog_item_id: null,
  item_name: draft.item_name ?? '',
  specification: draft.specification ?? null,
  quantity: draft.quantity ?? 1,
  unit: draft.unit ?? '式',
  procurement_status: draft.received_at ? 'RECEIVED' : 'NOT_ORDERED',
  ordered_on: null,
  expected_delivery_on: null,
  received_on: null,
  expected_delivery_at: draft.expected_delivery_at ?? null,
  received_at: draft.received_at ?? null,
  reminder_enabled: false,
  reminder_days_before: null,
  include_in_purchase_request: true,
  delivery_destination: draft.delivery_destination ?? 'SITE',
  delivery_destination_note: draft.delivery_destination === 'OTHER'
    ? draft.delivery_destination_note ?? null
    : null,
  notes: null,
  created_by: createdBy,
});

export interface ProcurementCreatedMaterialDraft {
  item_name: string;
  specification: string | null;
  quantity: number;
  unit: string;
  expected_delivery_at: string | null;
  delivery_destination: DeliveryDestination;
  notes: string | null;
}

export const buildProcurementCreatedProjectMaterial = (
  projectId: string,
  batchId: string,
  createdBy: string,
  draft: ProcurementCreatedMaterialDraft,
  catalogItem: MaterialCatalogItem | null = null,
): ProjectMaterialCreateInput => ({
  project_id: projectId,
  batch_id: batchId,
  catalog_item_id: catalogItem?.id ?? null,
  item_name: draft.item_name,
  specification: draft.specification,
  quantity: draft.quantity,
  unit: draft.unit,
  procurement_status: 'ORDERED',
  ordered_on: null,
  expected_delivery_on: null,
  received_on: null,
  expected_delivery_at: draft.expected_delivery_at,
  received_at: null,
  reminder_enabled: catalogItem?.default_reminder_enabled ?? false,
  reminder_days_before: catalogItem?.default_reminder_enabled
    ? catalogItem.default_reminder_days_before
    : null,
  include_in_purchase_request: false,
  delivery_destination: draft.delivery_destination,
  delivery_destination_note: null,
  notes: draft.notes,
  created_by: createdBy,
});

const formatQuantity = (quantity: number): string => (
  Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(3)))
);

const getPurchaseItemLabel = (material: ProjectMaterial): string => {
  const name = material.item_name.trim();
  const specification = material.specification?.trim() || '';
  if (!specification) return name;
  const normalizedName = name.toLocaleLowerCase('zh-TW').replace(/[\s_-]+/g, '');
  const normalizedSpecification = specification.toLocaleLowerCase('zh-TW').replace(/[\s_-]+/g, '');
  if (normalizedSpecification.includes(normalizedName)) return specification;
  if (normalizedName.includes(normalizedSpecification)) return name;
  return `${name}/${specification}`;
};

export const buildPurchaseRequestText = (
  projectName: string,
  _batch: ProjectMaterialBatch,
  materials: ProjectMaterial[],
): string => {
  const selected = materials.filter(material => material.include_in_purchase_request);

  if (selected.length === 0) return '';

  const lines = selected.map(material => (
    `${getPurchaseItemLabel(material)} ${formatQuantity(material.quantity)}${material.unit.trim()}`
  ));

  return [
    `案場：${projectName.trim()}`,
    ...lines,
  ].join('\n');
};
