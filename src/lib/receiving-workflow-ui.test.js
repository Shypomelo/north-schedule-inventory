const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : [];
const content = tree => Array.isArray(tree) ? tree.map(content).join('') : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree?.props ? content(tree.props.children) : '';
function hooks() {
  let stateIndex = 0, effectIndex = 0;
  const values = [], refs = [], deps = [], pending = [];
  return {
    react: { ...React,
      useState(initial) { const n = stateIndex++; if (!(n in values)) values[n] = typeof initial === 'function' ? initial() : initial; return [values[n], next => { values[n] = typeof next === 'function' ? next(values[n]) : next; }]; },
      useRef(initial) { const n = stateIndex++; return refs[n] ||= { current: initial }; },
      useMemo: factory => factory(), useCallback: fn => fn,
      useEffect(fn, next) { const n = effectIndex++; if (!deps[n] || next.some((value, i) => value !== deps[n][i])) { deps[n] = next; pending.push(fn); } },
    },
    reset() { stateIndex = effectIndex = 0; },
    async settle(render) { for (let n = 0; n < 4; n++) { render(); pending.splice(0).forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); } },
  };
}

test('receiving defaults to five tabs in the agreed order with pending selected', () => {
  const { ReceivingV6Center } = load(path.resolve(__dirname, '../components/ReceivingV6Center.tsx'), {
    './UserContext': { useUser: () => ({ currentUser: { id: 'u', role: 'ADMIN' } }) },
    '@/lib/db/supabaseClient': { supabase: {} },
    '@/lib/db/receiving-v6': { createReceivingV6Api: () => ({}) },
    './ReceivingWorkModal': { ReceivingWorkBody: () => null, ReceivingWorkModal: () => null },
    './ReceivingV6Composer': { ReceivingV6Composer: () => null },
    './ReceivingActionMenu': { useReceivingActionMenu: () => ({ bind: () => ({}), openFromButton() {}, popup: null }) },
    './ReceivingV5Forms': { ActionError: () => null, PendingForm: () => null, v5Button: '', v5Primary: '' },
  });
  const html = renderToStaticMarkup(React.createElement(ReceivingV6Center));
  const tabs = html.match(/<div role="tablist" aria-label="收貨分類".*?<\/div>/)?.[0] || '';
  assert.match(tabs, /待收貨[\s\S]*已收到[\s\S]*SE 供貨[\s\S]*收貨紀錄[\s\S]*提醒/);
  assert.equal((tabs.match(/<button /g) || []).length, 5);
  assert.match(tabs, /aria-selected="true"[^>]*>待收貨/);
});

test('SE supply tab renders Partner API fields, duplicate model rows and removed notices as Mock only', () => {
  const { seOrderMockResponse, seOrderViews } = load(path.resolve(__dirname, 'se-order-mock.ts'));
  const { ReceivingSEOrders } = load(path.resolve(__dirname, '../components/ReceivingSEOrders.tsx'));
  const html = renderToStaticMarkup(React.createElement(ReceivingSEOrders, {
    orders: seOrderViews(seOrderMockResponse), projects: [{ id: 'P', name: '範例北部案場 A' }],
    pending: [], query: '', focusOrderNo: null,
  }));
  assert.match(html, /7000001、7000001-2/);
  assert.match(html, /12345678901、12345678902/);
  assert.equal((html.match(/<strong>RSESU-RW0S0NNN4<\/strong>/g) || []).length, 2);
  assert.match(html, /待人工確認（partner_review）/);
  assert.match(html, /已失效（deleted）/);
  assert.match(html, /已失效（reassigned）/);
  assert.match(html, /SN 預留（UI 衍生欄位；API 不提供 SN）/);
  assert.match(html, /Mock 同名候選，待權威確認/);
  assert.doesNotMatch(html, /實際出貨日期|自動納入待收貨/);
});

test('outbound serial input is scanner friendly and project choices are hidden initially', () => {
  const { TransactionForm } = load(path.resolve(__dirname, '../components/TransactionForm.tsx'), {
    './UserContext': { useUser: () => ({ currentUser: { id: 'u', role: 'ADMIN', name: 'Tester' } }) },
    '@/lib/db': { dbAdapter: {} },
    '@/lib/db/inventory-initialization': { previewInventoryInitialization: () => Promise.resolve({}) },
  });
  const html = renderToStaticMarkup(React.createElement(TransactionForm, {
    items: [{ id: 'i', code: 'P401', name: '設備', requires_serial: true, is_active: true, unit: '台' }],
    projects: [{ id: 'p', name: '聯合案場' }], balances: [{ item_id: 'i', balance: 1 }], allSerials: [],
    initialData: { transaction_type: 'OUT', item_id: 'i', quantity: 1 },
    onSubmit: async () => {}, onCancel: () => {}, isSubmitting: false,
  }));
  assert.match(html, /role="combobox" aria-expanded="false"/);
  assert.doesNotMatch(html, /role="listbox"/);
  assert.match(html, /autoComplete="off"/i);
  assert.match(html, /autoCapitalize="characters"/i);
  assert.match(html, /spellCheck="false"/i);
});

test('typing a project name reveals quick choices and selection updates the outbound form', () => {
  const h = hooks();
  const { TransactionForm } = load(path.resolve(__dirname, '../components/TransactionForm.tsx'), {
    react: h.react,
    './UserContext': { useUser: () => ({ currentUser: { id: 'u', role: 'ADMIN', name: 'Tester' } }) },
    '@/lib/db': { dbAdapter: {} },
    '@/lib/db/inventory-initialization': { previewInventoryInitialization: () => Promise.resolve({}) },
  });
  const props = { items: [], projects: [{ id: 'p', name: '聯合案場' }, { id: 'q', name: '其他案場' }], balances: [], allSerials: [], onSubmit: async () => {}, onCancel: () => {}, isSubmitting: false };
  const render = () => { h.reset(); return TransactionForm(props); };
  const find = predicate => nodes(render()).find(predicate);
  assert(!find(n => n.props.role === 'listbox'));
  find(n => n.props.role === 'combobox').props.onChange({ target: { value: '聯' } });
  assert.equal(find(n => n.props.role === 'combobox').props['aria-expanded'], true);
  const choice = find(n => n.props.role === 'option');
  assert.equal(content(choice), '聯合案場');
  choice.props.onClick();
  assert.equal(find(n => n.props.role === 'combobox').props.value, '聯合案場');
  assert(!find(n => n.props.role === 'listbox'));
});
