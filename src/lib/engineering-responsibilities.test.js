const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const helperPath = path.join(__dirname, 'engineering-responsibilities.ts');
const transpiled = ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const helperModule = new Module(helperPath);
helperModule.filename = helperPath;
helperModule.paths = module.paths;
helperModule._compile(transpiled, helperPath);

const {
  buildMemberProjectResponsibilities,
  getPositionCandidates,
  getPositionMilestoneProgress,
  resolveProjectPositionMemberId,
} = helperModule.exports;
const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260907131749_add_project_position_responsibilities.sql'), 'utf8');
const usersPage = fs.readFileSync(path.join(__dirname, '..', 'app', 'admin', 'users', 'page.tsx'), 'utf8');
const workflowPage = fs.readFileSync(path.join(__dirname, '..', 'app', 'admin', 'workflow-settings', 'page.tsx'), 'utf8');
const projectAssignments = fs.readFileSync(path.join(__dirname, '..', 'components', 'ProjectPositionAssignments.tsx'), 'utf8');

const milestone = (id, sortOrder, positionId, status = 'NOT_STARTED', overrides = {}) => ({
  id,
  project_id: 'project-1',
  responsible_position_id: positionId,
  sort_order: sortOrder,
  status,
  is_applicable: true,
  deleted_at: null,
  planned_date: null,
  created_at: `2026-09-07T00:00:${String(sortOrder).padStart(2, '0')}Z`,
  ...overrides,
});

test('positions are data-driven and manageable instead of a hardcoded enum', () => {
  assert.match(migration, /CREATE TABLE public\.positions/);
  assert.doesNotMatch(migration, /CREATE TYPE[^;]*position/i);
  assert.match(usersPage, /createPosition/);
  assert.match(usersPage, /updatePosition/);
});

test('one member can hold multiple positions', () => {
  assert.match(migration, /PRIMARY KEY \(member_id, position_id\)/);
  assert.match(usersPage, /職位（可複選）/);
});

test('role and category remain independent from positions', () => {
  assert.doesNotMatch(migration, /ALTER TABLE public\.team_members/);
  assert.match(usersPage, /formData\.category/);
  assert.match(usersPage, /formData\.role/);
  assert.match(usersPage, /selectedPositionIds/);
});

test('people list presents positions without a duplicate category column', () => {
  const tableHead = usersPage.match(/<thead[\s\S]*?<\/thead>/)[0];
  assert.doesNotMatch(tableHead, />分類</);
  assert.match(tableHead, />姓名<[\s\S]*>簡稱<[\s\S]*>職位<[\s\S]*>角色<[\s\S]*>狀態<[\s\S]*>登入 Email<[\s\S]*>Google Calendar Email<[\s\S]*>備註<[\s\S]*>操作</);
  assert.match(usersPage, /userPositionNames\.map\(positionName/);
  assert.match(usersPage, /<span>未設定<\/span>/);
});

test('legacy category remains editable as a compatibility setting', () => {
  assert.match(usersPage, /既有分類／相容設定/);
  assert.match(usersPage, /value=\{formData\.category\}/);
  assert.match(usersPage, /category: user\.category \|\| 'OTHER'/);
  assert.match(usersPage, /category: 'OTHER'/);
  assert.match(usersPage, /dbAdapter\.(?:createUser|updateUser)/);
});

test('roles and multi-position editing keep their existing contracts', () => {
  assert.match(usersPage, /<option value="ADMIN">Admin<\/option>/);
  assert.match(usersPage, /<option value="ENGINEER">Engineer<\/option>/);
  assert.match(usersPage, /<option value="VIEWER">Viewer<\/option>/);
  assert.match(usersPage, /職位（可複選）/);
  assert.match(usersPage, /dbAdapter\.setMemberPositions\(savedUser\.id, selectedPositionIds\)/);
});

test('workflow responsible position columns are nullable foreign keys', () => {
  assert.match(migration, /project_workflow_template_steps[\s\S]*ADD COLUMN responsible_position_id uuid[\s\S]*REFERENCES public\.positions/);
  assert.doesNotMatch(migration, /responsible_position_id uuid NOT NULL/);
  assert.match(workflowPage, /<option value="">未設定<\/option>/);
});

test('new workflow snapshots copy the template responsible position', () => {
  assert.match(migration, /status,\s*responsible_position_id\s*\)[\s\S]*step\.responsible_position_id/);
});

test('template position edits do not update existing milestone snapshots', () => {
  assert.equal((migration.match(/UPDATE public\.project_milestones AS milestone/g) || []).length, 1);
  assert.match(migration, /milestone\.source_template_step_id = step\.id/);
  assert.match(migration, /milestone\.responsible_position_id IS NULL/);
  assert.match(migration, /DISABLE TRIGGER validate_project_milestone_contract[\s\S]*UPDATE public\.project_milestones[\s\S]*ENABLE TRIGGER validate_project_milestone_contract/);
});

test('one project has at most one primary member per position', () => {
  assert.match(migration, /UNIQUE \(project_id, position_id\)/);
});

test('project positions may remain unassigned and can be cleared', () => {
  assert.match(projectAssignments, /<option value="">未指派<\/option>/);
  assert.match(projectAssignments, /clearProjectPositionAssignment/);
  assert.doesNotMatch(migration, /INSERT INTO public\.project_position_assignments/);
});

test('candidate members must be active and hold the selected position', () => {
  const candidates = getPositionCandidates([
    { id: 'active-matching', is_active: true },
    { id: 'inactive-matching', is_active: false },
    { id: 'active-other', is_active: true },
  ], [
    { member_id: 'active-matching', position_id: 'engineering' },
    { member_id: 'inactive-matching', position_id: 'engineering' },
    { member_id: 'active-other', position_id: 'admin' },
  ], 'engineering');
  assert.deepEqual(candidates.map(member => member.id), ['active-matching']);
  assert.match(migration, /Project assignee must be an active member with the selected position/);
});

test('an unassigned position stays on the legal unassigned option with or without candidates', () => {
  assert.equal(resolveProjectPositionMemberId(undefined, [{ id: 'member-1' }]), '');
  assert.equal(resolveProjectPositionMemberId(undefined, []), '');
  assert.match(projectAssignments, /<option value="">未指派<\/option>/);
});

test('an existing assignment displays its member when that member remains a candidate', () => {
  assert.equal(
    resolveProjectPositionMemberId({ member_id: 'member-1' }, [{ id: 'member-1' }, { id: 'member-2' }]),
    'member-1',
  );
});

test('an assignment without a matching candidate renders unassigned instead of an invalid blank value', () => {
  assert.equal(resolveProjectPositionMemberId({ member_id: 'inactive-member' }, []), '');
  assert.equal(resolveProjectPositionMemberId({ member_id: 'other-position-member' }, [{ id: 'member-1' }]), '');
  const select = projectAssignments.match(/<select[\s\S]*?<\/select>/)[0];
  assert.doesNotMatch(select, /required|border-danger/);
  assert.match(select, /value=\{selectedMemberId\}/);
});

test('assignment writes only occur after a user selection change', () => {
  assert.match(projectAssignments, /onChange=\{event => void assign\(position\.id, event\.target\.value\)\}/);
  assert.match(projectAssignments, /if \(memberId\)[\s\S]*upsertProjectPositionAssignment/);
  assert.match(projectAssignments, /else \{[\s\S]*clearProjectPositionAssignment/);
  const loadFunction = projectAssignments.match(/const load = useCallback\([\s\S]*?\}, \[projectId\]\);/)[0];
  assert.doesNotMatch(loadFunction, /upsertProjectPositionAssignment|clearProjectPositionAssignment/);
});

test('member datasource resolves active project, position, and applicable milestones', () => {
  const result = buildMemberProjectResponsibilities({
    memberId: 'member-1',
    assignments: [{ id: 'a', member_id: 'member-1', project_id: 'project-1', position_id: 'engineering' }],
    projects: [{ id: 'project-1', name: '北部案場', is_active: true }],
    positions: [{ id: 'engineering', name: '工程', sort_order: 10 }],
    milestones: [milestone('m1', 10, 'engineering')],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].project.id, 'project-1');
  assert.equal(result[0].position.id, 'engineering');
  assert.deepEqual(result[0].milestones.map(row => row.id), ['m1']);
});

test('current milestone is the first applicable incomplete milestone for the position', () => {
  const result = getPositionMilestoneProgress([
    milestone('done', 10, 'engineering', 'COMPLETED'),
    milestone('ignored-position', 20, 'admin'),
    milestone('current', 30, 'engineering', 'IN_PROGRESS', { planned_date: '2026-09-30' }),
    milestone('later', 40, 'engineering'),
  ], 'engineering');
  assert.equal(result.current_milestone.id, 'current');
  assert.equal(result.current_planned_date, '2026-09-30');
});

test('previous milestone is the nearest earlier applicable workflow milestone regardless of position', () => {
  const result = getPositionMilestoneProgress([
    milestone('engineering-done', 10, 'engineering', 'COMPLETED'),
    milestone('other-position', 20, 'admin', 'COMPLETED'),
    milestone('current', 30, 'engineering'),
  ], 'engineering');
  assert.equal(result.previous_milestone.id, 'other-position');
});

test('non-applicable and deleted milestones are excluded from progress', () => {
  const result = getPositionMilestoneProgress([
    milestone('not-applicable', 10, 'engineering', 'NOT_STARTED', { is_applicable: false }),
    milestone('deleted', 20, 'engineering', 'NOT_STARTED', { deleted_at: '2026-09-07T01:00:00Z' }),
    milestone('current', 30, 'engineering'),
  ], 'engineering');
  assert.equal(result.current_milestone.id, 'current');
  assert.equal(result.previous_milestone, null);
});

test('PROJECT_CUSTOM milestones keep a null responsible position by default', () => {
  assert.doesNotMatch(migration, /PROJECT_CUSTOM[^;]*responsible_position_id\s*=\s*/i);
  const adapter = fs.readFileSync(path.join(__dirname, 'db', 'poc-supabase.ts'), 'utf8');
  assert.doesNotMatch(adapter, /createProjectCustomMilestone[\s\S]*responsible_position_id:/);
});

test('legacy projects and responsible_member_name are not used to guess assignments', () => {
  assert.doesNotMatch(migration, /responsible_member_name/);
  assert.doesNotMatch(migration, /INSERT INTO public\.project_position_assignments/);
  assert.doesNotMatch(projectAssignments, /responsible_member_name|manager/);
});

test('NORTH_DEFAULT maps exactly 18 stable step keys without adding or reordering steps', () => {
  const mappingBlock = migration.match(/WITH desired\(step_key, position_name\) AS \([\s\S]*?\), resolved AS/)[0];
  assert.equal((mappingBlock.match(/\('[A-Z_]+', '[^']+'\)/g) || []).length, 18);
  assert.doesNotMatch(migration, /INSERT INTO public\.project_workflow_template_steps/);
  assert.doesNotMatch(migration, /DELETE FROM public\.project_workflow_template_steps/);
  assert.doesNotMatch(migration, /SET sort_order/);
});
