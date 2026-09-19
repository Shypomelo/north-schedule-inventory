const test=require('node:test'), assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {createInventoryAtomicWriter,inventorySerialInputs,inventoryWriteError}=require('./test-load-ts.cjs')(path.join(__dirname,'db/inventory-atomic.ts'));
test('create sends one RPC including count snapshot and serials, without trusting delta',async()=>{
 const calls=[];const write=createInventoryAtomicWriter({rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'result'},error:null};}});
 const result=await write('CREATE',{item_id:'item',transaction_type:'ADJUST',counted_quantity:0,expected_balance:5},[]);
 assert.deepEqual(result,{id:'result'}); assert.equal(calls.length,1);assert.equal(calls[0].name,'write_inventory_transaction_atomic');
 assert.equal(calls[0].args.p_data.counted_quantity,0);assert.equal(calls[0].args.p_data.expected_balance,5);
});
test('edit sends original version and a single atomic replacement',async()=>{
 let request; const write=createInventoryAtomicWriter({rpc:async(_name,args)=>{request=args;return {data:{id:'tx'},error:null};}});
 await write('EDIT',{item_id:'item',expected_updated_at:'version'},inventorySerialInputs('ABC\nDEF'),'tx','reason');
 assert.deepEqual(request.p_serials,['ABC','DEF']);assert.equal(request.p_expected_updated_at,'version');assert.equal(request.p_transaction_id,'tx');assert.equal(request.p_reason,'reason');
 assert.equal(request.p_data.expected_updated_at,undefined);
});
test('conflict is visible and never retried silently',async()=>{
 let calls=0;const write=createInventoryAtomicWriter({rpc:async()=>{calls++;return {data:null,error:{message:'STALE_INVENTORY'}};}});
 await assert.rejects(write('CREATE'),/庫存已在盤點期間發生異動，請重新載入後再確認/);assert.equal(calls,1);
 assert.match(inventoryWriteError({message:'INSUFFICIENT_INVENTORY'}).message,/庫存不足/);
});
test('formal inventory pages cannot prewrite serial status or create serial rows',()=>{
 for(const file of ['page.tsx','transactions/page.tsx','serials/page.tsx']) {
  const text=fs.readFileSync(path.join(__dirname,'../app/inventory',file),'utf8');
  assert.doesNotMatch(text,/dbAdapter\.(createInventorySerial|updateInventorySerial)\(/,file);
 }
 const adapter=fs.readFileSync(path.join(__dirname,'db/poc-supabase.ts'),'utf8');
 assert.doesNotMatch(adapter,/revertSerialsForTransaction|insertTransactionSerialLinks/);
});
