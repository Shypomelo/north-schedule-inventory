const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');
const { classifyScannerCode, ScannerSession, scannerCounts } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));
const { classifySerialFormat, INVENTORY_SERIAL_NORMALIZATION_FIXTURES } = load(path.resolve(__dirname, 'inventory-serial-normalization.ts'));
const { ScannerCaptureResults } = load(path.resolve(__dirname, '../components/BarcodeScanner.tsx'));
const model = 'SE10000H-RWSKBF57';
const serials = ['SB4725-07515C2F0-3C', 'SB4725-07515CACE-22', 'SB4725-07515C8C7-19'];
const items = [{ id: 'model', code: model }];
const classify = (raw, catalog = items) => classifyScannerCode(raw, catalog);

for (const serial of serials) test(`${serial} is SERIAL via the canonical full contract`, () => {
  assert.equal(classifySerialFormat(serial), 'full');
  assert.deepEqual(classify(serial), { raw: serial, normalized: serial.split('-').slice(1).join('-'), kind: 'SERIAL' });
});
test('exact catalog model match, without prefix, substring or first-candidate guessing', () => {
  assert.equal(classify(model).itemId, 'model');
  assert.equal(classify(model).kind, 'MODEL');
  for (const raw of ['SE10000H-RWSKBF57-X', 'X-SE10000H-RWSKBF57']) assert.equal(classify(raw).kind, 'UNKNOWN');
  assert.equal(classify(model, []).kind, 'MODEL');
  assert.equal(classify(model, [...items, { id: 'duplicate', code: model }]).kind, 'UNKNOWN');
});
test('unlabeled numeric value is UNKNOWN', () => assert.equal(classify('27382202').kind, 'UNKNOWN'));
test('real full and short SN values share canonical scanner identity without a catalog lookup', () => {
  const examples = [
    ['ST1424-018C44105-22', '018C44105-22'],
    ['SJ1923A-0306AD20D-79', '0306AD20D-79'],
    ['ST1826-01911FDF9-20', '01911FDF9-20'],
    ['SZ3923-018F7321C-5D', '018F7321C-5D'],
    ['SB4725-07515C69D-ED', '07515C69D-ED'],
  ];
  for (const [full, short] of examples) {
    assert.deepEqual(classify(full, []), { raw: full, normalized: short, kind: 'SERIAL' });
    assert.deepEqual(classify(short, []), { raw: short, normalized: short, kind: 'SERIAL' });
  }
  const session = new ScannerSession([], () => {}, () => {}, 10000);
  try { assert.equal(session.add(examples[0][0]), true); assert.equal(session.add(examples[0][1]), false); assert.equal(session.codes.length, 1); }
  finally { session.dispose(); }
});
test('real PN structures are confirmed models even before catalog creation', () => {
  for (const value of ['SE10000H-RWSKBF57', 'S440-1GM4MRM-NA02', 'P850-4RMLMRY', 'R800', 'S1200'])
    assert.equal(classify(value, []).kind, 'MODEL', value);
  assert.equal(classify('27382202', []).kind, 'UNKNOWN');
});
test('PN / P/N evidence is MODEL with the exact catalog identity', () => {
  for (const prefix of ['PN:', 'P/N=', 'pn ', 'ＰＮ：']) {
    const result = classify(prefix + model);
    assert.equal(result.kind, 'MODEL'); assert.equal(result.normalized, model); assert.equal(result.itemId, 'model');
  }
});
test('uncatalogued PN stays a model candidate, never a serial or invented item identity', () => {
  const result = classify('P/N: ' + serials[0]);
  assert.equal(result.kind, 'MODEL_CANDIDATE'); assert.equal(result.itemId, undefined);
  const html = renderToStaticMarkup(React.createElement(ScannerCaptureResults, { codes: [result] }));
  assert(html.includes('待確認品項'));
});
test('SN / S/N evidence requires a valid serial format', () => {
  for (const prefix of ['SN:', 'S/N=', 'sn ']) {
    const result = classify(prefix + model);
    assert.equal(result.kind, 'UNKNOWN'); assert.equal(result.itemId, undefined);
  }
  assert.equal(classify('SN: 27382202').kind, 'UNKNOWN');
});
test('serial/model overlap requires confirmation without label; label disambiguates type only', () => {
  const catalog = [{ id: 'overlap', code: serials[0] }];
  assert.equal(classify(serials[0], catalog).kind, 'UNKNOWN');
  assert.equal(classify('PN: ' + serials[0], catalog).kind, 'MODEL');
  assert.equal(classify('SN: ' + serials[0], catalog).kind, 'SERIAL');
  assert.equal(classify('PN: ' + serials[0], [...catalog, { id: 'other', code: serials[0] }]).kind, 'UNKNOWN');
});
test('8+2, 9+2, full and normalization fixtures retain the canonical contract', () => {
  for (const raw of ['ABC12345-01', 'ABC123456-01', 'SJ1823A-03068530E-F9', ' sb4725－07515c2f0–3c ']) assert.equal(classify(raw).kind, 'SERIAL');
  for (const fixture of INVENTORY_SERIAL_NORMALIZATION_FIXTURES) {
    assert.equal(classify(fixture.input, []).kind, fixture.format === 'unknown' ? 'UNKNOWN' : 'SERIAL');
    assert.equal(classify(fixture.input, []).normalized, fixture.shortKey || fixture.normalized);
  }
});
test('empty, conflicting or unproven labels do not fabricate field evidence', () => {
  for (const raw of ['PN:', 'SN:', 'PN: SN: 27382202', 'SN: 27382202 PN: OTHER', 'XSN: 27382202', 'SN27382202']) assert.equal(classify(raw).kind, 'UNKNOWN');
});
test('labeled composite flows through existing session without changing deduplication', () => {
  const session = new ScannerSession(items, () => {}, () => {}, 10000);
  try {
    session.add(`PN: ${model}|SN: ${serials[0]}`);
    assert.deepEqual(session.codes.map(c => c.kind), ['MODEL', 'SERIAL']);
    assert.equal(session.add(serials[0]), false);
  } finally { session.dispose(); }
});
test('observed five-code batch gives 3 SERIAL / 1 MODEL / 1 UNKNOWN and compact UI', () => {
  const session = new ScannerSession(items, () => {}, () => {}, 10000);
  try {
    for (const raw of [serials[0], model, serials[1], serials[2], '27382202']) session.add(raw);
    assert.deepEqual(scannerCounts(session.codes), { total: 5, serial: 3, model: 1, unknown: 1 });
    const collapsed = renderToStaticMarkup(React.createElement(ScannerCaptureResults, { codes: session.codes }));
    const expanded = renderToStaticMarkup(React.createElement(ScannerCaptureResults, { codes: session.codes, expanded: true }));
    for (const text of ['已掃 3 台', '序號 3', '型號 1', '待確認 1', model, '27382202']) assert(collapsed.includes(text), text);
    assert.match(collapsed, /<details(?![^>]*open)/);
    assert(!collapsed.includes('aria-label="已掃序號"'));
    const list = expanded.match(/<ul[^>]*aria-label="已掃序號"[^>]*>(.*?)<\/ul>/)[1];
    assert.equal((list.match(/<li /g) || []).length, 3);
    for (const serial of serials) assert(list.includes(serial.split('-').slice(1).join('-')));
  } finally { session.dispose(); }
});
