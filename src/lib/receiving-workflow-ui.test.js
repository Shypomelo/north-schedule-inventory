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

test('receiving defaults to three filters with pending selected', () => {
  const { ReceivingV6Center } = load(path.resolve(__dirname, '../components/ReceivingV6Center.tsx'), {
    './UserContext': { useUser: () => ({ currentUser: { id: 'u', role: 'ADMIN' } }) },
    '@/lib/db/supabaseClient': { supabase: {} },
    '@/lib/db/receiving-v6': { createReceivingV6Api: () => ({}) },
    './ReceivingWorkModal': { ReceivingWorkBody: () => null, ReceivingWorkModal: () => null },
    './ReceivingV6Composer': { ReceivingV6Composer: () => null },
    './ReceivingV5Forms': { ActionError: () => null, PendingForm: () => null, v5Button: '', v5Primary: '' },
  });
  const html = renderToStaticMarkup(React.createElement(ReceivingV6Center));
  const tabs = html.match(/<div role="group" aria-label="收貨篩選".*?<\/div>/)?.[0] || '';
  assert.match(tabs, /待處理/);
  assert.match(tabs, /已收到/);
  assert.match(tabs, /全部/);
  assert.equal((tabs.match(/<button /g) || []).length, 3);
  assert.match(tabs, /aria-pressed="true"[^>]*>待處理/);
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

test('pending context delete uses safe RPC, blocks downstream, and removes only after success', async () => {
  global.window = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  const h = hooks();
  const data = {
    projects: [], items: [], materials: [], supplies: [{ id: 'pending', receiving_only: true, new_model: 'P401', inventory_item_id: null, project_id: null, quantity: 1, unit: '台', updated_at: '2026-09-30T00:00:00Z' }],
    batches: [], arrivals: [], lines: [], observations: [], matches: [], matchObservations: [], receipts: [],
    fulfilment: { 'SE_SUPPLY:pending': { expected: 1, fulfilled: 0, remaining: 1, active: true, remaining_status: 'ACTIVE', cancellation: null } },
    scopes: {}, scopeErrors: {}, transactions: [], closings: [],
  };
  let blocked = true, calls = 0;
  const api = { load: async () => data, deletePending: async args => { calls++; assert.equal(args.p_source_type, 'SE_SUPPLY'); assert.equal(args.p_source_id, 'pending'); if (blocked) throw Error('PENDING_DELETE_DOWNSTREAM_EXISTS'); } };
  const { ReceivingV6Center } = load(path.resolve(__dirname, '../components/ReceivingV6Center.tsx'), {
    react: h.react,
    './UserContext': { useUser: () => ({ currentUser: { id: 'u', role: 'ADMIN' } }) },
    '@/lib/db/supabaseClient': { supabase: {} },
    '@/lib/db/receiving-v6': { createReceivingV6Api: () => api },
    './ReceivingWorkModal': { ReceivingWorkBody: () => null, ReceivingWorkModal: () => null },
    './ReceivingV6Composer': { ReceivingV6Composer: () => null },
    './ReceivingV5Forms': { ActionError: () => null, PendingForm: () => null, v5Button: '', v5Primary: '' },
  });
  const render = () => { h.reset(); return ReceivingV6Center(); };
  const find = predicate => nodes(render()).find(predicate);
  await h.settle(render);
  assert(find(n => n.props['data-work-item'] === 'SE_SUPPLY:pending'));
  find(n => n.props['data-work-item'] === 'SE_SUPPLY:pending').props.onContextMenu({ preventDefault() {}, clientX: 10, clientY: 10 });
  find(n => n.props.role === 'menuitem').props.onClick();
  assert(content(render()).includes('確定刪除這筆待收資料？'));
  await find(n => n.type === 'button' && content(n) === '刪除').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert(find(n => n.props['data-work-item'] === 'SE_SUPPLY:pending'));
  assert(find(n => typeof n.props.message === 'string' && n.props.message.includes('此筆已有到貨或後續紀錄')));
  blocked = false;
  await find(n => n.type === 'button' && content(n) === '刪除').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert(!find(n => n.props['data-work-item'] === 'SE_SUPPLY:pending'));
  delete global.window;
});
