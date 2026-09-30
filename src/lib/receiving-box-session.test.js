const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { BoxScanSession, completedBoxCount } = load(path.resolve(__dirname, 'receiving-box-session.ts'));
const { resolveBoxArrival } = load(path.resolve(__dirname, 'receiving-box-arrival.ts'));
const { groupedSerialArrival } = load(path.resolve(__dirname, 'receiving-v6.ts'));
const items = [{ id: 'a', code: 'SE10000H-RWSKBF57', is_active: true, requires_serial: true }, { id: 'b', code: 'S1000-1GMXMBT-NA01', is_active: true, requires_serial: true }];
const serial = n => `SB4725-${String(n).padStart(9, '0')}-3C`;
const model = items[0].code;
const data = { items, observations: [], matchObservations: [], projects: [], materials: [], supplies: [], batches: [], arrivals: [], lines: [], matches: [], receipts: [], fulfilment: {} };
const noMatch = () => ({ result_type: 'no_match', candidate_count: 0, filtered_candidate_count: 0, candidates: [] });
const lookup = async values => values.map(noMatch);
const fill = (s, count, start = 1, m = model) => { s.add(m); for (let i = start; i < start + count; i++) s.add(serial(i)); };
for (const count of [1, 10, 20]) test(`one model + ${count} serials = one box / ${count} devices`, () => {
  const s = new BoxScanSession(items); fill(s, count); assert.equal(s.deviceCount, count);
  assert.equal(s.snapshot().completedBoxes.length, 0); s.completeBox();
  assert.equal(s.snapshot().completedBoxes.length, 1); assert.equal(s.snapshot().currentBox.serials.length, 0);
  assert.equal(s.snapshot().currentBox.model, undefined); assert.equal(s.deviceCount, count);
});
test('twenty model frames and repeated serials never inflate quantity', () => {
  const s = new BoxScanSession(items); for (let i = 0; i < 20; i++) s.add(model);
  s.add(serial(1)); s.add(serial(1)); s.add(serial(2)); assert.equal(s.deviceCount, 2);
  assert.equal(s.finish().length, 1);
});
test('two boxes of same model keep their own model and reject cross-box serials', () => {
  const s = new BoxScanSession(items); fill(s, 2); s.completeBox(); fill(s, 2, 3);
  const result = s.add(serial(1)); assert.deepEqual(result.duplicate, { serial: serial(1), boxId: 1 });
  assert.equal(s.deviceCount, 4); const boxes = s.finish(); assert.equal(boxes.length, 2); assert(boxes.every(b => b.model.normalized === model));
});
test('model alone is zero devices and cannot quietly finish a box', () => {
  const s = new BoxScanSession(items); s.add(model); assert.equal(s.deviceCount, 0);
  assert.throws(() => s.completeBox(), /尚未掃到序號/); assert.throws(() => s.finish(), /尚未掃到序號/);
});
test('different model never overwrites and finishing old box transfers new model to next box', () => {
  const s = new BoxScanSession(items); fill(s, 1); assert.equal(s.add(items[1].code).conflict, true);
  assert.equal(s.snapshot().currentBox.model.normalized, model); assert.throws(() => s.finish(), /不同型號/);
  s.completeBox(); assert.equal(s.snapshot().currentBox.model.normalized, items[1].code);
});
test('explicit model confirmation and conflict payload do not silently assign serials', () => {
  const s = new BoxScanSession(items); fill(s, 1); s.add(`${items[1].code}|${serial(2)}`);
  assert.equal(s.deviceCount, 1); s.confirmModel(true); s.add(serial(2)); assert.equal(s.deviceCount, 2);
  assert.equal(s.snapshot().currentBox.model.itemId, 'b');
});
test('cross-frame 3 + 4 + 3 and native multi-code accumulate without auto completion', () => {
  const s = new BoxScanSession(items); for (const [start, n] of [[1,3],[4,4],[8,3]]) fill(s, n, start);
  assert.equal(s.deviceCount, 10); assert.equal(s.snapshot().completedBoxes.length, 0);
  const native = new BoxScanSession(items); native.add(`${model}|${serial(1)}|${serial(2)}`);
  assert.equal(native.deviceCount, 2); assert.equal(native.snapshot().currentBox.model.itemId, 'a');
});
test('current serial deletion decrements count and immediately releases dedup', () => {
  const s = new BoxScanSession(items); fill(s, 2); s.deleteSerial(1, serial(1)); assert.equal(s.deviceCount, 1);
  assert.equal(s.add(serial(1)).accepted, true); assert.equal(s.deviceCount, 2);
});
test('deleting entire completed box updates both counts and releases serials', () => {
  const s = new BoxScanSession(items); fill(s, 2); s.completeBox(); fill(s, 1, 3); s.completeBox();
  s.deleteBox(1); assert.equal(completedBoxCount(s.snapshot().completedBoxes), 1); assert.equal(s.deviceCount, 1);
  assert.equal(s.add(serial(1)).accepted, true);
});
test('completed serial deletion releases identity and empty completed box requires correction', () => {
  const s = new BoxScanSession(items); fill(s, 2); s.completeBox(); s.deleteSerial(1, serial(1));
  assert.equal(s.deviceCount, 1); assert.equal(s.add(serial(1)).accepted, true); s.clearCurrent();
  s.deleteSerial(1, serial(2)); assert.equal(s.deviceCount, 0); assert.equal(completedBoxCount(s.snapshot().completedBoxes), 0);
  assert.equal(s.snapshot().completedBoxes[0].status, 'incomplete'); assert.throws(() => s.finish(), /未完成/);
  s.reopenBox(1); s.add(serial(2)); assert.equal(s.finish().length, 1);
});
test('reset clears model, serials, unknown and conflicts without affecting completed boxes', () => {
  const s = new BoxScanSession(items); fill(s, 1); s.completeBox(); fill(s, 1, 2); s.add('27382202'); s.add(items[1].code);
  s.clearCurrent(); assert.deepEqual(s.snapshot().currentBox, { id: 2, model: undefined, serials: [], unknown: [], status: 'open' });
  assert.equal(s.snapshot().conflict, undefined); assert.equal(s.deviceCount, 1); assert.equal(s.add(serial(2)).accepted, true);
});
test('canonical short aliases dedupe and deletion releases both representations; distinct full identities stay distinct', () => {
  const s = new BoxScanSession(items); s.add(serial(1)); assert(s.add('000000001-3C').duplicate);
  s.deleteSerial(1, serial(1)); assert.equal(s.add('000000001-3C').accepted, true);
  s.clearCurrent(); s.add(serial(1)); s.add('TK4725-000000001-3C'); assert.equal(s.deviceCount, 2);
});
test('snapshot survives return to scanner and mutations cannot affect the prior snapshot', () => {
  const s = new BoxScanSession(items); fill(s, 1); s.finish(); const snapshot = s.snapshot(); s.close();
  assert.throws(() => s.deleteSerial(1, serial(1)), /掃描已結束/);
  const resumed = new BoxScanSession(items, snapshot); resumed.deleteBox(1);
  assert.equal(snapshot.completedBoxes.length, 1); assert.equal(resumed.add(serial(1)).accepted, true);
});
test('three boxes / 21 serials produces actual arrival quantity 21, preserving per-box model association', async () => {
  const s = new BoxScanSession(items); fill(s, 1); s.completeBox(); fill(s, 10, 2, items[1].code); s.completeBox(); fill(s, 10, 12, items[1].code);
  const boxes = s.finish(); assert.equal(boxes.length, 3);
  const drafts = await resolveBoxArrival(boxes, data, lookup);
  assert.equal(drafts[0].itemId, 'a'); assert(drafts.slice(1).every(d => d.itemId === 'b'));
  const result = groupedSerialArrival(drafts, []); assert.deepEqual(result.lines.map(l => l.quantity), [1,20]);
  assert.equal(result.lines.reduce((n,l) => n + l.raw_serials.length, 0), 21);
  assert(result.lines.every(l => !('box_id' in l)));
});
test('frontend deletions cause zero DB mutation; only surviving serials enter read-only lookup', async () => {
  let reads = 0; const s = new BoxScanSession(items); fill(s, 3); s.deleteSerial(1, serial(1)); s.completeBox();
  fill(s, 1, 4); s.completeBox(); s.deleteBox(2); fill(s, 1, 5); s.clearCurrent();
  const drafts = await resolveBoxArrival(s.finish(), data, async values => { reads++; assert.deepEqual(values, [serial(2), serial(3)]); return values.map(noMatch); });
  assert.equal(reads, 1); assert.equal(drafts.length, 2);
});
test('lookup conflict and model mismatch remain conflicts instead of being overwritten by box hint', async () => {
  const s = new BoxScanSession(items); fill(s, 1);
  const result = await resolveBoxArrival(s.finish(), data, async values => values.map(() => ({ ...noMatch(), result_type: 'ambiguous' })));
  assert.equal(result[0].state, 'conflict'); assert.equal(result[0].itemId, null);
});
test('read-only resolution failures preserve the full editable box session for retry', async () => {
  const s = new BoxScanSession(items); fill(s, 1); const boxes = s.finish();
  await assert.rejects(resolveBoxArrival(boxes, data, async () => { throw Error('offline'); }), /offline/);
  s.deleteSerial(1, serial(1)); assert.equal(s.deviceCount, 0); assert.equal(s.add(serial(1)).accepted, true);
});
