import type { Contractor, ContractorType } from '@/lib/db/types';

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

const CONTRACTOR_TYPE_VALUES = new Set<ContractorType>(
  CONTRACTOR_TYPE_OPTIONS.map(option => option.key),
);

export function getContractorCapabilities(
  contractor: Contractor,
): ContractorType[] {
  const capabilities = contractor.work_capabilities;
  return Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities
    : [contractor.contractor_type];
}

export function ensurePrimaryCapability(
  capabilities: readonly ContractorType[],
  primaryCategory: ContractorType,
): ContractorType[] {
  return Array.from(new Set([...capabilities, primaryCategory]));
}

export function validateContractorCapabilities(
  primaryCategory: ContractorType,
  capabilities: readonly ContractorType[],
): string | null {
  if (capabilities.length === 0) return '請至少選擇一項可施作工項';
  if (capabilities.some(capability => !CONTRACTOR_TYPE_VALUES.has(capability))) {
    return '可施作工項包含不支援的類別';
  }
  if (!capabilities.includes(primaryCategory)) {
    return '主要類別必須包含在可施作工項中';
  }
  return null;
}

export function getContractorsForWorkType(
  contractors: readonly Contractor[],
  workType: ContractorType,
  showAll: boolean,
): Contractor[] {
  const activeContractors = contractors.filter(
    contractor => contractor.is_active && !contractor.deleted_at,
  );

  if (showAll) return activeContractors;

  return activeContractors.filter(contractor =>
    getContractorCapabilities(contractor).includes(workType),
  );
}
