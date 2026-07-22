const baseDateStr = "2026-07-14";
const baseDate = new Date(baseDateStr);
const baseTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();

const d = new Date("2026-07-16");

console.log("baseTime:", baseTime, new Date(baseTime).toISOString());
console.log("d.getTime():", d.getTime(), new Date(d.getTime()).toISOString());
console.log("d > baseTime:", d.getTime() > baseTime);
console.log("d <= baseTime + 14 days:", d.getTime() <= baseTime + 14 * 24 * 60 * 60 * 1000);

const d2 = new Date("2026-07-21");
console.log("d2 <= baseTime + 14 days:", d2.getTime() <= baseTime + 14 * 24 * 60 * 60 * 1000);

