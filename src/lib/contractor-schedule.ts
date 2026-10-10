import type { ProjectConstructionProgress } from '@/lib/db/types';

export type ScheduledWork = Pick<ProjectConstructionProgress,
  'id' | 'project_id' | 'work_type' | 'work_name' | 'contractor_id' | 'contractor_name'
  | 'planned_start_date' | 'planned_end_date' | 'status_override' | 'deleted_at'>;

export interface ScheduledInterval<T extends ScheduledWork = ScheduledWork> {
  row: T;
  start: string;
  end: string;
  provisional: boolean;
}

export interface ContractorOverlap {
  left: ScheduledInterval;
  right: ScheduledInterval;
  start: string;
  end: string;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function getScheduledInterval<T extends ScheduledWork>(row: T): ScheduledInterval<T> | null {
  if (row.deleted_at || row.status_override === 'disabled' || !validDate(row.planned_start_date)) return null;
  const start = row.planned_start_date;
  const end = validDate(row.planned_end_date)
    ? row.planned_end_date
    : new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).toISOString().slice(0, 10);
  if (end < start) return null;
  return { row, start, end, provisional: !validDate(row.planned_end_date) };
}

export function findContractorOverlaps(rows: readonly ScheduledWork[]): ContractorOverlap[] {
  const intervals = rows.map(getScheduledInterval).filter((item): item is ScheduledInterval => item !== null);
  const overlaps: ContractorOverlap[] = [];
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const left = intervals[i], right = intervals[j];
      if (!left.row.contractor_id || left.row.contractor_id !== right.row.contractor_id || left.row.id === right.row.id) continue;
      const start = left.start > right.start ? left.start : right.start;
      const end = left.end < right.end ? left.end : right.end;
      if (start <= end) overlaps.push({ left, right, start, end });
    }
  }
  return overlaps;
}
