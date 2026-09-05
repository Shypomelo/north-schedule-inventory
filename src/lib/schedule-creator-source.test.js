const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
const migration = read('supabase/migrations/20260905093215_track_schedule_creator_and_source.sql');
const adapter = read('src/lib/db/poc-supabase.ts');
const form = read('src/components/ScheduleTaskForm.tsx');

test('migration preserves legacy rows without guessing an app creator', () => {
  assert.match(migration, /creation_source text NOT NULL DEFAULT 'LEGACY'/);
  assert.match(migration, /'APP', 'GOOGLE_IMPORT', 'SYSTEM', 'LEGACY'/);
  assert.doesNotMatch(migration, /UPDATE\s+public\.schedule_tasks/i);
});

test('app creation captures the authenticated member and immutable name snapshot', () => {
  assert.match(form, /created_by_user_id: initialData\?\.created_by_user_id \|\| currentUser\?\.id \|\| null/);
  assert.match(form, /created_by_name: initialData\?\.created_by_name \|\| currentUser\?\.name \|\| null/);
  assert.match(form, /creation_source: initialData\?\.creation_source \|\| 'APP'/);
});

test('schedule updates cannot overwrite creator or creation source', () => {
  const updateStart = adapter.indexOf('updateScheduleTask: async (');
  const updateEnd = adapter.indexOf('deleteScheduleTask: async (', updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  const updateContract = adapter.slice(updateStart, updateEnd);

  assert.doesNotMatch(updateContract, /dbUpdates\.created_by_user_id/);
  assert.doesNotMatch(updateContract, /dbUpdates\.created_by_name/);
  assert.doesNotMatch(updateContract, /dbUpdates\.creation_source/);
  assert.match(migration, /BEFORE UPDATE OF created_by_user_id, created_by_name, creation_source/);
  assert.match(migration, /NEW\.created_by_user_id := OLD\.created_by_user_id/);
  assert.match(migration, /NEW\.created_by_name := OLD\.created_by_name/);
  assert.match(migration, /NEW\.creation_source := OLD\.creation_source/);
});
