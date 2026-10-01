const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');

const { ScannerModelResolver } = load(path.resolve(__dirname, 'receiving-scanner-model.ts'));
const { classifyScannerCode } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));
const { BoxScanSession } = load(path.resolve(__dirname, 'receiving-box-session.ts'));
const { resolveBoxArrival } = load(path.resolve(__dirname, 'receiving-box-arrival.ts'));
const { groupedSerialArrival } = load(path.resolve(__dirname, 'receiving-v6.ts'));
const { searchInventoryItems } = load(path.resolve(__dirname, '../components/ReceivingSerialControls.tsx'));
const { BoxScanControls } = load(path.resolve(__dirname, '../components/BoxScanControls.tsx'));

const item = (code, id = code, overrides = {}) => ({
  id, code, name: code, canonical_identity_key: code.toLowerCase(), unit: '台', requires_serial: true,
  is_active: true, opening_quantity: 0, ...overrides,
});
const serial = index => `SZ4723-014D50C${index.toString(16).toUpperCase().padStart(2, '0')}-A1`;
const noMatch = () => ({ result_type: 'no_match', candidate_count: 0, filtered_candidate_count: 0, candidates: [] });
const emptyData = items => ({ items, observations: [], matchObservations: [], projects: [], materials: [], supplies: [], batches: [], arrivals: [], lines: [], matches: [], receipts: [], fulfilment: {} });

test('existing full PN reuses its exact item without invoking create', async () => {
  const existing = item('S440-1GM4MRM-NA02');
  const resolver = new ScannerModelResolver([existing], async () => { throw Error('create must not run'); });
  assert.strictEqual(await resolver.resolve('s440-1gm4mrm-na02'), existing);
});

test('missing full PN creates once through the canonical contract, then reuses it', async () => {
  const calls = [];
  const resolver = new ScannerModelResolver([], async (...args) => {
    calls.push(args);
    return item('S440-1GM4MRM-NA02', 'new');
  });
  const first = await resolver.resolve(' s440－1gm4mrm－na02 ');
  assert.equal(first.id, 'new');
  assert.strictEqual(await resolver.resolve('S440-1GM4MRM-NA02'), first);
  assert.deepEqual(calls, [['S440-1GM4MRM-NA02', '台', true]]);
  assert.equal(first.opening_quantity, 0);
});

test('concurrent same PN requests share one RPC and one item', async () => {
  let calls = 0;
  const resolver = new ScannerModelResolver([], async key => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return item(key, 'canonical');
  });
  const [a, b, c] = await Promise.all([resolver.resolve('P850-4RMLMRY'), resolver.resolve('p850-4rmlmry'), resolver.resolve('P850-4RMLMRY')]);
  assert.strictEqual(a, b); assert.strictEqual(b, c); assert.equal(calls, 1);
  const contract = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260927025111_receiving_explicit_item_identity.sql'), 'utf8');
  assert.match(contract, /LOCK TABLE public\.inventory_items IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(contract, /CREATE UNIQUE INDEX inventory_items_canonical_identity_key_unique/);
  assert.match(contract, /opening_quantity[\s\S]*?COALESCE\(\(p_definition->>'opening_quantity'\)::numeric,0\)/);
});

test('legacy S440 is never a prefix match for the full PN', async () => {
  const short = item('S440', 'legacy', { canonical_identity_key: null });
  let calls = 0;
  const resolver = new ScannerModelResolver([short], async key => { calls++; return item(key, 'full'); });
  assert.equal((await resolver.resolve('S440-1GM4MRM-NA02')).id, 'full');
  assert.equal((await resolver.resolve('S440')).id, 'legacy');
  assert.equal(calls, 1);
});

test('short S1200 is a complete MODEL identity in its own right', async () => {
  assert.equal(classifyScannerCode('S1200', []).kind, 'MODEL');
  const resolver = new ScannerModelResolver([], async key => item(key, 's1200'));
  assert.equal((await resolver.resolve('S1200')).code, 'S1200');
});

test('partial search S440 lists both short and full PN items', () => {
  const rows = [item('S440', 'short'), item('S440-1GM4MRM-NA02', 'full'), item('P850-4RMLMRY', 'other')];
  assert.deepEqual(searchInventoryItems(rows, 's440').map(row => row.id), ['short', 'full']);
});

test('resolved MODEL binds its exact item while original receiving quantity is still driven by serials', async () => {
  const code = 'S440-1GM4MRM-NA02';
  const box = new BoxScanSession([]);
  box.add(`${code};${serial(1)};${serial(2)}`);
  assert.equal(box.snapshot().currentBox.model.kind, 'MODEL');
  assert.equal(box.snapshot().currentBox.unknown.length, 0);
  const html = renderToStaticMarkup(React.createElement(BoxScanControls, {
    snapshot: box.snapshot(), onDeleteSerial() {}, onClear() {}, onComplete() {}, onDeleteBox() {},
    onReopen() {}, onConfirmModel() {}, onResolveUnknown() {},
  }));
  assert(html.includes(code));
  assert(!html.includes('待確認品項'));
  const created = item(code, 'full', { name: 'S440-1GM4MRM-NA02 完整品項' });
  box.bindModelItem(code, created);
  const boundHtml = renderToStaticMarkup(React.createElement(BoxScanControls, {
    snapshot: box.snapshot(), onDeleteSerial() {}, onClear() {}, onComplete() {}, onDeleteBox() {},
    onReopen() {}, onConfirmModel() {}, onResolveUnknown() {},
  }));
  assert(boundHtml.includes(created.name));
  const boxes = box.finish();
  let lookups = 0;
  const drafts = await resolveBoxArrival(boxes, emptyData([created]), async values => { lookups++; assert.equal(values.length, 2); return values.map(noMatch); });
  assert.equal(lookups, 1);
  assert(drafts.every(draft => draft.itemId === 'full'));
  assert.deepEqual(groupedSerialArrival(drafts, []).lines.map(line => line.quantity), [2]);
  assert.equal(created.opening_quantity, 0);
});

test('late item resolution binds a completed box and the same MODEL in the next box', () => {
  const code = 'S440-1GM4MRM-NA02';
  const box = new BoxScanSession([]);
  box.add(code); box.add(serial(1)); box.completeBox();
  box.add(code); box.add(serial(2));
  box.bindModelItem(code, item(code, 'full'));
  assert.equal(box.snapshot().completedBoxes[0].model.itemId, 'full');
  assert.equal(box.snapshot().currentBox.model.itemId, 'full');
  assert.equal(box.finish()[1].model.itemId, 'full');
});

test('UNKNOWN tokens stay in the existing confirmation flow and cannot create an item', () => {
  const box = new BoxScanSession([]);
  box.add(`S440-1GM4MRM-NA02;BAD TOKEN;${serial(1)}`);
  assert.equal(box.snapshot().currentBox.model.kind, 'MODEL');
  assert.deepEqual(box.snapshot().currentBox.unknown.map(code => code.raw), ['BAD TOKEN']);
  assert.equal(classifyScannerCode('BAD TOKEN', []).kind, 'UNKNOWN');
});

test('wrong or ambiguous item identity is rejected instead of guessing', async () => {
  const resolver = new ScannerModelResolver([], async () => item('S440', 'wrong'));
  await assert.rejects(resolver.resolve('S440-1GM4MRM-NA02'), /相同識別碼/);
  const ambiguous = new ScannerModelResolver([item('S440', 'a'), item('S440', 'b')], async () => { throw Error('create must not run'); });
  assert.throws(() => ambiguous.resolve('S440'), /多個品項/);
});
