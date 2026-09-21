const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const load=require('../src/lib/test-load-ts.cjs');
const {createMaintenanceEquipmentApi,filterEquipmentCandidates}=load(path.resolve('src/lib/db/maintenance-usage.ts'));
const candidate={key:'inv:1',inventory_serial_id:'serial',inventory_item_id:'item',se_supply_record_id:'supply',source_type:'BOTH',serial:'SJ1823A-0306856C0-AE',model:'P801',item_name:'Optimizer',eligible:true,version:'v1'};
test('one request preserves both identities and event time; no completion payload',async()=>{
 const calls=[];const api=createMaintenanceEquipmentApi({rpc:async(...args)=>{calls.push(args);return {data:{id:'event'},error:null}}});
 await api.register({requestId:'request',taskId:'task',candidate,replacedAt:'2026-08-01T06:00:00Z',notes:'note'});
 assert.deepEqual(calls,[['register_maintenance_equipment_replacement',{p_request_id:'request',p_schedule_task_id:'task',p_inventory_serial_id:'serial',p_se_supply_record_id:'supply',p_replaced_at:'2026-08-01T06:00:00Z',p_notes:'note',p_version:'v1',p_confirm_cross_project:false}]]);
});
test('substring/case/full serial/model share one filter and preserve conflict eligibility',()=>{
 const conflict={...candidate,key:'se:1',serial:'7515CA50-A4',model:'SE10000H',item_name:null,eligible:false};
 for(const query of ['ae','6c0',candidate.serial.toLowerCase(),'p801','OPTIMIZER'])assert.deepEqual(filterEquipmentCandidates([candidate,conflict],query),[candidate]);
 assert.deepEqual(filterEquipmentCandidates([candidate,conflict],'75'),[conflict]);assert.equal(conflict.serial,'7515CA50-A4');
});
test('ambiguous source never submits; backend failures propagate',async()=>{
 let calls=0;const api=createMaintenanceEquipmentApi({rpc:async()=>{calls++;return {data:null,error:{message:'EQUIPMENT_CONFLICT: changed'}}}});
 await assert.rejects(api.register({candidate:{...candidate,eligible:false}}),/需確認/);assert.equal(calls,0);
 await assert.rejects(api.register({candidate}),/EQUIPMENT_CONFLICT/);assert.equal(calls,1);
});
test('retry uses caller request unchanged and rejects missing response',async()=>{
 const calls=[];const api=createMaintenanceEquipmentApi({rpc:async(name,args)=>{calls.push(args);return {data:null,error:null}}});
 const input={requestId:'same',taskId:'task',candidate,replacedAt:'2026-08-01T06:00:00Z',notes:''};
 await assert.rejects(api.register(input),/未取得/);await assert.rejects(api.register(input),/未取得/);assert.deepEqual(calls[0],calls[1]);
});
test('search checks server response and exposes no client stock mutation',async()=>{
 const rows=[candidate];const api=createMaintenanceEquipmentApi({rpc:async(name,args)=>{assert.equal(name,'search_maintenance_equipment');assert.deepEqual(args,{p_schedule_task_id:'task'});return {data:rows,error:null}}});
 assert.deepEqual(await api.search('task'),rows);
});
test('edit adapter selects correction RPC and preserves revision, source ids and confirmation',async()=>{
 const calls=[];const api=createMaintenanceEquipmentApi({rpc:async(name,args)=>{calls.push([name,args]);return {data:name.includes('search')?[]:{id:'event'},error:null};}});
 await api.search('task','event');assert.deepEqual(calls.shift(),['search_maintenance_equipment_for_edit',{p_record_id:'event'}]);
 const input={requestId:'correction',taskId:'task',candidate:{...candidate,cross_project:true},replacedAt:'2026-08-01T06:00:00Z',notes:'edit',record:{id:'event',revision:2}};
 await assert.rejects(api.register(input),/跨案場/);assert.equal(calls.length,0);
 await api.register({...input,confirmCrossProject:true});assert.equal(calls[0][0],'correct_maintenance_equipment_replacement');assert.equal(calls[0][1].p_expected_revision,2);assert.equal(calls[0][1].p_se_supply_record_id,'supply');assert.equal(calls[0][1].p_inventory_serial_id,'serial');assert.equal(calls[0][1].p_confirm_cross_project,true);assert(!('p_schedule_task_id' in calls[0][1]));
});
