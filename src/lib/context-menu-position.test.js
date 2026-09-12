const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const { positionContextMenu } = loadTypeScript(path.join(__dirname, 'context-menu-position.ts'));

test('context menu anchors at client cursor coordinates', () => {
  assert.deepEqual(positionContextMenu({ x: 240, y: 180 }, { width: 144, height: 96 }, { width: 1200, height: 800 }), { left: 240, top: 180 });
});

test('context menu handles right and bottom viewport collisions', () => {
  assert.deepEqual(positionContextMenu({ x: 1195, y: 795 }, { width: 144, height: 96 }, { width: 1200, height: 800 }), { left: 1048, top: 696 });
});

test('context menu coordinates are viewport-relative and independent of scroll offsets', () => {
  const point = { x: 38, y: 52 };
  assert.deepEqual(positionContextMenu(point, { width: 144, height: 96 }, { width: 1200, height: 800 }), { left: 38, top: 52 });
});
