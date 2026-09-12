const FULL_DATE = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/;
const SHORT_DATE = /^(\d{1,2})[/.](\d{1,2})$/;
const COMPACT_SHORT_DATE = /^(\d{2})(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseFlexibleLocalDate(input: string, currentYear = new Date().getFullYear()): string | null {
  const value = input.trim();
  let year: number;
  let month: number;
  let day: number;
  const full = FULL_DATE.exec(value);
  const short = SHORT_DATE.exec(value);
  const compact = COMPACT_SHORT_DATE.exec(value);

  if (full) {
    year = Number(full[1]);
    month = Number(full[3]);
    day = Number(full[4]);
  } else if (short) {
    year = currentYear;
    month = Number(short[1]);
    day = Number(short[2]);
  } else if (compact) {
    year = currentYear;
    month = Number(compact[1]);
    day = Number(compact[2]);
  } else {
    return null;
  }

  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function presentStoredLocalDate(value: string | null | undefined): { label: string; invalid: boolean } {
  const raw = value?.slice(0, 10) || '';
  if (raw && parseFlexibleLocalDate(raw) === raw) {
    if (value && value.length > 10) {
      const instant = new Date(value);
      if (!Number.isNaN(instant.getTime())) {
        const label = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Taipei',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(instant);
        return { label, invalid: false };
      }
    }
    return { label: raw, invalid: false };
  }
  return { label: raw ? `日期異常（原始值：${raw}）` : '未設定', invalid: true };
}
