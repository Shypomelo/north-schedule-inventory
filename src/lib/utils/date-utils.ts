import { presentBusinessDate } from '../date-presentation';

export function parseDateField(value: string, baseDateStr: string): Date | null {
  if (!value || typeof value !== 'string') return null;

  const v = value.trim().replace(/^(?:預計|實際|暫定)\s*/, '');
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

  // Regex for YYYYMMDD (8 digits)
  const yyyymmddMatch = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmddMatch) {
    const year = parseInt(yyyymmddMatch[1], 10);
    const month = parseInt(yyyymmddMatch[2], 10);
    const day = parseInt(yyyymmddMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }

  // Regex for MMDD (4 digits)
  const mmddMatch = v.match(/^(\d{2})(\d{2})$/);
  if (mmddMatch) {
    const month = parseInt(mmddMatch[1], 10);
    const day = parseInt(mmddMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const baseDate = new Date(baseDateStr);
      const year = isNaN(baseDate.getFullYear()) ? new Date().getFullYear() : baseDate.getFullYear();
      return new Date(year, month - 1, day);
    }
  }

  return null;
}

export function formatDateForDisplay(value: string, baseDateStr: string, actual = false, completed = false): string {
  if (!value) return '';
  const parsed = parseDateField(value, baseDateStr);
  if (!parsed) return value;
  const date = [parsed.getFullYear(),String(parsed.getMonth()+1).padStart(2,'0'),String(parsed.getDate()).padStart(2,'0')].join('-');
  const now = new Date();
  const today = [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
  return presentBusinessDate({planned:actual?null:date,actual:actual?date:null,completed,today}).label;
}
