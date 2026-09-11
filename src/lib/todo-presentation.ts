export const TEAM_TODO_CARD_CLASS = 'rounded-xl border border-[var(--warning)] bg-[var(--surface-secondary)] shadow-sm transition hover:border-[var(--accent)]';

export function formatTodoReceivedDate(value: string | null | undefined): string {
  const date = value?.slice(0, 10);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}/${date.slice(8, 10)} 收到` : '收到日期未設定';
}

export function taiwanDayStart(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid received date');
  return `${date}T00:00:00+08:00`;
}
