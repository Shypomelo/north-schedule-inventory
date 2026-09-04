import type {
  ConstructionWorkType,
  DerivedConstructionStatus,
} from '@/lib/db/types';

export interface ConstructionProgressForDerivation {
  work_type: ConstructionWorkType;
  planned_start_date: string | null;
  is_completed: boolean;
  deleted_at: string | null;
}

const MAIN_CONSTRUCTION_WORK_TYPES = new Set<ConstructionWorkType>([
  'racking',
  'electrical',
]);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string | null): value is string {
  if (!value || !ISO_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function getProjectEntryDate(
  progressRows: readonly ConstructionProgressForDerivation[],
): string | null {
  const entryDates = progressRows
    .filter(row => row.deleted_at === null)
    .filter(row => MAIN_CONSTRUCTION_WORK_TYPES.has(row.work_type))
    .map(row => row.planned_start_date)
    .filter(isValidIsoDate)
    .sort();

  return entryDates[0] ?? null;
}

export function classifyConstructionItem(
  row: ConstructionProgressForDerivation,
  projectEntryDate: string | null,
  today: string,
): DerivedConstructionStatus {
  if (row.is_completed) return 'COMPLETED';

  const plannedStartDate = row.planned_start_date;
  if (!isValidIsoDate(plannedStartDate)) return 'UNSCHEDULED';

  if (
    !MAIN_CONSTRUCTION_WORK_TYPES.has(row.work_type)
    && isValidIsoDate(projectEntryDate)
    && plannedStartDate < projectEntryDate
  ) {
    return 'PREWORK';
  }

  if (!isValidIsoDate(today)) {
    throw new Error('today must be a valid YYYY-MM-DD date');
  }

  return plannedStartDate >= today ? 'SCHEDULED' : 'IN_PROGRESS';
}
