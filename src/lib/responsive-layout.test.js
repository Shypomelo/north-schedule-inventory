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
  assert.match(layout, /pt-14 md:pt-0/);
  assert.match(sidebar, /開啟導覽選單/);
  assert.match(sidebar, /aria-modal="true"/);
  assert.match(sidebar, /isMobileNavigationEdgeSwipe/);
  assert.match(sidebar, /md:hidden/);
  assert.match(sidebar, /md:flex/);
});

test('login card fits mobile dynamic viewport without changing the auth flow', () => {
  const login = read('app/login/page.tsx');
  assert.match(login, /min-h-\[100dvh\]/);
  assert.match(login, /overflow-x-hidden/);
  assert.match(login, /max-w-md/);
  assert.match(login, /text-xl[\s\S]*sm:text-2xl/);
  assert.match(login, /min-h-12 w-full/);
  assert.match(login, /loginWithGoogle\(snapshot\.redirectTo\)/);
});

test('schedule detail fits the mobile viewport and retains readable information hierarchy', () => {
  const detail = read('components/ScheduleTaskDetail.tsx');
  assert.match(detail, /max-h-\[100dvh\]/);
  assert.match(detail, /sm:max-w-2xl/);
  assert.match(detail, /排程完整資訊/);
  assert.match(detail, /協同人員/);
  assert.match(detail, /href=\{display\.mapUrl\}/);
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
