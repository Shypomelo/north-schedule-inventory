import { parseFlexibleLocalDate, presentStoredLocalDate } from './flexible-local-date';

export const TEAM_TODO_CARD_CLASS = 'rounded-xl border border-[var(--warning)] bg-[var(--surface-secondary)] shadow-sm transition hover:border-[var(--accent)]';

export function formatTodoReceivedDate(value: string | null | undefined): string {
  const date = value?.slice(0, 10);
  if (!date) return '收到日期未設定';
  return parseFlexibleLocalDate(date) === date
    ? `${date.slice(5, 7)}/${date.slice(8, 10)} 收到`
    : `收到日期異常（原始值：${date}）`;
}

export function presentTodoReceivedDate(value: string | null | undefined): { label: string; invalid: boolean } {
  return presentStoredLocalDate(value);
}

export function taiwanDayStart(date: string): string {
  if (parseFlexibleLocalDate(date) !== date) throw new Error('Invalid received date');
  return `${date}T00:00:00+08:00`;
}
