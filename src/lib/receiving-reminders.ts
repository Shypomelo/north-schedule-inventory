import type { PendingRow, ReceivingSnapshot } from './receiving-v5';
import { receivingTaipeiDay } from './receiving-batch-view';

export type ReminderBucket = 'overdue' | 'today' | 'upcoming';
export function receivingReminderBucket(row: PendingRow, data: ReceivingSnapshot, now: Date): ReminderBucket | null {
  if (row.kind !== 'PROJECT_MATERIAL' || !row.fulfilment.active || row.fulfilment.remaining <= 0 || !row.expectedAt) return null;
  const material = data.materials.find(value => value.id === row.id);
  if (!material?.reminder_enabled) return null;
  const expected = receivingTaipeiDay(row.expectedAt);
  const today = receivingTaipeiDay(now.toISOString());
  const days = Math.round((Date.parse(expected + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (!Number.isFinite(days)) return null;
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= Math.max(0, material.reminder_days_before ?? 0) ? 'upcoming' : null;
}
