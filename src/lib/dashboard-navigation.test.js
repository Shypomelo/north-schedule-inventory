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

test('dashboard header reserves the full desktop row for 1200px and prevents clipped tabs', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'app', 'page.tsx'), 'utf8');
  const header = dashboard.slice(dashboard.indexOf('<header '), dashboard.indexOf('</header>'));
  assert.match(header, /flex flex-row flex-wrap/);
  assert.match(header, /min-\[1200px\]:flex-nowrap/);
  assert.match(header, /basis-full.*min-\[1200px\]:basis-auto/);
  assert.doesNotMatch(header, /overflow-x-auto|md:flex-nowrap|md:shrink\b/);
  assert.match(dashboard, /aria-label="Dashboard 視角"/);
  assert.match(dashboard, /availableDashboardSubpages\(selected\.key\)/);
});
