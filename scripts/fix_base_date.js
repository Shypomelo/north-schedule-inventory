const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(pagePath, 'utf8');

// Use regex to add baseDate to DateDualInput
content = content.replace(
  /<DateDualInput \s*disabled/g,
  `<DateDualInput \n                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}\n                      disabled`
);

fs.writeFileSync(pagePath, content, 'utf8');
console.log('Added baseDate to DateDualInput in page.tsx');
