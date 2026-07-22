const baseDateStr = "2026-07-14";
const baseDate = new Date(baseDateStr);
const baseTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();

const d = new Date("2026-07-16");
const isDateWithin14Days = (d) => d && d.getTime() > baseTime && d.getTime() <= baseTime + 14 * 24 * 60 * 60 * 1000;

console.log("new Date('2026-07-16') within 14 days?", isDateWithin14Days(d));
