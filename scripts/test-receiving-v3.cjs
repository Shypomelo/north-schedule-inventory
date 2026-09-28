const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const load = require('../src/lib/test-load-ts.cjs');
const { resolveReceivingSerial: resolve, previewSerialBatch: batch, parseSerialBatch } = load(path.resolve('src/lib/receiving-serial-draft.ts'));
const serial = n => 'TEST' + String(n).padStart(4, '0') + '-AA';
const context = extra => ({ item: { id:'item', requires_serial:true }, serials:[], entries:[], drafts:[], capacity:20, ...extra });
test('ITEM-1/2: canonical flag controls serialized behavior', () => {
 assert.equal(resolve(serial(1),context()).status,'valid');
 assert.equal(resolve(serial(1),context({item:{id:'item',requires_serial:false}})).status,'invalid');
});
test('BATCH-1: parse Excel, newline and comma delimiters while preserving serial dashes', () => {
 const rows=batch(Array.from({length:20},(_,i)=>serial(i)).join('\r\n'),context());
 assert.equal(rows.filter(r=>r.result.status==='valid').length,20);
 assert.deepEqual(parseSerialBatch(' A,B \t C-D\r\n E '),['A','B','C-D','E']);
});
test('BATCH-2: normalize, deduplicate, reject invalid and conflicting status', () => {
 const rows=batch('test0001-aa\nTEST0001-AA\nunknown\nTEST0002-AA',context({serials:[{id:'s',item_id:'item',serial_number:serial(2),status:'已出庫'}]}));
 assert.deepEqual(rows.map(r=>r.result.status),['valid','duplicate','invalid','conflict']);
});
test('BATCH-3: preview caps 21st, never changes quantity or original draft', () => {
 const c=context(); const rows=batch(Array.from({length:21},(_,i)=>serial(i)).join('\n'),c);
 assert.equal(rows[20].result.status,'cap');assert.equal(c.drafts.length,0);assert.equal(c.capacity,20);
});
test('RECEIVE-2/3: new creates local draft; pending chooses existing entry', () => {
 let r=resolve(serial(1),context({receiving:true,selected:[]}));assert.equal(r.status,'valid');assert.equal(r.value.entryId,undefined);
 const entry={id:'pending',raw_serial:serial(1),normalized_serial:serial(1),inventory_item_id:'item',active_receipt_id:null};
 r=resolve(serial(1),context({receiving:true,selected:[],entries:[entry]}));assert.equal(r.value.entryId,'pending');
 assert.equal(resolve(serial(1),context({receiving:true,selected:['pending'],entries:[entry]})).status,'duplicate');
});
test('RECEIVE-4: short alias selects existing canonical identity, without changing it', () => {
 const s={id:'s',item_id:'item',serial_number:'SJ1823A-0306856C0-AE',status:'在庫'};
 const r=resolve('0306856C0-AE',context({serials:[s]}));
 assert.equal(r.value.canonical,s.serial_number);assert.equal(r.value.inventorySerialId,'s');
 assert.equal(s.serial_number,'SJ1823A-0306856C0-AE');
});
test('other item, OUT, ambiguous and mismatched full identities are rejected', () => {
 const s={id:'s',item_id:'item',serial_number:'SJ1823A-0306856C0-AE',status:'在庫'};
 for (const c of [context({serials:[{...s,item_id:'other'}]}),context({serials:[{...s,status:'已出庫'}]}),context({serials:[s,{...s,id:'s2'}]})]) assert.equal(resolve(s.serial_number,c).status,'conflict');
 assert.equal(resolve('SJ1824A-0306856C0-AE',context({serials:[s]})).status,'conflict');
});
test('canonical aliases in one draft cannot increase count',()=>{
 const s={id:'s',item_id:'item',serial_number:'SJ1823A-0306856C0-AE',status:'在庫'};
 const rows=batch(s.serial_number+'\n0306856C0-AE',context({serials:[s]}));
 assert.deepEqual(rows.map(r=>r.result.status),['valid','duplicate']);
});
test('unregistered alias conflicts are never silently promoted',()=>{
 const rows=batch('0306856C0-AE\nSJ1823A-0306856C0-AE',context());
 assert.deepEqual(rows.map(r=>r.result.status),['valid','conflict']);
});
test('receive selection uses remaining cap and prevents overfilling pending',()=>{
 const entries=Array.from({length:20},(_,n)=>({id:'p'+n,inventory_item_id:'item',raw_serial:serial(n),normalized_serial:serial(n),active_receipt_id:null}));
 assert.equal(resolve(serial(21),context({entries,receiving:true,selected:[]})).status,'cap');
 assert.equal(resolve(serial(0),context({entries,receiving:true,selected:[]})).status,'valid');
});

test('pending full serial accepts short scan without rebuilding or mutating identity',()=>{
 const full='SJ1823A-0306856C0-AE', entry={id:'p',inventory_item_id:'item',raw_serial:full,normalized_serial:full,active_receipt_id:null};
 const r=resolve('0306856C0-AE',context({entries:[entry],receiving:true,selected:[]}));
 assert.equal(r.status,'valid');assert.equal(r.value.entryId,'p');assert.equal(r.value.canonical,full);assert.equal(entry.normalized_serial,full);
 const rows=batch(full+'\n0306856C0-AE',context());assert.deepEqual(rows.map(r=>r.result.status),['valid','duplicate']);
});
