const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');
const { parseScannedPayload } = load(path.resolve(__dirname, 'receiving-scanned-payload.ts'));
const { ScannerSession, scannerCounts } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));
const { ScannerCaptureResults } = load(path.resolve(__dirname, '../components/BarcodeScanner.tsx'));
const items = [{ id: 'model', code: 'SE5000H-RW000BEN4', is_active: true }, { id: 'overlap', code: 'ABC12345-01', is_active: true }];

function scan(raw, frames = 1) {
  const batches = [];
  const session = new ScannerSession(items, batch => batches.push(batch), () => {}, 10000);
  for (let i = 0; i < frames; i++) session.add(raw);
  session.flush(); session.dispose();
  return { codes: session.codes, batches };
}

test('plain model and serial remain individual candidates', () => {
  assert.deepEqual(scan('SE5000H-RW000BEN4').codes.map(c => c.kind), ['MODEL']);
  for (const serial of ['ABC12345-02', 'ABC123456-01', 'SJ1823A-03068530E-F9'])
    assert.deepEqual(scan(serial).codes.map(c => c.kind), ['SERIAL']);
});

test('pipe, newline, tab and ASCII GS delimit candidates without joining fields', () => {
  for (const separator of ['|', '\n', '\t', '\x1d']) {
    const raw = `SE5000H-RW000BEN4${separator}ABC123456-01`;
    assert.deepEqual(parseScannedPayload(raw).candidates, ['SE5000H-RW000BEN4', 'ABC123456-01']);
    assert.deepEqual(scan(raw).codes.map(c => c.kind), ['MODEL', 'SERIAL']);
  }
});

test('one payload may add a model and two serials, deduplicated across frames', () => {
  const raw = ' SE5000H-RW000BEN4 | ABC123456-01 | ABC123457-01 | abc123456-01 ';
  const result = scan(raw, 20);
  assert.deepEqual(result.codes.map(c => c.kind), ['MODEL', 'SERIAL', 'SERIAL']);
  assert.equal(result.batches.length, 1);
  assert.deepEqual(scannerCounts(result.codes), { total: 3, model: 1, serial: 2, unknown: 0 });
});

test('structural metadata stays quiet, while uncertain fields preserve one raw UNKNOWN', () => {
  assert.deepEqual(scan('01|20260626|D|SE5000H-RW000BEN4|ABC123456-01').codes.map(c => c.kind), ['MODEL', 'SERIAL']);
  const observed = '01|9095343842201|01|538158290600|N|0|01|01||33127\nD|20260626|01|0||||||||';
  const parsed = parseScannedPayload(observed);
  assert.deepEqual(parsed.candidates, ['01', '9095343842201', '538158290600', 'N', '0', '33127', 'D', '20260626']);
  const result = scan(observed);
  assert.deepEqual(result.codes.map(c => c.kind), ['UNKNOWN']);
  assert.equal(result.codes[0].raw, observed);
  assert.equal(result.batches.length, 1);
});

test('unknown fragments in a recognized composite retain only one raw evidence row', () => {
  const raw = 'SE5000H-RW000BEN4|ABC123456-01|9095343842201|33127';
  assert.deepEqual(scan(raw).codes.map(c => c.kind), ['MODEL', 'SERIAL', 'UNKNOWN']);
});

test('a model that looks like a formal serial stays UNKNOWN', () => {
  assert.deepEqual(scan('ABC12345-01').codes.map(c => c.kind), ['UNKNOWN']);
});

test('serial-first summary expands and collapses inline, with model secondary and UNKNOWN collapsed', () => {
  const codes = scan('SE5000H-RW000BEN4|ABC123456-01|33127').codes;
  const collapsed = renderToStaticMarkup(React.createElement(ScannerCaptureResults, { codes }));
  const expanded = renderToStaticMarkup(React.createElement(ScannerCaptureResults, { codes, expanded: true }));
  assert.match(collapsed, /已掃 3/);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /aria-label="最新序號"/);
  assert(!collapsed.includes('aria-label="已掃序號"'));
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /aria-label="已掃序號"/);
  assert(expanded.indexOf('ABC123456-01') < expanded.indexOf('SE5000H-RW000BEN4'));
  assert.match(collapsed, /<details(?![^>]*open)/);
  assert.match(collapsed, /<summary[^>]*>待確認 1/);
});
