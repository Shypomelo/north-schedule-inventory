import type {
  ConstructionWorkType,
  DerivedConstructionStatus,
  ProjectConstructionProgress,
} from '@/lib/db/types';

export interface ConstructionProgressForDerivation {
  work_type: ConstructionWorkType;
  planned_start_date: string | null;
  is_completed: boolean;
  deleted_at: string | null;
}

export const CONSTRUCTION_WORK_LABELS: Record<ConstructionWorkType, string> = {
  racking: '支架', electrical: '電力', steel: '鋼構', roof_cover: '浪板', civil: '土木', other: '其他',
};

export function getConstructionWorkLabel(row: Pick<ProjectConstructionProgress, 'work_type' | 'work_name'>): string {
  return row.work_type === 'other' ? row.work_name?.trim() || '其他' : CONSTRUCTION_WORK_LABELS[row.work_type];
}

export function isConstructionPrework(row: ConstructionProgressForDerivation, entry: string | null): boolean {
  return !row.deleted_at && !MAIN_CONSTRUCTION_WORK_TYPES.has(row.work_type)
    && isValidIsoDate(row.planned_start_date) && isValidIsoDate(entry)
    && row.planned_start_date < entry;
}

export function sortConstructionRows<T extends Pick<ProjectConstructionProgress, 'sort_order' | 'created_at' | 'id'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order
    || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function constructionCompletionPatch(completed: boolean, actualDate: string | null, today: string) {
  return { is_completed: completed, actual_completed_date: completed ? actualDate || today : null };
}

export function getConstructionEndDate(
  row: Pick<ProjectConstructionProgress, 'is_completed' | 'planned_end_date' | 'actual_completed_date'>,
): string | null {
  return row.is_completed ? row.actual_completed_date : row.planned_end_date;
}

export type ConstructionOuterDisplayStatus =
  | 'UNSCHEDULED'
  | 'EXPECTED_START'
  | 'EXPECTED_END'
  | 'IN_PROGRESS'
  | 'COMPLETED';

export interface ConstructionOuterDisplay {
  status: ConstructionOuterDisplayStatus;
  label: string;
  date: string | null;
}

function formatConstructionDisplayDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${month}/${day}`;
}

export function getConstructionOuterDisplay(
  row: Pick<ProjectConstructionProgress, 'planned_start_date' | 'planned_end_date' | 'is_completed' | 'actual_completed_date'>,
  today: string,
): ConstructionOuterDisplay {
  if (!isValidIsoDate(today)) throw new Error('today must be a valid YYYY-MM-DD date');

  if (row.is_completed) {
    const date = isValidIsoDate(row.actual_completed_date) ? row.actual_completed_date : null;
    return { status: 'COMPLETED', label: date ? `已完工 ${formatConstructionDisplayDate(date)}` : '已完工', date };
  }

  if (!isValidIsoDate(row.planned_start_date)) {
    return { status: 'UNSCHEDULED', label: '未排程', date: null };
  }

  if (row.planned_start_date > today) {
    return { status: 'EXPECTED_START', label: `預計進場 ${formatConstructionDisplayDate(row.planned_start_date)}`, date: row.planned_start_date };
  }

  if (isValidIsoDate(row.planned_end_date)) {
    return { status: 'EXPECTED_END', label: `預計完工 ${formatConstructionDisplayDate(row.planned_end_date)}`, date: row.planned_end_date };
  }

  return { status: 'IN_PROGRESS', label: '施工中', date: null };
}

export function validateActualCompletionDate(actualDate: string | null, today: string): string | null {
  return actualDate && actualDate > today ? '實際完工日期不可晚於今天' : null;
}

export function validateConstructionWorkName(name: string | null): string | null {
  return name?.trim() ? null : '請輸入其他工項名稱';
}

export function getConstructionToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export interface ConstructionConflictRow {
  project_id: string;
  contractor_id: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  projects: { project_name: string };
}

export function getConstructionConflict(row: Pick<ProjectConstructionProgress, 'project_id' | 'contractor_id' | 'planned_start_date' | 'planned_end_date'>, others: readonly ConstructionConflictRow[]): ConstructionConflictRow | undefined {
  if (!row.contractor_id || !isValidIsoDate(row.planned_start_date) || !isValidIsoDate(row.planned_end_date)) return;
  return others.find(other => other.project_id !== row.project_id && other.contractor_id === row.contractor_id
    && isValidIsoDate(other.planned_start_date) && isValidIsoDate(other.planned_end_date)
    && row.planned_start_date! <= other.planned_end_date && other.planned_start_date <= row.planned_end_date!);
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
