const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const { canDeleteTodo } = loadTypeScript(path.join(__dirname, 'todo-text-actions.ts'));
const editor = { id: 'member-1', role: 'ENGINEER', is_active: true };
const viewer = { id: 'viewer-1', role: 'VIEWER', is_active: true };

test('PRIVATE delete is creator-only and VIEWER cannot mutate', () => {
  const todo = { scope: 'PRIVATE', created_by: 'member-1' };
  assert.equal(canDeleteTodo(todo, editor), true);
  assert.equal(canDeleteTodo(todo, { ...editor, id: 'member-2' }), false);
  assert.equal(canDeleteTodo(todo, viewer), false);
});

test('TEAM delete retains active editor permission and rejects VIEWER', () => {
  const todo = { scope: 'TEAM', created_by: 'member-2' };
  assert.equal(canDeleteTodo(todo, editor), true);
  assert.equal(canDeleteTodo(todo, viewer), false);
});

test('Engineering and Project dashboards use canonical delete paths', () => {
  const source = read('../app/page.tsx');
  assert.match(source, /projectManagement\?'PROJECT':'ENGINEERING'/);
  assert.match(source, /deletePrivateTodo\(todo\.id\)/);
  assert.match(source, /else await dbAdapter\.deleteTodo\(todo\.id\)/);
  assert.match(source, /canDeleteTodo\(todo, currentUser\)/);
});

test('Design dashboard exposes private and team delete through the shared menu', () => {
  const source = read('../components/DesignWorkbench.tsx');
  assert.match(source, /deletePrivateTodo\(todo\.id\)/);
  assert.match(source, /else await dbAdapter\.deleteTodo\(todo\.id\)/);
  assert.match(source, /<TodoContextMenu/);
  assert.match(source, /label:'刪除待辦'/);
});

test('Dashboard and Schedule use shared TodoRow and TodoContextMenu presentation', () => {
  for (const file of ['../app/page.tsx', '../app/schedule/page.tsx']) {
    const source = read(file);
    assert.match(source, /<TodoRow/);
    assert.match(source, /<TodoContextMenu/);
  }
  const row = read('../components/TodoRow.tsx');
  assert.match(row, /content\?: ReactNode/);
  assert.match(row, /md:hidden/);
  assert.match(read('../app/page.tsx'), /flex items-start gap-3 rounded-xl[\s\S]{0,160}p-3/);
  assert.match(read('../app/schedule/page.tsx'), /cursor-grab rounded-xl[\s\S]{0,160}p-2/);
  assert.match(read('../components/DesignWorkbench.tsx'), /rounded border border-theme-border p-3/);
});

test('Dashboard Todo columns use equal independent desktop rows and mobile flow', () => {
  const source = read('../app/page.tsx');
  assert.match(source, /min-\[1100px\]:grid-rows-2/);
  assert.match(source, /min-\[1100px\]:overflow-hidden/);
  assert.match(source, /min-\[1100px\]:overflow-y-auto/);
});
