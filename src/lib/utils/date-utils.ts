export function parseDateField(value: string, baseDateStr: string): Date | null {
  if (!value || typeof value !== 'string') return null;

  const v = value.trim();
  // match simple text that are obviously not dates
  if (['施工中', '已完工', '已完成', '已驗收', '待確認', '未開始', '待台電外線', '待使照取得'].includes(v)) {
    return null;
  }

  // Regex for MM/DD or M/D
  const mdMatch = v.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10);
    const day = parseInt(mdMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const baseDate = new Date(baseDateStr);
      const year = isNaN(baseDate.getFullYear()) ? new Date().getFullYear() : baseDate.getFullYear();
      return new Date(year, month - 1, day);
    }
  }

  // Regex for YYYY/MM/DD or YYYY-MM-DD
  const ymdMatch = v.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }

  return null;
}

export function formatDateForDisplay(value: string, baseDateStr: string): string {
  if (!value || typeof value !== 'string') return '';
  
  const parsedDate = parseDateField(value, baseDateStr);
  
  if (!parsedDate) {
    // Cannot parse to date, just return original string (e.g. "施工中")
    return value;
  }

  // It's a date! Compare it to baseDate
  const baseDate = new Date(baseDateStr);
  if (isNaN(baseDate.getTime())) return value; // Invalid base date

  // Normalize times to midnight for comparison
  const parsedTime = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()).getTime();
  const baseTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();

  // If the parsed date is strictly AFTER the base date, add "預計"
  if (parsedTime > baseTime) {
    // formatting to MM/DD
    const m = (parsedDate.getMonth() + 1).toString().padStart(2, '0');
    const d = parsedDate.getDate().toString().padStart(2, '0');
    return `預計${m}/${d}`;
  }

  // Else, just show MM/DD
  const m = (parsedDate.getMonth() + 1).toString().padStart(2, '0');
  const d = parsedDate.getDate().toString().padStart(2, '0');
  return `${m}/${d}`;
}
