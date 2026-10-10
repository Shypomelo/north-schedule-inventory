import type {
  ConstructionWorkType,
  DerivedConstructionStatus,
  Project,
  ProjectConstructionProgress,
} from '@/lib/db/types';
import { parseDateField } from '@/lib/utils/date-utils';

export interface ConstructionProgressForDerivation {
  work_type: ConstructionWorkType;
  planned_start_date: string | null;
  planned_end_date?: string | null;
  is_completed: boolean;
  deleted_at: string | null;
}

export const CONSTRUCTION_WORK_LABELS: Record<ConstructionWorkType, string> = {
  racking: '支架', electrical: '電力', steel: '鋼構', roof_cover: '浪板', civil: '土木', other: '其他',
};

export function getConstructionWorkLabel(row: Pick<ProjectConstructionProgress, 'work_type' | 'work_name'>): string {
  return row.work_type === 'other' ? row.work_name?.trim() || '其他' : CONSTRUCTION_WORK_LABELS[row.work_type];
}

export function isConstructionPrework(row: ConstructionProgressForDerivation, entry: string | null, newRoof = false): boolean {
  return !row.deleted_at && !entryWorkTypes(newRoof).has(row.work_type)
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
  const date = row.is_completed ? row.actual_completed_date : row.planned_end_date;
  return isValidIsoDate(date) ? date : null;
}

export function normalizeConstructionDateInput(value: unknown, baseDate: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('日期格式無效');

  const raw = value.trim();
  if (!raw) return null;
  const parsed = parseDateField(raw.replace(/\./g, '/'), baseDate);
  if (!parsed) throw new Error('日期格式無效');
  const normalizedInput = raw.replace(/\./g, '/');
  const parts = normalizedInput.match(/^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})$/)
    || normalizedInput.match(/^(\d{1,2})[-/]?(\d{1,2})$/);
  if (!parts) throw new Error('日期格式無效');
  const [, yearOrMonth, monthOrDay, optionalDay] = parts;
  const month = Number(optionalDay ? monthOrDay : yearOrMonth);
  const day = Number(optionalDay || monthOrDay);
  if (parsed.getMonth() + 1 !== month || parsed.getDate() !== day || (optionalDay && parsed.getFullYear() !== Number(yearOrMonth))) {
    throw new Error('日期格式無效');
  }

  const normalized = [
    String(parsed.getFullYear()).padStart(4, '0'),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-');
  if (!isValidIsoDate(normalized)) throw new Error('日期格式無效');
  return normalized;
}

export function getConstructionProjectPatch(
  row: ProjectConstructionProgress,
  removed = false,
): Partial<Project> {
  const type = row.work_type;
  return {
    [`${type}_contractor_id`]: removed ? null : row.contractor_id,
    [`${type}_contractor_name`]: removed ? null : row.contractor_name,
    [`${type}_expected_start_date`]: removed ? null : row.planned_start_date,
    [`${type}_completion_date`]: removed ? null : getConstructionEndDate(row),
    [`${type}_is_completed`]: removed ? false : row.is_completed,
    [`${type}_status`]: removed ? null : row.status_override,
    [`${type}_notes`]: removed ? null : row.notes,
  } as Partial<Project>;
}

export type ConstructionOuterDisplayStatus =
  | 'UNSCHEDULED'
  | 'EXPECTED_START'
  | 'EXPECTED_END'
  | 'IN_PROGRESS'
  | 'COMPLETED';

export type EffectiveConstructionStatus = 'UNSCHEDULED' | 'EXPECTED_START' | 'IN_PROGRESS' | 'AUTO_COMPLETED' | 'MANUAL_COMPLETED';

export function getEffectiveConstructionStatus(
  row: { planned_start_date: string | null; planned_end_date?: string | null; is_completed: boolean },
  today: string,
): EffectiveConstructionStatus {
  if (!isValidIsoDate(today)) throw new Error('today must be a valid YYYY-MM-DD date');
  if (row.is_completed) return 'MANUAL_COMPLETED';
  if (!isValidIsoDate(row.planned_start_date)) return 'UNSCHEDULED';
  if (row.planned_start_date > today) return 'EXPECTED_START';
  if (isValidIsoDate(row.planned_end_date ?? null) && row.planned_end_date! < today) return 'AUTO_COMPLETED';
  return 'IN_PROGRESS';
}

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
  const effective = getEffectiveConstructionStatus(row, today);
  if (effective === 'MANUAL_COMPLETED') {
    const date = isValidIsoDate(row.actual_completed_date) ? row.actual_completed_date : null;
    return { status: 'COMPLETED', label: date ? `已完工 ${formatConstructionDisplayDate(date)}` : '已完工', date };
  }

  if (effective === 'AUTO_COMPLETED') return { status: 'COMPLETED', label: '已完工', date: null };

  if (effective === 'UNSCHEDULED') {
    return { status: 'UNSCHEDULED', label: '未排程', date: null };
  }

  if (effective === 'EXPECTED_START') {
    return { status: 'EXPECTED_START', label: `預計進場 ${formatConstructionDisplayDate(row.planned_start_date!)}`, date: row.planned_start_date };
  }

  return { status: 'IN_PROGRESS', label: '施工中', date: null };
}

export type OuterRackingSource = 'racking' | 'steel';

export function selectOuterRackingProgress(
  project: Pick<Project,
    | 'racking_expected_start_date' | 'racking_completion_date' | 'racking_is_completed' | 'racking_status'
    | 'steel_expected_start_date' | 'steel_completion_date' | 'steel_is_completed' | 'steel_status'>,
  today: string,
): { source: OuterRackingSource; plannedStartDate: string | null; endDate: string | null;
  isCompleted: boolean; participating: boolean; display: ConstructionOuterDisplay } {
  const rackingParticipates = project.racking_status !== 'disabled';
  const steelParticipates = project.steel_status !== 'disabled';
  const rackingDate = rackingParticipates && isValidIsoDate(project.racking_expected_start_date)
    ? project.racking_expected_start_date : null;
  const steelDate = steelParticipates && isValidIsoDate(project.steel_expected_start_date)
    ? project.steel_expected_start_date : null;
  const source: OuterRackingSource = steelDate && (!rackingDate || steelDate < rackingDate)
    ? 'steel' : rackingParticipates ? 'racking' : steelParticipates ? 'steel' : 'racking';
  const participating = source === 'racking' ? rackingParticipates : steelParticipates;
  const plannedStartDate = source === 'racking' ? rackingDate : steelDate;
  const endDate = project[`${source}_completion_date`] ?? null;
  const isCompleted = project[`${source}_is_completed`] === true;
  const display = !rackingDate && !steelDate
    ? { status: 'UNSCHEDULED' as const, label: '未排程', date: null }
    : getConstructionOuterDisplay({
      planned_start_date: plannedStartDate, planned_end_date: isCompleted ? null : endDate,
      is_completed: isCompleted, actual_completed_date: isCompleted ? endDate : null,
    }, today);
  return { source, plannedStartDate, endDate, isCompleted, participating, display };
}

export function validateActualCompletionDate(actualDate: string | null, today: string): string | null {
  if (actualDate !== null && !isValidIsoDate(actualDate)) return '實際完工日期格式無效';
  return actualDate && actualDate > today ? '實際完工日期不可晚於今天' : null;
}

export function validateConstructionWorkName(name: string | null): string | null {
  return name?.trim() ? null : '請輸入其他工項名稱';
}

export function getConstructionWorkNameConflict(
  name: string,
  rows: readonly Pick<ProjectConstructionProgress, 'id' | 'work_type' | 'work_name'>[],
  excludeId?: string,
): string | null {
  const normalized = name.trim().toLocaleLowerCase();
  if (!normalized) return '請輸入其他工項名稱';
  if (Object.entries(CONSTRUCTION_WORK_LABELS).some(([type, label]) => type !== 'other' && label.toLocaleLowerCase() === normalized)) return '此施工工種已存在';
  return rows.some(row => row.id !== excludeId && row.work_type === 'other' && row.work_name?.trim().toLocaleLowerCase() === normalized)
    ? '此施工工種已存在' : null;
}

export function getConstructionToday(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
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
const NEW_ROOF_ENTRY_WORK_TYPES = new Set<ConstructionWorkType>(['steel', 'roof_cover', 'racking', 'electrical']);
const entryWorkTypes = (newRoof: boolean) => newRoof ? NEW_ROOF_ENTRY_WORK_TYPES : MAIN_CONSTRUCTION_WORK_TYPES;

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
  newRoof = false,
): string | null {
  const entryDates = progressRows
    .filter(row => row.deleted_at === null)
    .filter(row => entryWorkTypes(newRoof).has(row.work_type))
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
  const effective = getEffectiveConstructionStatus(row, today);
  if (effective === 'MANUAL_COMPLETED' || effective === 'AUTO_COMPLETED') return 'COMPLETED';
  if (effective === 'UNSCHEDULED') return 'UNSCHEDULED';
  const plannedStartDate = row.planned_start_date;
  if (!isValidIsoDate(plannedStartDate)) return 'UNSCHEDULED';

  if (
    !MAIN_CONSTRUCTION_WORK_TYPES.has(row.work_type)
    && isValidIsoDate(projectEntryDate)
    && plannedStartDate < projectEntryDate
  ) {
    return 'PREWORK';
  }

  return effective === 'EXPECTED_START' ? 'SCHEDULED' : 'IN_PROGRESS';
}
