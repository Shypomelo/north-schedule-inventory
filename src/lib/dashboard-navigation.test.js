const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  availableDashboardSubpages,
  dashboardPerspectiveStorageKey,
  dashboardSubpageStorageKey,
  resolveDashboardSubpage,
  resolveSavedDashboardView,
} = require('./test-load-ts.cjs')(path.join(__dirname, 'dashboard-navigation.ts'));

const views = ['ENGINEERING', 'PROJECT_MANAGEMENT', 'DESIGN'].map((key, index) => ({
  id: key,
  key,
  name: key,
  is_active: true,
  sort_order: index,
}));

test('receiving is shared by every perspective while maintenance stays engineering-only', () => {
  assert.deepEqual(availableDashboardSubpages('ENGINEERING'), ['overview', 'maintenance', 'receiving']);
  assert.deepEqual(availableDashboardSubpages('PROJECT_MANAGEMENT'), ['overview', 'receiving']);
  assert.deepEqual(availableDashboardSubpages('DESIGN'), ['overview', 'receiving']);
});

test('invalid or revoked saved locations fall back safely', () => {
  assert.equal(resolveSavedDashboardView(views.slice(1), views[1], 'ENGINEERING').key, 'PROJECT_MANAGEMENT');
  assert.equal(resolveDashboardSubpage('DESIGN', 'maintenance'), 'overview');
  assert.equal(resolveDashboardSubpage('ENGINEERING', 'receiving'), 'receiving');
});

test('local preferences are member and perspective scoped', () => {
  assert.notEqual(dashboardPerspectiveStorageKey('member-a'), dashboardPerspectiveStorageKey('member-b'));
  assert.notEqual(dashboardSubpageStorageKey('member-a', 'ENGINEERING'), dashboardSubpageStorageKey('member-a', 'DESIGN'));
});

test('desktop dashboard header keeps title, perspective tabs, and subpage tabs in one row', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
  assert.match(dashboard, /flex flex-col gap-2 md:flex-row md:items-center/);
  assert.match(dashboard, /aria-label="Dashboard 視角"/);
  assert.match(dashboard, /availableDashboardSubpages\(selected\.key\)/);
});
