import type { ProjectMaterial, ProjectMaterialBatch } from './db/types';

const FULL_DATE = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/;
const SHORT_DATE = /^(\d{1,2})[.\/-](\d{1,2})$/;
const COMPACT_DATE = /^(\d{2})(\d{2})$/;
const COLON_TIME = /^(\d{1,2}):(\d{2})$/;
const COMPACT_TIME = /^(\d{3,4})$/;

const pad = (value: number) => String(value).padStart(2, '0');
const validDate = (year: number, month: number, day: number) => {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
};

export function taipeiBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function parseReceiptDateInput(input: string, now = new Date()): string | null {
  const value = input.trim();
  const full = FULL_DATE.exec(value);
  const short = SHORT_DATE.exec(value) || COMPACT_DATE.exec(value);
  if (!full && !short) return null;

  let year = full ? Number(full[1]) : Number(taipeiBusinessDate(now).slice(0, 4));
  const month = Number(full ? full[2] : short![1]);
  const day = Number(full ? full[3] : short![2]);
  if (year < 1000 || year > 9999 || !validDate(year, month, day)) return null;

  let result = `${year}-${pad(month)}-${pad(day)}`;
  if (!full && result < taipeiBusinessDate(now)) {
    year += 1;
    if (!validDate(year, month, day)) return null;
    result = `${year}-${pad(month)}-${pad(day)}`;
  }
  return result;
}

export function parseReceiptTimeInput(input: string): string | null {
  const value = input.trim();
  const colon = COLON_TIME.exec(value);
  const compact = COMPACT_TIME.exec(value);
  if (!colon && !compact) return null;
  const hour = Number(colon ? colon[1] : value.slice(0, -2));
  const minute = Number(colon ? colon[2] : value.slice(-2));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

export function combineTaipeiReceiptDateTime(date: string, time: string): string | null {
  const parsedDate = parseReceiptDateInput(date, new Date(`${date}T00:00:00+08:00`));
  const parsedTime = parseReceiptTimeInput(time);
  if (!parsedDate || parsedDate !== date || !parsedTime) return null;
  const instant = new Date(`${parsedDate}T${parsedTime}:00+08:00`);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

export function receiptDateTimeParts(value: string | null | undefined): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const item = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${item.year}-${item.month}-${item.day}`, time: `${item.hour}:${item.minute}` };
}

export function formatCompactTaipeiReceiptTime(value: string | null | undefined): string {
  const parts = receiptDateTimeParts(value);
  return parts.date && parts.time ? `${parts.date.slice(5).replace('-', '/')} ${parts.time}` : '—';
}

export function getEffectiveExpectedDeliveryAt(
  material: Pick<ProjectMaterial, 'expected_delivery_at'>,
  batch: Pick<ProjectMaterialBatch, 'planned_receipt_at'>,
): string | null {
  return material.expected_delivery_at || batch.planned_receipt_at || null;
}

export function receiptGroupKey(batchId: string, expectedDeliveryAt: string): string {
  return `${batchId}::${new Date(expectedDeliveryAt).toISOString()}`;
}
