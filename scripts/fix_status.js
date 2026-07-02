const fs = require('fs');
const path = require('path');

const mockPath = path.join(__dirname, '../src/lib/db/mock.ts');
let mockContent = fs.readFileSync(mockPath, 'utf8');

// We will add a small migration loop at the end of the `if (saved)` block or just inside the persistence logic
// Wait, actually `db.projects` is initialized inside `if (saved)`.
// Let's insert a small loop right after the `active_projects` migration:
const insertPoint = `(db as any).active_projects = [];
        hasMigrationChanges = true;
      }`;
      
const fixStatusCode = `
      // Fix for legacy projects that were "未設定" -> should be "已結案"
      db.projects.forEach(p => {
        if (!p.status || p.status === '未設定' || p.status === '') {
          p.status = '已結案';
          hasMigrationChanges = true;
        }
      });
`;

mockContent = mockContent.replace(insertPoint, insertPoint + fixStatusCode);

fs.writeFileSync(mockPath, mockContent, 'utf8');
console.log('Fixed status in mock.ts');
