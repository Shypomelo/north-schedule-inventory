const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20260905092344_expand_government_utility_workflow.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

const desiredKeys = [
  'SITE_SURVEY',
  'STRUCTURAL_DRAWING',
  'ELECTRICAL_DRAWING',
  'MATERIAL_REQUEST',
  'START_WORK_CHECKLIST',
  'TAIPOWER_SUBMISSION',
  'REVIEW_OPINION_RECEIVED',
  'CONSENT_FILING_RECEIVED',
  'MISC_EXEMPTION_SUBMISSION',
  'MISC_EXEMPTION_RECEIVED',
  'TAIPOWER_COORDINATION',
  'ENTRY_READINESS',
  'SITE_ENTRY',
  'EXTERNAL_LINE_COMPLETED',
  'COMPLETION',
  'INTERNAL_ACCEPTANCE',
  'COMPLETION_REPORT',
  'METER_INSTALLATION',
];

test('NORTH_DEFAULT expands government and utility steps as one ordered workflow', () => {
  let previousIndex = -1;
  for (const key of desiredKeys) {
    const index = migration.indexOf(`('${key}'`);
    assert.ok(index > previousIndex, `${key} must follow the preceding workflow step`);
    previousIndex = index;
  }
  for (const label of [
    '台電送件', '審查意見書取得', '同意備案取得', '免雜送件', '免雜取得',
    '台電協商', '外線完成', '報竣', '掛表',
  ]) assert.match(migration, new RegExp(label));
});

test('generic government step is disabled and meter installation is reused exactly once', () => {
  assert.match(migration, /step\.step_key = 'GOVERNMENT_DOCUMENTS'/);
  assert.match(migration, /SET is_active = false/);
  assert.equal((migration.match(/\('METER_INSTALLATION'/g) || []).length, 1);
  assert.ok(migration.indexOf("('INTERNAL_ACCEPTANCE'") < migration.indexOf("('COMPLETION_REPORT'"));
  assert.ok(migration.indexOf("('COMPLETION_REPORT'") < migration.indexOf("('METER_INSTALLATION'"));
});

test('template change does not mutate existing workflow instances or project milestones', () => {
  assert.doesNotMatch(migration, /(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.project_workflow_instances/i);
  assert.doesNotMatch(migration, /(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.project_milestones/i);
  assert.match(migration, /INSERT INTO public\.project_workflow_template_steps/);
  assert.match(migration, /default_is_applicable/);
});

test('Admin Workflow settings remains capable of editing applicability, phase, type and order', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'app', 'admin', 'workflow-settings', 'page.tsx'), 'utf8');
  assert.match(admin, /default_is_applicable/);
  assert.match(admin, /phase_id/);
  assert.match(admin, /type_id/);
  assert.match(admin, /sort_order/);
  assert.match(admin, /is_active/);
});
