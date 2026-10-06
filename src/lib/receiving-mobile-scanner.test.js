const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');

const { ReceivingV6Composer, SerializedArrivalReview } = load(path.resolve(__dirname, '../components/ReceivingV6Composer.tsx'), {
  './BarcodeScanner': { BarcodeScanner: () => React.createElement('div', { 'data-testid': 'direct-scanner' }) },
  './ReceivingV5Forms': { ActionError: () => null, useV5Action: () => ({ busy: false, error: '', setError() {}, run() {} }), useV5Request: () => args => args, v5Field: '', v5Primary: '' },
  './ReceivingSerialControls': { InventoryItemCombobox: () => null },
  './ReceiptDateTimeInput': { ReceiptDateTimeInput: () => null },
});
const empty = () => ({ projects: [], items: [], materials: [], supplies: [], batches: [], arrivals: [], lines: [], observations: [], matches: [], matchObservations: [], receipts: [], fulfilment: {} });

test('phone diagnostics show decoder, session, and classification for two distinct codes', () => {
  const { ScannerDiagnostics } = load(path.resolve(__dirname, '../components/BarcodeScanner.tsx'));
  const html = renderToStaticMarkup(React.createElement(ScannerDiagnostics, { entries: [
    { raw: 'SE10000H-RWSKBF57', session: 'ACCEPTED', kinds: ['MODEL'] },
    { raw: 'SB4725-07515C69D-ED', session: 'REJECTED', reason: 'duplicate', kinds: ['SERIAL'] },
  ] }));
  for (const label of ['CAMERA DECODE', 'SESSION', 'CLASSIFY', 'SE10000H-RWSKBF57', 'SB4725-07515C69D-ED', 'REJECTED / duplicate', 'MODEL', 'SERIAL'])
    assert(html.includes(label));
});

test('actual arrival opens the continuous camera on the first screen', () => {
  const html = renderToStaticMarkup(React.createElement(ReceivingV6Composer, {
    data: empty(), api: {}, onClose() {}, async onSaved() {},
  }));
  assert.match(html, /data-testid="direct-scanner"/);
  assert.doesNotMatch(html, /開始一箱|>散料<|先收貨/);
  assert(!html.includes('批次輸入'));
  assert(!html.includes('有序號設備'));
  assert(!html.includes('無序號物料 分頁'));
});

test('no-barcode path keeps loose material entry and can return to the camera', () => {
  let stateIndex = 0, refIndex = 0;
  const states = [], refs = [];
  const react = { ...React,
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
  };
  const { ReceivingV6Composer: InteractiveComposer } = load(path.resolve(__dirname, '../components/ReceivingV6Composer.tsx'), {
    react,
    './useReceivingItems': { useReceivingItems: data => ({ data, createItem: async () => ({}) }) },
    './BarcodeScanner': { BarcodeScanner: () => React.createElement('div', { 'data-testid': 'direct-scanner' }) },
    './ReceivingV5Forms': { ActionError: () => null, useV5Action: () => ({ busy: false, error: '', setError() {}, run() {} }), useV5Request: () => args => args, v5Field: '', v5Primary: '' },
    './ReceivingSerialControls': { InventoryItemCombobox: () => null },
    './ReceiptDateTimeInput': { ReceiptDateTimeInput: () => null },
  });
  const render = () => { stateIndex = refIndex = 0; return InteractiveComposer({ data: empty(), api: {}, onClose() {}, async onSaved() {} }); };
  const scanner = render();
  assert.equal(scanner.props.mode, 'continuous');
  scanner.props.onNoBarcode();
  const plain = render();
  assert.match(renderToStaticMarkup(plain), /散料/);
  const back = plain.props.children[3].props.children[0];
  back.props.onClick();
  assert.equal(render().props.mode, 'continuous');
});

test('bound full PN stays visible when a serial conflicts instead of showing pending item', () => {
  const html = renderToStaticMarkup(React.createElement(SerializedArrivalReview, {
    drafts: [{ raw: '014D50C00-A1', state: 'conflict', choiceRequired: false }],
    model: { code: 'S1200-1GMYMBV' }, unknownCount: 0, resolving: false,
  }));
  assert(html.includes('S1200-1GMYMBV'));
  assert(html.includes('序號已存在'));
  assert(!html.includes('待確認品項'));
});

test('actual arrival shows serials immediately and model as secondary information', () => {
  const html = renderToStaticMarkup(React.createElement(SerializedArrivalReview, {
    drafts: [
      { raw: 'SB4725-07515C69D-ED', state: 'known', choiceRequired: false },
      { raw: 'SB4725-07515C70A-ED', state: 'known', choiceRequired: false },
    ], model: { code: 'SE10000H-RWSKBF57' }, unknownCount: 0, resolving: false,
  }));
  assert.match(html, /2 台設備/);
  assert.match(html, /aria-label="到貨序號"/);
  assert(html.indexOf('SB4725-07515C69D-ED') < html.indexOf('SE10000H-RWSKBF57'));
  assert(!html.includes('待補資料'));
  assert(!html.includes('未對應'));
  assert(!html.includes('查看序號'));
});
