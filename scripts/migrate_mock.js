const fs = require('fs');
const path = require('path');

const mockPath = path.join(__dirname, '../src/lib/db/mock.ts');
let content = fs.readFileSync(mockPath, 'utf8');

// 1. Remove ActiveProject from imports, add Contractor
content = content.replace(/ActiveProject, /g, '');
content = content.replace(/ActivityLog,/g, 'ActivityLog, Contractor,');

// 2. MockDatabase interface
content = content.replace(/active_projects: ActiveProject\[\];/, 'contractors: Contractor[];');

// 3. Initial db state
content = content.replace(/active_projects: \(mockActiveProjectsData as any\[\]\) as any\[\],/, 'contractors: [],');
content = content.replace(/active_projects: \(mockActiveProjectsData as any\[\]\) as ActiveProject\[\],/, 'contractors: [],');

// 4. Migration logic inside loadDb
content = content.replace(/if \(!db.active_projects\) \{\s*db.active_projects = \(mockActiveProjectsData as any\[\]\) as ActiveProject\[\];\s*\}/, `if (!db.contractors) {
        db.contractors = [];
      }
      if (db.active_projects && db.active_projects.length > 0) {
        db.active_projects.forEach(ap => {
          const projIdx = db.projects.findIndex(p => p.id === ap.matched_project_id || p.name === ap.name);
          if (projIdx >= 0) {
            db.projects[projIdx] = { ...db.projects[projIdx], ...ap, status: ap.status || '施工中' };
          } else {
            db.projects.push({ ...ap, status: ap.status || '施工中' } as any);
          }
        });
        db.active_projects = [];
        hasMigrationChanges = true;
      }`);

// 5. Remove get/create/update/delete ActiveProjects
content = content.replace(/getActiveProjects: async \(\) => \[\.\.\.db\.active_projects\].*?deleteActiveProject: async \(id: string\) => \{.*?\},/s, `getContractors: async () => [...db.contractors],
  createContractor: async (c: Omit<Contractor, 'id' | 'created_at' | 'updated_at'>) => {
    const newContractor = { ...c, id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    db.contractors.push(newContractor);
    return newContractor;
  },
  updateContractor: async (id: string, updates: Partial<Contractor>) => {
    const idx = db.contractors.findIndex(x => x.id === id);
    if (idx >= 0) {
      db.contractors[idx] = { ...db.contractors[idx], ...updates, updated_at: new Date().toISOString() };
      return db.contractors[idx];
    }
    throw new Error('Contractor not found');
  },
  deleteContractor: async (id: string) => {
    db.contractors = db.contractors.filter(x => x.id !== id);
  },`);

fs.writeFileSync(mockPath, content, 'utf8');
console.log('Migrated mock.ts');
