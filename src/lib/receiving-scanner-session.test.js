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

test('quiet-window resolve leaves session open for new serials while pending and afterward', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const batches = [];
  const session = new ScannerSession(items, batch => { batches.push(batch); return batches.length === 1 ? first : Promise.resolve(); }, () => {}, 10000);
  session.add('P401'); session.flush();
  assert.equal(session.add('ABC123456-01'), true);
  session.flush();
  release();
  await first;
  assert.equal(session.add('ABC123457-01'), true);
  session.flush();
  assert.deepEqual(session.codes.map(code => code.kind), ['MODEL', 'SERIAL', 'SERIAL']);
  assert.equal(batches.length, 3);
  session.dispose();
});

test('repeated model frames do not block the next serial', () => {
  const session = new ScannerSession(items, () => {}, () => {}, 10000);
  for (let frame = 0; frame < 3; frame++) session.add('P401');
  assert.equal(session.add('ABC123456-01'), true);
  assert.deepEqual(session.codes.map(code => code.kind), ['MODEL', 'SERIAL']);
  session.dispose();
});

test('diagnostic result identifies classification and duplicate rejection', () => {
  const session = new ScannerSession(items, () => {}, () => {}, 10000);
  const first = session.addDetailed('P401');
  const repeated = session.addDetailed('P401');
  const second = session.addDetailed('ABC123456-01');
  assert.deepEqual([first.accepted, first.classified[0].kind], [true, 'MODEL']);
  assert.deepEqual([repeated.accepted, repeated.reason, repeated.classified[0].kind], [false, 'duplicate', 'MODEL']);
  assert.deepEqual([second.accepted, second.classified[0].kind], [true, 'SERIAL']);
  session.dispose();
  assert.equal(session.addDetailed('ABC123457-01').reason, 'closed');
});

test('reopened session retains prior codes and deduplicates them', () => {
  const original = new ScannerSession(items, () => {}, () => {}, 10000);
  original.add('P401'); original.add('ABC123456-01'); original.flush(); original.dispose();
  const resumed = new ScannerSession(items, () => {}, () => {}, 10000, original.codes);
  assert.equal(resumed.add('P401'), false);
  assert.equal(resumed.add('ABC123457-01'), true);
  assert.equal(resumed.codes.length, 3);
  resumed.dispose();
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
test('fresh arrival identity read finds active observations without considering retired or planned rows', async () => {
  const calls = [];
  const query = {
    select(columns) { assert.equal(columns, 'normalized_serial'); return this; },
    in(column, values) { calls.push([column, values]); return this; },
    not(column, operator, value) { calls.push([column, operator, value]); return this; },
    is(column, value) { calls.push([column, value]); return Promise.resolve({ data: [{ normalized_serial: '000000001-3C' }], error: null }); },
  };
  const api = createReceivingV5Api({ from(table) { assert.equal(table, 'receiving_serial_entries'); return query; } });
  const active = await api.activeArrivalSerials(['000000001-3C', '000000001-3C']);
  assert.deepEqual(active, ['000000001-3C']);
  assert.deepEqual(calls, [
    ['normalized_serial', ['000000001-3C']],
    ['arrival_line_id', 'is', null],
    ['retired_at', null],
  ]);
});
