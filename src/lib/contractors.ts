import type { Contractor, ContractorCapability, ContractorType } from '@/lib/db/types';

export const CONTRACTOR_TYPE_OPTIONS: readonly {
  key: ContractorType;
  label: string;
}[] = [
  { key: 'racking', label: '支架' },
  { key: 'electrical', label: '電力' },
  { key: 'steel', label: '鋼構' },
  { key: 'roof_cover', label: '新設頂蓋' },
  { key: 'civil', label: '土木' },
  { key: 'other', label: '其他' },
];

export const CONTRACTOR_CAPABILITY_OPTIONS: readonly {
  key: ContractorCapability;
  label: string;
}[] = [
  { key: 'racking', label: '支架' },
  { key: 'electrical', label: '電力' },
  { key: 'steel', label: '鋼構' },
  { key: 'roof_cover', label: '新設頂蓋' },
  { key: 'civil', label: '土木' },
  { key: 'ladder_installation', label: '爬梯安裝' },
  { key: 'other', label: '其他' },
];

const CONTRACTOR_TYPE_VALUES = new Set<ContractorType>(
  CONTRACTOR_TYPE_OPTIONS.map(option => option.key),
);
const CONTRACTOR_CAPABILITY_VALUES = new Set<ContractorCapability>(
  CONTRACTOR_CAPABILITY_OPTIONS.map(option => option.key),
);

export function isContractorType(value: unknown): value is ContractorType {
  return typeof value === 'string' && CONTRACTOR_TYPE_VALUES.has(value as ContractorType);
}

export function validateContractorCapabilityValues(capabilities: readonly unknown[]): string | null {
  if (capabilities.length === 0) return '請至少選擇一項可施作工項';
  if (capabilities.some(capability =>
    typeof capability !== 'string' || !CONTRACTOR_CAPABILITY_VALUES.has(capability as ContractorCapability))) {
    return '可施作工項包含不支援的類別';
  }
  return null;
}

export function getContractorCapabilities(
  contractor: Contractor,
): ContractorCapability[] {
  const capabilities = contractor.work_capabilities;
  return Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities
    : [contractor.contractor_type];
}

export function ensurePrimaryCapability(
  capabilities: readonly ContractorCapability[],
  primaryCategory: ContractorType,
): ContractorCapability[] {
  return Array.from(new Set([...capabilities, primaryCategory]));
}

export function validateContractorCapabilities(
  primaryCategory: ContractorType,
  capabilities: readonly ContractorCapability[],
): string | null {
  if (!isContractorType(primaryCategory)) return '主要類別包含不支援的類別';
  const valuesError = validateContractorCapabilityValues(capabilities);
  if (valuesError) return valuesError;
  if (!capabilities.includes(primaryCategory)) {
    return '主要類別必須包含在可施作工項中';
  }
  return null;
}

export function getContractorsForWorkType(
  contractors: readonly Contractor[],
  workType: ContractorType,
  showAll: boolean,
  workName?: string | null,
): Contractor[] {
  const activeContractors = contractors.filter(
    contractor => contractor.is_active && !contractor.deleted_at,
  );

  if (showAll) return activeContractors;

  const capability: ContractorCapability = workType === 'other' && workName?.trim() === '爬梯安裝'
    ? 'ladder_installation'
    : workType;

  return activeContractors.filter(contractor =>
    getContractorCapabilities(contractor).includes(capability),
  );
}
