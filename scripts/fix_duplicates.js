const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let lines = fs.readFileSync(file, 'utf8').split('\n');

// Remove duplicate contextMenu state
// Find the first and second index of contextMenu state
let firstState = -1;
let secondState = -1;
lines.forEach((line, i) => {
  if (line.includes('const [contextMenu, setContextMenu] = useState')) {
    if (firstState === -1) firstState = i;
    else secondState = i;
  }
});
if (secondState !== -1) {
  // also remove the useEffect that follows the second state
  lines.splice(secondState, 6);
}

// Remove duplicate handleArchiveProject
let firstArchive = -1;
let secondArchive = -1;
lines.forEach((line, i) => {
  if (line.includes('const handleArchiveProject = async')) {
    if (firstArchive === -1) firstArchive = i;
    else secondArchive = i;
  }
});

if (secondArchive !== -1) {
  lines.splice(secondArchive, 9); // remove the 9 lines of handleArchiveProject
}

fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('Fixed duplicates');
