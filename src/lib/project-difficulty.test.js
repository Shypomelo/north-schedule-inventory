const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
const migration = read('supabase/migrations/20260905093609_add_project_difficulty_assessments.sql');
const adapter = read('src/lib/db/poc-supabase.ts');
const component = read('src/components/ProjectDifficultyAssessments.tsx');
const detail = read('src/components/ProjectDetailModal.tsx');

test('difficulty schema stores the two assessment moments and four 1-5 scores', () => {
  assert.match(migration, /assessment_type IN \('PRE_ESTIMATE', 'POST_EXECUTION'\)/);
  for (const column of [
    'overall_difficulty',
    'owner_communication_difficulty',
    'site_construction_difficulty',
    'site_coordination_difficulty',
  ]) {
    assert.match(migration, new RegExp(`${column} smallint NOT NULL`));
    assert.match(migration, new RegExp(`${column} BETWEEN 1 AND 5`));
  }
  assert.match(migration, /UNIQUE \(project_id, assessment_type\)/);
});

test('assessment provenance is immutable and insert identity matches the authenticated member', () => {
  assert.match(migration, /Project difficulty assessment provenance is immutable/);
  assert.match(migration, /NEW\.evaluator_user_id IS DISTINCT FROM OLD\.evaluator_user_id/);
  assert.match(migration, /evaluator_user_id uuid NOT NULL/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /BEFORE INSERT ON public\.project_difficulty_assessments/);
  assert.match(migration, /lower\(member\.email\) = lower\(auth\.jwt\(\) ->> 'email'\)/);
  assert.match(migration, /coalesce\(cardinality\(matching_member_ids\), 0\) <> 1/);
  assert.match(migration, /NEW\.evaluator_user_id := matching_member_ids\[1\]/);
  assert.match(migration, /NEW\.evaluator_name := matching_member_names\[1\]/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE/is);
});

test('update adapter changes scores and notes without replacing evaluator', () => {
  const start = adapter.indexOf('updateProjectDifficultyAssessment: async (');
  const end = adapter.indexOf('// --- Inventory Reads ---', start);
  assert.ok(start >= 0 && end > start);
  const updateContract = adapter.slice(start, end);
  assert.doesNotMatch(updateContract, /evaluator_user_id/);
  assert.doesNotMatch(updateContract, /evaluator_name/);
});

test('Project Detail exposes compact pre/post assessment UI without performance scoring', () => {
  assert.match(detail, /<ProjectDifficultyAssessments/);
  assert.match(component, /主管預估/);
  assert.match(component, /執行後回評/);
  assert.match(component, /整體難度/);
  assert.match(component, /業主溝通/);
  assert.match(component, /現場施工/);
  assert.match(component, /現場配合/);
  assert.doesNotMatch(component, /工程師排名|自主性分數|自動總分|1\.5倍/);
});
