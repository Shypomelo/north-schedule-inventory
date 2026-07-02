const fs = require('fs');
const path = require('path');

const mockPath = path.join(__dirname, '../src/lib/db/mock.ts');
let content = fs.readFileSync(mockPath, 'utf8');

// Move let hasMigrationChanges = false; up
content = content.replace(/let hasMigrationChanges = false;\s*db\.inventory_items = db\.inventory_items\.map/g, 'db.inventory_items = db.inventory_items.map');
content = content.replace(/db = JSON\.parse\(saved\);/, 'db = JSON.parse(saved);\n      let hasMigrationChanges = false;');

// Fix Omit<Project, 'id'|'created_at'|'updated_at'> missing generic argument on line 721 (approx)
content = content.replace(/Partial<Omit<'id'\|'created_at'\|'updated_at'>>/g, "Partial<Omit<Project, 'id'|'created_at'|'updated_at'>>");

fs.writeFileSync(mockPath, content, 'utf8');
console.log('Fixed mock.ts');
