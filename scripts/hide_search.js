const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(file, 'utf8');

const targetStr = `<div className="bg-slate-800/60 border border-slate-700/60 p-4 rounded-xl mb-6 flex flex-col md:flex-row gap-4 backdrop-blur-sm shrink-0">`;

if (content.includes(targetStr) && !content.includes('{!isActiveView && (\\n      <div className="bg-slate-800')) {
  // Find where it ends
  const parts = content.split(targetStr);
  
  // It should end after the } ) } block for the filters
  const endMarker = `          </div>\n        )}\n      </div>`;
  if (parts[1].includes(endMarker)) {
    const after = parts[1].replace(endMarker, `          </div>\n        )}\n      </div>\n      )}`);
    
    content = parts[0] + '{!isActiveView && (\n      ' + targetStr + after;
  }
}

fs.writeFileSync(file, content, 'utf8');
console.log('Done hiding search bar');
