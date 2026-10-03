const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { pendingRows, actualRows, searchPending, searchActual, resolveArrivalSerial, serialDraftLines, serialsAlias, receivingError } = load(path.resolve(__dirname, 'receiving-v5.ts'));
const { parseSerialBatch } = load(path.resolve(__dirname, 'receiving-serial-draft.ts'));
const { createReceivingV5Api } = load(path.resolve(__dirname, 'db/receiving-v5.ts'));
const item = { id: 'item', code: 'P401', name: '設備', is_active: true, requires_serial: true };
const empty = () => ({ projects: [{ id: 'p', name: '北港案場' }], items: [item], batches: [], materials: [], supplies: [], arrivals: [], lines: [], observations: [], matches: [], matchObservations: [], receipts: [], fulfilment: {} });
const noMatch = { result_type: 'no_match', candidates: [], candidate_count: 0 };
const pending = (data, id = 's', quantity = 20, fulfilled = 0) => {
  data.supplies.push({ id, inventory_item_id: 'item', quantity, unit: '台', receiving_only: true, project_id: 'p' });
  data.fulfilment['SE_SUPPLY:' + id] = { expected: quantity, fulfilled, remaining: quantity - fulfilled, active: quantity > fulfilled, remaining_status: 'ACTIVE', cancellation: null };
};
const arrival = (data, id, quantity, state = 'POSTED') => {
  data.arrivals.push({ id, actual_received_at: '2026-09-26T10:00:00Z', project_id: 'p' });
  data.lines.push({ id: id + '-line', arrival_id: id, quantity, inventory_item_id: state === 'POSTED' ? 'item' : null, resolution_state: state, receipt_id: state === 'POSTED' ? id + '-receipt' : null });
};
test('V5 pending is authoritative fulfilment, never OFFICE receipt accumulation', () => {
  const d = empty(); pending(d, 's', 20, 8);
  d.receipts.push({ id: 'legacy', source_type: 'SE_SUPPLY', se_supply_record_id: 's', quantity_received: 99, event_type: 'RECEIVE', receipt_location: 'OFFICE' });
  d.supplies.push({ id: 'canonical-se', receiving_only: false });
  const rows = pendingRows(d); assert.equal(rows.length, 1); assert.equal(rows[0].fulfilment.fulfilled, 8); assert.equal(rows[0].fulfilment.remaining, 12);
});
test('partial 8 then 5 leaves pending 13/20, distinct actual line identities, and cancellation evidence', () => {
  const d = empty(); pending(d, 's', 20, 13); arrival(d, 'a1', 8); arrival(d, 'a2', 5);
  assert.deepEqual(actualRows(d).map(a => a.quantity).sort((a,b) => a-b), [5,8]);
  assert.equal(new Set(actualRows(d).map(a => a.key)).size, 2);
  const f = d.fulfilment['SE_SUPPLY:s']; assert.equal(pendingRows(d)[0].fulfilment.remaining, 7);
  f.active = false; f.remaining_status = 'CANCELLED'; f.cancellation = { cancelled_remaining: 7, fulfilled_at_cancellation: 13 };
  assert.equal(pendingRows(d).filter(p => p.fulfilment.active).length, 0);
  assert.equal(pendingRows(d)[0].fulfilment.expected, 20); assert.equal(actualRows(d).length, 2);
});
test('legacy adapter deduplicates both linkage directions, excludes reversal/SITE, preserves unknown date', () => {
  const d = empty(); arrival(d, 'a', 8);
  const receipt = { id: 'legacy', source_type: 'SE_SUPPLY', event_type: 'RECEIVE', quantity_received: 4, receipt_location: 'OFFICE', received_at: null };
  d.receipts = [receipt, receipt, { ...receipt, id: 'a-receipt' }, { ...receipt, id: 'linked', arrival_line_id: 'a-line' }, { ...receipt, id: 'reversal', event_type: 'REVERSAL', reversal_of_id: 'legacy', quantity_received: 1 }, { ...receipt, id: 'site', receipt_location: 'SITE' }];
  const rows = actualRows(d); assert.equal(rows.length, 2); const legacy = rows.find(r => r.state === 'LEGACY');
  assert.equal(legacy.quantity, 4); assert.equal(legacy.reversed, 1); assert.equal(legacy.at, null);
});
test('pending and actual search use their own observations, never move planning identities', () => {
  const d = empty(); pending(d); arrival(d, 'a', 1, 'UNRESOLVED');
  d.observations = [{ id: 'e1', se_supply_record_id: 's', normalized_serial: 'PRE00001-AA' }, { id: 'e2', arrival_line_id: 'a-line', normalized_serial: 'ACT00001-AA' }];
  assert(searchPending(pendingRows(d)[0], 'PRE00001')); assert(!searchPending(pendingRows(d)[0], 'ACT00001'));
  assert(searchActual(actualRows(d)[0], 'ACT00001')); assert(searchActual(actualRows(d)[0], '北港'));
});
test('serial-first unknown, safe preregistered identity, and canonical conflicts remain distinct', () => {
  const e = { id: 'e', normalized_serial: '7515CA50-A4', inventory_item_id: 'item' };
  assert.equal(resolveArrivalSerial('7515CA50-A4', noMatch, [], [item]).state, 'unknown');
  assert.equal(resolveArrivalSerial('7515CA50-A4', noMatch, [e], [item]).itemId, 'item');
  for (const result_type of ['unique_match', 'ambiguous', 'filtered_out', 'potential_same_identity']) assert.equal(resolveArrivalSerial('7515CA50-A4', { result_type }, [e], [item]).state, 'conflict');
  assert.throws(() => resolveArrivalSerial('7515', noMatch, [], [item]), /格式/);
  assert.throws(() => resolveArrivalSerial('7515CA50-A4', noMatch, [{ ...e, arrival_line_id: 'prior' }], [item]), /已有到貨/);
});
test('canonical alias contract never uses substrings or merges two full identities', () => {
  assert(serialsAlias('0306856C0-AE', 'SJ1823A-0306856C0-AE'));
  assert(!serialsAlias('SJ1823A-0306856C0-AE', 'SJ1824A-0306856C0-AE'));
  assert(!serialsAlias('6856', '0306856C0-AE'));
  assert.equal(resolveArrivalSerial('0306856C0-AE', noMatch, [{ normalized_serial: 'SJ1823A-0306856C0-AE', inventory_item_id: 'item' }], [item]).raw, 'SJ1823A-0306856C0-AE');
});
test('mixed serial draft posts known groups and persists individually completable unknowns', () => {
  const lines = serialDraftLines([{raw:'7515CA50-A4',itemId:'item'},{raw:'7515CACE-22',itemId:'item'},{raw:'UNKNOWN1-AA',itemId:null},{raw:'UNKNOWN2-AA',itemId:null}]);
  assert.deepEqual(lines.map(l=>l.quantity), [2,1,1]); assert.equal(lines.filter(l=>l.inventory_item_id === null).length, 2);
  assert.deepEqual(parseSerialBatch('7515CA50-A4,7515CACE-22\t0306856C0-AE\nUNKNOWN1-AA'), ['7515CA50-A4','7515CACE-22','0306856C0-AE','UNKNOWN1-AA']);
});
test('controlled RPC error messages preserve project/match meaning', () => {
  assert.equal(receivingError(new Error('ARRIVAL_PROJECT_CONFLICT_WITH_MATCH')), '此到貨已對應其他案件的待收，請先調整待收對應。');
  assert.match(receivingError(new Error('MATCH_LINE_VERSION_CONFLICT')), /重新整理/);
});
test('API commands use metadata/first-post/final-set/cancel contracts and never mutate inventory directly', async () => {
  const calls = []; const api = createReceivingV5Api({ rpc: async (name,args) => { calls.push({name,args}); return {data:{},error:null}; }, from(){throw new Error('unexpected direct write');} });
  await api.create({p_request_id:'r0',p_actual_received_at:'2026-10-04T00:00:00Z',p_lines:[{inventory_item_id:'i',quantity:1}],p_project_id:null,p_matches:[]});
  await api.metadata({p_request_id:'r1',p_arrival_id:'a',p_expected_version:4,p_project_id:null,p_notes:'x'});
  await api.complete({p_request_id:'r2',p_line_id:'l',p_item_id:'i'});
  await api.replaceMatches({p_request_id:'r3',p_line_id:'l',p_expected_version:3,p_matches:[]});
  await api.cancelRemaining({p_request_id:'r4',p_source_type:'SE_SUPPLY',p_source_id:'p',p_reason:null});
  assert.deepEqual(calls.map(c=>c.name), ['create_receiving_arrival_legacy_compat','update_receiving_arrival_metadata','complete_receiving_arrival_line_legacy_compat','replace_receiving_arrival_matches','cancel_receiving_pending_remaining']);
  assert.equal(calls[0].args.p_match_all_or_nothing, false);
  assert.deepEqual(calls[3].args.p_matches, []);
});

test('bridge create and complete keep the old actual-row projection POSTED or UNRESOLVED', async () => {
  const data = empty(), calls = []; let inventoryIns = 0, next = 0;
  const client = { rpc: async (name, args) => {
    calls.push(name);
    if (name === 'create_receiving_arrival_legacy_compat') {
      const arrivalId = `arrival-${++next}`;
      const arrival = { id: arrivalId, actual_received_at: args.p_actual_received_at, project_id: null };
      const lines = args.p_lines.map((spec, index) => {
        const known = Boolean(spec.inventory_item_id);
        const line = { id: `${arrivalId}-${index}`, arrival_id: arrivalId, quantity: spec.quantity,
          unit: known ? '台' : null, inventory_item_id: spec.inventory_item_id || null,
          resolution_state: known ? 'POSTED' : 'UNRESOLVED', receipt_id: known ? `${arrivalId}-receipt` : null };
        if (known) inventoryIns++;
        return line;
      });
      data.arrivals.push(arrival); data.lines.push(...lines);
      return { data: { arrival, lines, matches: [] }, error: null };
    }
    if (name === 'complete_receiving_arrival_line_legacy_compat') {
      const line = data.lines.find(row => row.id === args.p_line_id);
      Object.assign(line, { inventory_item_id: args.p_item_id, unit: '台',
        resolution_state: 'POSTED', receipt_id: `${line.id}-receipt` });
      inventoryIns++;
      return { data: { ...line }, error: null };
    }
    throw Error(`unexpected RPC ${name}`);
  } };
  const api = createReceivingV5Api(client);
  const created = await api.create({ p_request_id: 'create', p_actual_received_at: '2026-10-04T00:00:00Z',
    p_lines: [{ inventory_item_id: 'item', quantity: 1 }, { inventory_item_id: null, quantity: 1 }],
    p_project_id: null, p_matches: [] });
  assert.deepEqual(actualRows(data).map(row => row.state), ['POSTED', 'UNRESOLVED']);
  assert.equal(inventoryIns, 1);
  const completed = await api.complete({ p_request_id: 'complete', p_line_id: created.lines[1].id, p_item_id: 'item' });
  assert.equal(completed.resolution_state, 'POSTED');
  assert.deepEqual(actualRows(data).map(row => row.state), ['POSTED', 'POSTED']);
  assert.equal(inventoryIns, 2);
  assert.deepEqual(calls, ['create_receiving_arrival_legacy_compat', 'complete_receiving_arrival_line_legacy_compat']);
});

function readClient(tables, fulfilments = {}, lookups = {}) {
  const reads=[];
  return { reads, from(table){const filters=[];let start=0,end=Infinity;const q={select(){return q},order(){return q},eq(k,v){filters.push([k,v]);return q},is(k,v){filters.push([k,v]);return q},range(a,b){start=a;end=b;return q},then(resolve){reads.push({table,start,end});const data=(tables[table]||[]).filter(row=>filters.every(([k,v])=>v===null?row[k]==null:row[k]===v)).slice(start,end+1);return Promise.resolve({data,error:null}).then(resolve);}};return q;},async rpc(name,args){return {data:name==='lookup_inventory_serial'?lookups[args.p_input]||[{result_type:'no_match',candidate_count:0,filtered_candidate_count:0}]:fulfilments[args.p_project_material_id||args.p_se_supply_record_id],error:null};} };
}
test('API pages all arrivals and receipts beyond 1000 instead of silently truncating projections', async () => {
  const records=Array.from({length:1201},(_,i)=>({id:String(i)}));
  const client=readClient({receiving_arrivals:records,material_receipts:records});
  const data=await createReceivingV5Api(client).load();assert.equal(data.arrivals.length,1201);assert.equal(data.receipts.length,1201);
  assert.deepEqual(client.reads.filter(r=>r.table==='receiving_arrivals').map(r=>r.start),[0,500,1000]);
});
test('server candidate reads exclude legacy, project/unit mismatch, closed expectations and incompatible preregistered serials', async () => {
  const sources=['good','wrong-unit','wrong-project','closed','legacy','serial-conflict'].map(id=>({id,inventory_item_id:'item',quantity:1,unit:id==='wrong-unit'?'個':'台',project_id:id==='wrong-project'?'other':'p',receiving_only:true,receiving_archived_at:null}));
  const fs=Object.fromEntries(sources.map(s=>[s.id,{expected:1,fulfilled:0,remaining:1,active:s.id!=='closed',remaining_status:s.id==='closed'?'CANCELLED':'ACTIVE'}]));
  const client=readClient({se_supply_records:sources,material_receipts:[{id:'r',se_supply_record_id:'legacy',source_type:'SE_SUPPLY'}],receiving_serial_entries:[
    {id:'actual',arrival_line_id:'line',normalized_serial:'7515CA50-A4',raw_serial:'7515CA50-A4',active_receipt_id:'receipt'},
    {id:'unrelated',se_supply_record_id:'serial-conflict',inventory_item_id:'item',normalized_serial:'7515CACE-22',raw_serial:'7515CACE-22'},
  ]},fs);
  const candidates=await createReceivingV5Api(client).candidates({id:'line',inventory_item_id:'item',unit:'台',receipt_id:'receipt'},{project_id:'p'},empty());
  assert.deepEqual(candidates.map(c=>c.id),['good']);assert.deepEqual(candidates[0].eligibleEntryIds,['actual']);
});
test('API never includes protected SE item column in metadata/quantity planning edits', async () => {
  let update;const q={update(v){update=v;return q},eq(){return q},select(){return q},maybeSingle:async()=>({data:{id:'s'},error:null})};
  const api=createReceivingV5Api({from:()=>q});
  await api.updatePending({kind:'SE_SUPPLY',id:'s',itemId:'item',updatedAt:'v1'},{itemId:'item',quantity:20,projectId:'p',expectedAt:null,notes:'note'},{...item,unit:'台'});
  assert(!('inventory_item_id' in update));assert.equal(update.quantity,20);assert.equal(update.project_id,'p');assert(Number.isFinite(Date.parse(update.updated_at)));
});
