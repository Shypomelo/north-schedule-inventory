const fs = require('fs');
const path = require('path');

const mockPath = path.join(__dirname, '../src/lib/db/mock.ts');
let content = fs.readFileSync(mockPath, 'utf8');

// fix double hasMigrationChanges declaration and type error
content = content.replace(/let hasMigrationChanges = false;\s*if \(db\.active_projects/g, 'let hasMigrationChanges = false;\n      if ((db as any).active_projects');
content = content.replace(/if \(db\.active_projects/g, 'if ((db as any).active_projects');
content = content.replace(/db\.active_projects/g, '(db as any).active_projects');

// wait, I also need to make sure I don't break string matching. Let's just fix the exact block:
content = content.replace(/if \(\(db as any\)\.active_projects && \(db as any\)\.active_projects\.length > 0\) \{[\s\S]*?hasMigrationChanges = true;\s*\}/, `if ((db as any).active_projects && (db as any).active_projects.length > 0) {
        (db as any).active_projects.forEach((ap: any) => {
          const projIdx = db.projects.findIndex(p => p.id === ap.matched_project_id || p.name === ap.name);
          if (projIdx >= 0) {
            db.projects[projIdx] = { ...db.projects[projIdx], ...ap, status: ap.status || '施工中' };
          } else {
            db.projects.push({ ...ap, status: ap.status || '施工中' } as any);
          }
        });
        (db as any).active_projects = [];
        hasMigrationChanges = true;
      }`);

// Also fix the let hasMigrationChanges = false;
content = content.replace(/let hasMigrationChanges = false;\s*db\.inventory_items = db\.inventory_items/g, 'db.inventory_items = db.inventory_items');

// Replace active projects methods
content = content.replace(/\/\/ --- Active Projects ---\s*getActiveProjects: async \(\) => \[\.\.\.\(db as any\)\.active_projects\].*?return updated;\s*\}/s, `// --- Contractors ---
  getContractors: async () => [...db.contractors],
  createContractor: async (c: Omit<Contractor, 'id' | 'created_at' | 'updated_at'>) => {
    const newContractor: Contractor = { ...c, id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    db.contractors.push(newContractor);
    persist();
    return newContractor;
  },
  updateContractor: async (id: string, updates: Partial<Contractor>) => {
    const idx = db.contractors.findIndex(x => x.id === id);
    if (idx >= 0) {
      db.contractors[idx] = { ...db.contractors[idx], ...updates, updated_at: new Date().toISOString() };
      persist();
      return db.contractors[idx];
    }
    throw new Error('Contractor not found');
  },
  deleteContractor: async (id: string) => {
    db.contractors = db.contractors.filter(x => x.id !== id);
    persist();
  }`);

// fix db.inventory_transactions error
content = content.replace(/Partial<Omit<'id'\|'created_at'\|'updated_at'>>/g, "Partial<Omit<Project, 'id'|'created_at'|'updated_at'>>");

fs.writeFileSync(mockPath, content, 'utf8');
console.log('Migrated mock.ts');
