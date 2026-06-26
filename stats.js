const fs = require('fs');
const db = JSON.parse(fs.readFileSync('src/lib/db/mock-projects.json'));
console.log('Total:', db.length);
const statusCount = db.reduce((acc, p) => {
  acc[p.status] = (acc[p.status] || 0) + 1;
  return acc;
}, {});
console.log('Status Counts:', statusCount);
const yuzu = db.filter(p => p.status === '進行中' && p.manager === '柚子').length;
const weiyang = db.filter(p => p.status === '進行中' && p.manager === '維揚').length;
const yucheng = db.filter(p => p.status === '進行中' && p.manager === '育丞').length;
console.log('Manager Active Counts:', { yuzu, weiyang, yucheng });
