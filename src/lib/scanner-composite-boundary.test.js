const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');
const { parseScannedPayload } = load(path.resolve(__dirname, 'receiving-scanned-payload.ts'));
const { ScannerSession } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));
const { BoxScanSession } = load(path.resolve(__dirname, 'receiving-box-session.ts'));
const { BoxScanControls } = load(path.resolve(__dirname, '../components/BoxScanControls.tsx'));
const { BarcodeCamera, decodeFallbackFrame } = load(path.resolve(__dirname, 'barcode-camera.ts'));

const modelA = 'S650B-1GM4MBM';
const modelB = 'SE10000H-RWSKBF57';
const items = [{ id: 'a', code: modelA }, { id: 'b', code: modelB }];
const serial = index => `SZ4723-014D50C${index.toString(16).toUpperCase().padStart(2, '0')}-A1`;
const serials = Array.from({ length: 10 }, (_, index) => serial(index));
const renderBox = session => renderToStaticMarkup(React.createElement(BoxScanControls, {
  snapshot: session.snapshot(), onDeleteSerial() {}, onClear() {}, onComplete() {}, onDeleteBox() {},
  onReopen() {}, onConfirmModel() {}, onResolveUnknown() {},
}));

test('plain SN and PN stay single tokens', () => {
  const box = new BoxScanSession(items);
  assert.deepEqual(parseScannedPayload(serial(0)).candidates, [serial(0)]);
  assert.deepEqual(parseScannedPayload(modelA).candidates, [modelA]);
  assert.deepEqual(box.add(modelA).classified.map(code => code.kind), ['MODEL']);
  assert.deepEqual(box.add(serial(0)).classified.map(code => code.kind), ['SERIAL']);
});

test('semicolon, CRLF and GS split serials without splitting their dashes', () => {
  for (const separator of [';', '\r\n', '\x1d']) {
    const box = new BoxScanSession(items);
    assert.deepEqual(parseScannedPayload(`${serial(0)}${separator}${serial(1)}`).candidates, serials.slice(0, 2));
    box.add(`${serial(0)}${separator}${serial(1)}`);
    assert.equal(box.deviceCount, 2);
    assert.equal(box.snapshot().currentBox.unknown.length, 0);
  }
});

test('ten serials in one 2D payload add ten devices and render a compact list', () => {
  const box = new BoxScanSession(items);
  const result = box.add(serials.join(';'));
  assert.equal(result.classified.length, 10);
  assert(result.classified.every(code => code.kind === 'SERIAL'));
  assert.equal(box.deviceCount, 10);
  assert.equal(box.snapshot().currentBox.unknown.length, 0);
  const html = renderBox(box);
  assert.match(html, /目前這箱/);
  assert.match(html, /10 台/);
  assert.match(html, /已掃序號 10/);
  assert.doesNotMatch(html, /待確認條碼/);
  assert.doesNotMatch(html, /SZ4723.*;SZ4723/);
});

test('mixed PN, ten SN and one malformed token classify independently', () => {
  const box = new BoxScanSession(items);
  const result = box.add(`PN: ${modelA};${serials.join(';')};BAD TOKEN`);
  assert.deepEqual(result.classified.map(code => code.kind), ['MODEL', ...Array(10).fill('SERIAL'), 'UNKNOWN']);
  assert.equal(box.snapshot().currentBox.model.normalized, modelA);
  assert.equal(box.deviceCount, 10);
  assert.deepEqual(box.snapshot().currentBox.unknown.map(code => code.raw), ['BAD TOKEN']);
  const malformedOnly = new BoxScanSession(items);
  assert.deepEqual(malformedOnly.add('BAD TOKEN').classified.map(code => code.kind), ['UNKNOWN']);
});

test('duplicate inside composite and later individual decode count once', () => {
  const box = new BoxScanSession(items);
  box.add(`${serial(0)};${serial(0)};${serial(1)}`);
  assert.equal(box.deviceCount, 2);
  assert.deepEqual(box.add(serial(0)).duplicate, { serial: '014D50C00-A1', boxId: 1 });
  assert.equal(box.deviceCount, 2);
});

test('same model is scoped to each box while serial identity spans the session', () => {
  const box = new BoxScanSession(items);
  assert.equal(box.add(modelA).accepted, true);
  assert.equal(box.add(modelA).accepted, false);
  box.add(`${serial(0)};${serial(1)}`);
  box.completeBox();
  assert.deepEqual(box.snapshot().currentBox, { id: 2, model: undefined, serials: [], unknown: [], status: 'open' });
  assert.equal(box.add(modelA).accepted, true);
  box.add(`${serial(2)};${serial(3)}`);
  assert.deepEqual(box.add(serial(0)).duplicate, { serial: '014D50C00-A1', boxId: 1 });
  assert.equal(box.snapshot().currentBox.model.normalized, modelA);
  assert.equal(box.deviceCount, 4);
  box.completeBox();
  assert.equal(box.add(modelB).accepted, true);
  assert.equal(box.snapshot().currentBox.model.normalized, modelB);
});

test('completing a conflicted box clears pending classification before the next box', () => {
  const box = new BoxScanSession(items);
  box.add(modelA);
  box.add(serial(0));
  assert.equal(box.add(modelB).conflict, true);
  box.completeBox();
  assert.equal(box.snapshot().currentBox.model, undefined);
  assert.equal(box.snapshot().conflict, undefined);
  assert.equal(box.add(modelA).accepted, true);
});

test('ten completed boxes do not enter a new classification or pending resolve batch', () => {
  const box = new BoxScanSession(items);
  for (let index = 0; index < 10; index++) {
    box.add(modelA);
    box.add(serial(index));
    box.completeBox();
  }
  const completed = box.snapshot().completedBoxes;
  const result = box.add(modelA);
  assert.deepEqual(result.classified.map(code => code.raw), [modelA]);
  assert.strictEqual(box.snapshot().completedBoxes, completed);
  const batches = [];
  const scanner = new ScannerSession(items, codes => batches.push(codes), () => {}, 10000);
  scanner.add(`${serial(0)};${serial(1)}`);
  scanner.flush();
  scanner.add(`${serial(0)};${serial(2)}`);
  scanner.flush();
  assert.deepEqual(batches.map(batch => batch.map(code => code.normalized)), [
    ['014D50C00-A1', '014D50C01-A1'], ['014D50C02-A1'],
  ]);
  scanner.dispose();
});

test('ZXing priority tries 1D ROI first, retains periodic 2D, and stays bounded', () => {
  const video = { videoWidth: 1000, videoHeight: 600 };
  const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage() {} }) };
  const calls = [];
  const decoder = {
    decode() { throw Error('generic decoder should not run'); },
    decode1D(source) { calls.push(source === canvas ? '1D ROI' : '1D frame'); return ['CODE128']; },
    decode2D(source) { calls.push(source === video ? '2D frame' : '2D ROI'); return ['2D;COMPOSITE']; },
  };
  assert.deepEqual(decodeFallbackFrame(video, decoder, canvas, 0), ['CODE128', '2D;COMPOSITE']);
  assert.deepEqual(calls, ['1D ROI', '2D frame']);
  calls.length = 0;
  assert.deepEqual(decodeFallbackFrame(video, decoder, canvas, 1), ['CODE128']);
  assert.deepEqual(calls, ['1D ROI']);
});

test('completing a box resets camera raw scope without restarting the camera', async () => {
  const queue = [];
  const values = [];
  let starts = 0, stops = 0;
  const video = { readyState: 2, videoWidth: 0, videoHeight: 0, srcObject: null, play: async () => {}, pause() {} };
  const camera = new BarcodeCamera(video, raw => values.push(raw), () => {}, () => {}, {
    getUserMedia: async () => { starts++; return { getTracks: () => [{ stop() { stops++; } }] }; },
    loadDecoder: async () => ({ decode: () => [modelA] }),
    schedule: callback => { queue.push(callback); return queue.length; }, clearSchedule() {},
  }, 'continuous');
  await camera.start();
  assert.deepEqual(values, [modelA]);
  queue.shift()();
  assert.deepEqual(values, [modelA]);
  camera.beginBox();
  queue.shift()();
  assert.deepEqual(values, [modelA, modelA]);
  assert.equal(starts, 1);
  assert.equal(stops, 0);
  camera.dispose();
});
