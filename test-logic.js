const p = {
  project_code: "B2026017",
  report_base_date: "2026-07-14",
  bracket_status: "預計07/16",
  power_status: "預計07/16",
  racking_expected_start_date: null,
  electrical_expected_start_date: null,
};

function parseDateField(value, baseDateStr) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim().replace(/^(?:預計|實際|暫定)\s*/, '');
  const mdMatch = v.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10);
    const day = parseInt(mdMatch[2], 10);
    const baseDate = new Date(baseDateStr);
    const year = isNaN(baseDate.getFullYear()) ? new Date().getFullYear() : baseDate.getFullYear();
    return new Date(year, month - 1, day);
  }
  return null;
}

const baseDateStr = p.report_base_date;
const baseDate = new Date(baseDateStr);
const baseTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();

const isDateWithin14Days = (d) => d && d.getTime() > baseTime && d.getTime() <= baseTime + 14 * 24 * 60 * 60 * 1000;

const expectedDates = [];
if (!p.racking_expected_start_date) {
  const d = parseDateField(p.bracket_status, baseDateStr);
  if (d) expectedDates.push(d);
}

console.log("expectedDates:", expectedDates);
console.log("hasDateWithin14Days:", expectedDates.some(d => isDateWithin14Days(d)));
