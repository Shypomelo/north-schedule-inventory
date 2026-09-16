const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('application shell exposes mobile navigation without a global desktop minimum width', () => {
  const layout = read('components/LayoutContentV3.tsx');
  const sidebar = read('components/SidebarV3.tsx');
  assert.doesNotMatch(layout, /min-w-\[1400px\]/);
  assert.match(layout, /min-w-0/);
  assert.match(layout, /pt-\[calc\(2\.5rem\+env\(safe-area-inset-top\)\)\] md:pt-0/);
  assert.match(sidebar, /開啟導覽選單/);
  assert.match(sidebar, /aria-modal="true"/);
  assert.match(sidebar, /isMobileNavigationEdgeSwipe/);
  assert.match(sidebar, /md:hidden/);
  assert.match(sidebar, /md:flex/);
  assert.match(sidebar, /h-\[calc\(2\.5rem\+env\(safe-area-inset-top\)\)\]/);
  assert.match(sidebar, /pt-\[env\(safe-area-inset-top\)\]/);
});

test('login card fits mobile dynamic viewport without changing the auth flow', () => {
  const login = read('app/login/page.tsx');
  assert.match(login, /min-h-\[100dvh\]/);
  assert.match(login, /min-w-0 w-full max-w-full/);
  assert.match(login, /max-w-md/);
  assert.match(login, /text-xl[\s\S]*sm:text-2xl/);
  assert.match(login, /min-h-12 min-w-0 w-full/);
  assert.match(login, /loginWithGoogle\(snapshot\.redirectTo\)/);
});

test('schedule detail fits the mobile viewport and retains readable information hierarchy', () => {
  const detail = read('components/ScheduleTaskDetail.tsx');
  assert.match(detail, /max-h-\[100dvh\]/);
  assert.match(detail, /sm:max-w-2xl/);
  assert.match(detail, /排程完整資訊/);
  assert.match(detail, /協同人員/);
  assert.match(detail, /href=\{display\.mapUrl\}/);
  assert.match(detail, /\}完成/);
  assert.match(detail, /\/>改期/);
  assert.match(detail, /\/>刪除/);
  assert.match(detail, /<History size=\{16\} \/>歷程/);
});

test('engineering dashboard uses four mobile tabs and four desktop columns', () => {
  const dashboard = read('app/page.tsx');
  assert.match(dashboard, /type MobileDashboardPage = 'schedule' \| 'projects' \| 'receipts' \| 'todos'/);
  assert.match(dashboard, /aria-label="工程儀表頁面"/);
  assert.match(dashboard, /aria-label="TO DO 類型"/);
  assert.match(dashboard, /md:grid-cols-2/);
  assert.match(dashboard, /min-\[1100px\]:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1\.12fr\)_minmax\(0,0\.88fr\)_minmax\(0,0\.93fr\)\]/);
  assert.match(dashboard, /mobilePage === 'schedule'/);
  assert.match(dashboard, /mobilePage === 'receipts'/);
  assert.match(dashboard, /mobileTodoPage === 'private'/);
  assert.match(dashboard, /mobileTodoPage === 'team'/);
});

test('wide schedule, project, and inventory data use scoped horizontal scrolling', () => {
  const schedule = read('app/schedule/page.tsx');
  const projects = read('app/projects/[[...filter]]/page.tsx');
  const inventory = read('app/inventory/page.tsx');
  assert.match(schedule, /min-w-\[72rem\]/);
  assert.match(schedule, /min-w-\[56rem\]/);
  assert.match(schedule, /overflow-auto/);
  assert.match(projects, /rounded-xl overflow-auto shadow-xl/);
  assert.match(inventory, /min-w-\[64rem\]/);
});

test('project and inventory detail dialogs fit the mobile viewport', () => {
  const projectDetail = read('components/ProjectDetailModal.tsx');
  const itemDetail = read('components/ItemDetailModal.tsx');
  assert.match(projectDetail, /h-\[100dvh\]/);
  assert.match(projectDetail, /sm:flex-row/);
  assert.match(projectDetail, /overflow-x-auto/);
  assert.match(itemDetail, /h-\[100dvh\]/);
  assert.match(itemDetail, /overflow-x-auto/);
});
