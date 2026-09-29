const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { ScannerSession, classifyScannerCode } = load(path.resolve(__dirname, 'receiving-scanner-session.ts'));
const { createReceivingV5Api } = load(path.resolve(__dirname, 'db/receiving-v5.ts'));
const items = [{ id: 'p', code: 'P401', is_active: true }, { id: 'collision', code: 'ABC12345-01', is_active: true }];

test('scanner classifies exact models and all supported serial forms without guessing', () => {
  assert.equal(classifyScannerCode(' p401 ', items).kind, 'MODEL');
  for (const code of ['ABC12345-02', 'ABC123456-01', 'SJ1823A-03068530E-F9'])
    assert.equal(classifyScannerCode(code, items).kind, 'SERIAL');
  assert.equal(classifyScannerCode('ABC12345-01', items).kind, 'UNKNOWN');
  assert.equal(classifyScannerCode('random', items).kind, 'UNKNOWN');
});

test('cross-frame captures form one deduplicated batch', () => {
  const batches = [], changes = [];
  const session = new ScannerSession(items, batch => batches.push(batch), codes => changes.push(codes), 10000);
  session.add('P401');
  session.add('abc123456-01');
  for (let n = 0; n < 20; n++) session.add('ABC123456-01');
  session.add('ABC123457-01');
  session.add('ABC123458-01');
  session.flush();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(code => code.kind), ['MODEL', 'SERIAL', 'SERIAL', 'SERIAL']);
  assert.equal(changes.at(-1).length, 4);
  session.dispose();
});

test('session deduplicates across batches and closing discards pending work', () => {
  const batches = [];
  const session = new ScannerSession(items, batch => batches.push(batch), () => {}, 10000);
  session.add('ABC123456-01'); session.flush();
  session.add('abc123456-01'); session.flush();
  session.add('not known'); session.dispose();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});

test('failed lookup releases serial for a retry while preserving model evidence', async () => {
  let calls = 0;
  const session = new ScannerSession(items, async () => { calls++; if (calls === 1) throw new Error('offline'); }, () => {}, 10000);
  session.add('P401'); session.add('ABC123456-01'); session.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(session.codes.map(code => code.kind), ['MODEL']);
  assert.equal(session.add('ABC123456-01'), true);
  session.flush();
  assert.equal(calls, 2);
  session.dispose();
});

test('one indexed batch read preserves exact, short and ambiguous identities', async () => {
  let calls = 0;
  const serials = [
    { id: 'a', item_id: 'p', serial_number: 'SJ1823A-03068530E-F9', normalized_full: 'SJ1823A-03068530E-F9', short_key: '03068530E-F9', status: '在庫' },
    { id: 'b', item_id: 'p', serial_number: 'TK1823A-03068530E-F9', normalized_full: 'TK1823A-03068530E-F9', short_key: '03068530E-F9', status: '在庫' },
  ];
  const client = { from(table) {
    assert.equal(table, 'inventory_serials'); calls++;
    const query = { select(){ return query; }, or(filter){ assert.match(filter, /normalized_full\.in/); assert.match(filter, /short_key\.in/); return query; }, limit(n){ assert.equal(n, 1001); return Promise.resolve({ data: serials, error: null }); } };
    return query;
  } };
  const result = await createReceivingV5Api(client).lookupBatch(['SJ1823A-03068530E-F9', '03068530E-F9', 'ABC123456-01']);
  assert.equal(calls, 1);
  assert.deepEqual(result.map(r => r.result_type), ['ambiguous', 'ambiguous', 'no_match']);
});
