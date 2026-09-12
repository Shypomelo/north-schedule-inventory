const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, 'server', 'schedule-google-eligibility.ts');
const transpiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(filename);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(transpiled, filename);
const { getScheduleGoogleEligibility } = loaded.exports;

const eligibilityRow = enabled => ({
  work_group_id: enabled ? 'engineering-id' : 'project-id',
  work_groups: {
    id: enabled ? 'engineering-id' : 'project-id',
    key: enabled ? 'ENGINEERING' : 'PROJECT',
    name: enabled ? '工程' : '專案設計',
    google_calendar_sync_enabled: enabled,
  },
});

test('ENGINEERING is Google eligible and PROJECT is not', () => {
  assert.equal(getScheduleGoogleEligibility(eligibilityRow(true)).eligible, true);
  assert.equal(getScheduleGoogleEligibility(eligibilityRow(false)).eligible, false);
});

test('missing or mismatched persisted work group is fail-closed', () => {
  assert.equal(getScheduleGoogleEligibility({ work_group_id: 'missing', work_groups: null }).eligible, false);
  assert.equal(getScheduleGoogleEligibility({
    work_group_id: 'different',
    work_groups: eligibilityRow(true).work_groups,
  }).eligible, false);
});

test('sync route resolves persisted eligibility before constructing a Google client', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'google-calendar', 'sync', 'route.ts'), 'utf8');
  assert.ok(route.indexOf('resolveScheduleGoogleEligibility') < route.indexOf('getGoogleCalendarClient()'));
  assert.match(route, /google_calendar_ineligible/);
});

test('reconcile filters ineligible tasks, imports into ENGINEERING, and matches only eligible rows', () => {
  const reconcile = fs.readFileSync(path.join(__dirname, 'server', 'google-calendar-reconcile.ts'), 'utf8');
  assert.match(reconcile, /getScheduleGoogleEligibility\(task\)\.eligible/);
  assert.match(reconcile, /\.eq\('key', 'ENGINEERING'\)/);
  assert.match(reconcile, /workGroupId: engineeringWorkGroupId/);
  assert.ok(reconcile.indexOf('getScheduleGoogleEligibility(task).eligible') < reconcile.indexOf('existingEventIds'));
});
