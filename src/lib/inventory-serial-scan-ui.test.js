const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./test-load-ts.cjs');

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : [];
const content = tree => Array.isArray(tree) ? tree.map(content).join('') : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree?.props ? content(tree.props.children) : '';
function hooks() {
  let index = 0;
  const values = [], refs = [];
  return {
    react: {
      ...React,
      useState(initial) { const n = index++; if (!(n in values)) values[n] = typeof initial === 'function' ? initial() : initial; return [values[n], next => { values[n] = typeof next === 'function' ? next(values[n]) : next; }]; },
      useRef(initial) { const n = index++; return refs[n] ||= { current: initial }; },
      useMemo: factory => factory(), useEffect() {},
    },
    reset() { index = 0; },
  };
}

test('IN serial scanner keeps one input for Enter/Tab, rejects duplicate and overflow, and preserves submit contract', async () => {
  const h = hooks();
  const submissions = [];
  const { TransactionForm } = load(path.resolve(__dirname, '../components/TransactionForm.tsx'), {
    react: h.react,
    './UserContext': { useUser: () => ({ currentUser: { id: 'u', role: 'ADMIN', name: 'Tester' } }) },
    '@/lib/db': { dbAdapter: { lookupInventorySerial: async () => ({ result_type: 'no_match', candidates: [] }) } },
    '@/lib/db/inventory-initialization': { previewInventoryInitialization: () => Promise.resolve({}) },
  });
  const props = {
    items: [{ id: 'i', code: 'P401', name: '設備', requires_serial: true, is_active: true, unit: '台' }],
    projects: [], balances: [], allSerials: [],
    initialData: { transaction_type: 'IN', item_id: 'i', quantity: 2 },
    onSubmit: async (...args) => { submissions.push(args); }, onCancel() {}, isSubmitting: false,
  };
  const render = () => { h.reset(); return TransactionForm(props); };
  const find = predicate => nodes(render()).find(predicate);
  let focusCount = 0;
  find(node => node.props.id === 'inventory-in-serial').ref.current = { focus() { focusCount++; } };
  const input = () => find(node => node.props.id === 'inventory-in-serial');
  const scan = (serial, key) => {
    input().props.onChange({ target: { value: serial } });
    let prevented = false;
    input().props.onKeyDown({ key, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, `${key} must not leave the input or submit the form`);
    assert.equal(input().props.value, '');
  };
  const serials = () => nodes(find(node => node.props['aria-label'] === '已掃序號')).filter(node => node.type === 'li');

  assert.equal(nodes(render()).filter(node => node.props.id === 'inventory-in-serial').length, 1);
  input().props.onChange({ target: { value: 'partial' } });
  let composingEnterPrevented = false;
  input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { composingEnterPrevented = true; } });
  assert.equal(composingEnterPrevented, true);
  assert.equal(input().props.value, 'partial');
  input().props.onChange({ target: { value: '' } });
  scan('ABC-1', 'Enter');
  scan('ABC-2', 'Tab');
  assert.equal(serials().length, 2);
  assert.match(renderToStaticMarkup(render()), /已掃 <span[^>]*>2<\/span> \/ 2/);
  scan('abc-1', 'Enter');
  assert.equal(serials().length, 2);
  assert.match(content(find(node => node.props.role === 'alert')), /序號重複/);
  scan('ABC-3', 'Tab');
  assert.equal(serials().length, 2);
  assert.match(content(find(node => node.props.role === 'alert')), /已掃滿 2 筆/);
  assert.equal(submissions.length, 0);

  serials()[1].props.children[1].props.onClick();
  scan('ABC-3', 'Enter');
  assert.deepEqual(serials().map(content).map(text => text.replace('移除', '')), ['ABC-1', 'ABC-3']);
  assert(focusCount >= 5);
  await find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][1], 'ABC-1\nABC-3');
  assert.equal(submissions[0][0].pending_serial_count, 0);
  assert.equal(submissions[0][2], false);
});
