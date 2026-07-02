const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let lines = fs.readFileSync(file, 'utf8').split('\n');

// Remove line 42 which is `  }, []);`
lines.splice(41, 1);

fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('Fixed line 42');
