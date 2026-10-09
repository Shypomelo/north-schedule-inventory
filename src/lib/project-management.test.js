const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const load = file => require('./test-load-ts.cjs')(path.join(__dirname, file));
const { classifyProjectManagement, getFormalEntryDate, isMeteredProject, nextNextSunday } = load('project-management.ts');
const { getConstructionToday } = load('construction-progress.ts');
const project = overrides => ({
  status: '進行中', is_active: true, project_type: null,
  racking_expected_start_date: null, electrical_expected_start_date: null,
  steel_expected_start_date: null, roof_cover_expected_start_date: null,
  meter_status: null, meter_expected_date: null, meter_completion_date: null,
  ...overrides,
});

test('Taipei business day changes at UTC 16:00', () => {
  assert.equal(getConstructionToday(new Date('2026-10-08T15:59:59Z')), '2026-10-08');
  assert.equal(getConstructionToday(new Date('2026-10-08T16:00:00Z')), '2026-10-09');
});
test('an entry scheduled today is construction, including completed work before meter installation', () => {
  assert.equal(classifyProjectManagement(project({ racking_expected_start_date: '2026-10-09' }), '2026-10-09'), 'construction');
  assert.equal(classifyProjectManagement(project({ electrical_expected_start_date: '2026-10-01', electrical_is_completed: true, inspection_status: 'COMPLETED' }), '2026-10-09'), 'construction');
});
test('new roof formal entry includes steel and roof cover', () => {
  const roof = project({ project_type: '新設頂蓋', steel_expected_start_date: '2026-10-09', racking_expected_start_date: '2026-11-01' });
  assert.equal(getFormalEntryDate(roof), '2026-10-09');
  assert.equal(classifyProjectManagement(roof, '2026-10-09'), 'construction');
});
test('upcoming window runs from tomorrow through Sunday of the week after next', () => {
  assert.equal(nextNextSunday('2026-10-09'), '2026-10-25');
  assert.equal(classifyProjectManagement(project({ racking_expected_start_date: '2026-10-25' }), '2026-10-09'), 'upcoming');
  assert.equal(classifyProjectManagement(project({ racking_expected_start_date: '2026-10-26' }), '2026-10-09'), 'other');
});
test('metered requires canonical completion and an actual date before today', () => {
  const base = project({ electrical_expected_start_date: '2026-10-01', meter_status: 'COMPLETED' });
  assert.equal(isMeteredProject(project({ ...base, meter_completion_date: '2026-10-08' }), '2026-10-09'), true);
  assert.equal(classifyProjectManagement(project({ ...base, meter_completion_date: '2026-10-08' }), '2026-10-09'), 'metered');
  assert.equal(classifyProjectManagement(project({ ...base, meter_completion_date: '2026-10-09' }), '2026-10-09'), 'construction');
  assert.equal(classifyProjectManagement(project({ ...base, meter_status: 'IN_PROGRESS', meter_completion_date: null, meter_expected_date: '2026-10-08' }), '2026-10-09'), 'construction');
});
