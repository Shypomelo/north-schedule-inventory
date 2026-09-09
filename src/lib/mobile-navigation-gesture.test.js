const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'mobile-navigation-gesture.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleShim = { exports: {} };
new Function('module', 'exports', compiled)(moduleShim, moduleShim.exports);
const { isMobileNavigationEdgeSwipe } = moduleShim.exports;

test('opens only for a deliberate right swipe beginning at the left edge', () => {
  assert.equal(isMobileNavigationEdgeSwipe({ x: 12, y: 300 }, { x: 100, y: 315 }), true);
  assert.equal(isMobileNavigationEdgeSwipe({ x: 60, y: 300 }, { x: 160, y: 300 }), false);
  assert.equal(isMobileNavigationEdgeSwipe({ x: 12, y: 300 }, { x: 60, y: 300 }), false);
  assert.equal(isMobileNavigationEdgeSwipe({ x: 12, y: 300 }, { x: 100, y: 365 }), false);
  assert.equal(isMobileNavigationEdgeSwipe({ x: 12, y: 300 }, { x: -90, y: 300 }), false);
});

test('Sidebar binds the gesture only while the authenticated app shell is mounted', () => {
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'components', 'SidebarV3.tsx'), 'utf8');
  assert.match(sidebar, /touchstart/);
  assert.match(sidebar, /touchend/);
  assert.match(sidebar, /isMobileNavigationEdgeSwipe/);
});
