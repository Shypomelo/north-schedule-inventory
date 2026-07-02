const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../src/components/ProjectDetailModal.tsx');
let content = fs.readFileSync(file, 'utf8');
content = content.replace(/\\\$/g, '$');
fs.writeFileSync(file, content, 'utf8');
console.log('Fixed backslashes');
