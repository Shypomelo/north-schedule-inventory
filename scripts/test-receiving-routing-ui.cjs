const test=require('node:test'), assert=require('node:assert/strict'), path=require('node:path'), React=require('react');
const load=require('../src/lib/test-load-ts.cjs');
const normalization=load(path.resolve('src/lib/inventory-serial-normalization.ts'));
const helpers=load(path.resolve('src/lib/db/receiving-routing.ts'));
const projections=load(path.resolve('src/lib/material-receiving.ts'));
const item={id:'item',code:'SE10000H',name:'Equipment',unit:'台',is_active:true,requires_serial:true,is_se_maintenance_equipment:true};
const serials=[{id:'s1',item_id:'item',serial_number:'7515CA50-A4',status:'在庫'},{id:'s2',item_id:'item',serial_number:'7515CACE-22',status:'在庫'}];
function nodes(t){if(Array.isArray(t))return t.flatMap(nodes);return t?.props?[t,...nodes(t.props.children)]:[];}
function text(t){if(Array.isArray(t))return t.map(text).join('');return typeof t==='string'||typeof t==='number'?String(t):t?.props?text(t.props.children):'';}
async function harness(name,props={},options={}){
 const states=[],refs=[],effects=[],deps=[],calls=[];let si=0,ri=0,ei=0;
 const react={...React,useState(v){const i=si++;if(!(i in states))states[i]=typeof v==='function'?v():v;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef(v){return refs[ri++]||={current:v};},useMemo:fn=>fn(),useCallback:fn=>fn,useEffect(fn,d){const i=ei++;if(!deps[i]||d.some((v,n)=>v!==deps[i][n])){deps[i]=d;effects.push(fn);}}};
 const call=method=>async args=>{calls.push({method,args});if(options.fail?.(method,calls.length))throw Error('network');return {id:'result'};};
 const api={...Object.fromEntries(['createArrival','receive','correct','reserve','deliver'].map(k=>[k,call(k)])),entries:async()=>options.entries||[],sourceItem:async()=>options.sourceItem||item.id,registerRaw:async(...args)=>{calls.push({method:'registerRaw',args});return {id:'registered-'+args[3]};}};
 const adapter={getInventoryItems:async()=>options.items||[item],getInventorySerials:async()=>serials,getProjects:async()=>[{id:'project',name:'Site',status:'施工中'}],getSESupplyRecords:async()=>options.reservations||[],listProjectMaterials:async()=>options.materials||[]};
 const mod=load(path.resolve('src/components/ReceivingInventoryRouting.tsx'),{react,'@/lib/db':{dbAdapter:adapter},'@/lib/db/supabaseClient':{supabase:{}},'@/lib/db/receiving-routing':{...helpers,createReceivingApi:()=>api}});
 let changed=0;const render=()=>{si=ri=ei=0;return mod[name]({projects:[],onClose(){},onCreated(){changed++;},onChanged(){changed++;},...props});};
 async function settle(){for(let n=0;n<3;n++){render();effects.splice(0).forEach(fn=>fn());await new Promise(r=>setImmediate(r));}}
 await settle();
 const find=fn=>nodes(render()).find(fn);
 return {render,find,calls,settle,get changed(){return changed;},accept(raw){return find(n=>n.type?.name==='ReceivingSerialControls').props.onAccept(raw);},change(label,value){if(label==='品項'){return find(n=>n.type?.name==='InventoryItemCombobox').props.onChange(value);}const n=find(n=>n.type==='label'&&text(n).startsWith(label));assert(n,`Missing label ${label}`);const c=nodes(n).find(n=>['input','select'].includes(n.type));c.props.onChange({target:{value}});},input(label,value){find(n=>n.props['aria-label']===label).props.onChange({target:{value}});},click(label){const n=find(n=>n.type==='button'&&text(n)===label);assert(n,`Missing ${label}`);assert(!n.props.disabled);return n.props.onClick?.();},check(raw){const label=find(n=>n.type==='label'&&text(n).includes(raw));nodes(label).find(n=>n.type==='input').props.onChange({target:{checked:true}});},submit(){return find(n=>n.type==='form').props.onSubmit({preventDefault(){}});}};
}
test('8+2 exact identity preserves raw characters and never becomes a short alias',()=>{
 assert.equal(normalization.classifySerialFormat('7515CA50-A4'),'exact');assert.equal(normalization.deriveShortSerialKey('7515CA50-A4'),null);
 assert.equal(helpers.validateReceivingRawSerial('7515CACE-22'),'7515CACE-22');
 assert.equal(normalization.classifySerialFormat('0306856C0-AE'),'short');assert.equal(normalization.classifySerialFormat('SJ1823A-0306856C0-AE'),'full');
 assert.equal(normalization.resolveInventorySerialLookupFromList('7515',serials).result_type,'no_match');
 assert.equal(normalization.resolveInventorySerialLookupFromList('7515CA50-A4',serials,{itemId:'other'}).result_type,'filtered_out');
});
test('optional project and 2 serials for quantity 3 create pending only',async()=>{
 const h=await harness('OfficeArrivalDialog');h.change('品項','item');h.change('數量','3');h.accept('7515CA50-A4');h.accept('7515CACE-22');await h.submit();
 assert.deepEqual(h.calls.map(x=>x.method),['createArrival']);assert.equal(h.calls[0].args.p_project_id,null);assert.equal(h.calls[0].args.p_quantity,3);assert.equal(h.calls[0].args.p_serials.length,2);
});
test('all serials optional, duplicate normalized serials rejected',async()=>{
 const h=await harness('OfficeArrivalDialog');h.change('品項','item');h.change('數量','3');await h.submit();assert.deepEqual(h.calls[0].args.p_serials,[]);
 h.accept('7515CA50-A4');assert.equal(h.accept('7515ca50-a4').status,'duplicate');await h.submit();assert.equal(h.calls.length,2);assert.equal(h.calls[1].args.p_serials.length,1);
});
test('retry reuses request id; editing payload gets a new request id',async()=>{
 const h=await harness('OfficeArrivalDialog',{}, {fail:()=>true});h.change('品項','item');await h.submit();await h.submit();assert.equal(h.calls[0].args.p_request_id,h.calls[1].args.p_request_id);h.change('數量','2');await h.submit();assert.notEqual(h.calls[1].args.p_request_id,h.calls[2].args.p_request_id);
});
const pending={sourceType:'SE_SUPPLY',sourceId:'source',itemLabel:'SE10000H',unit:'台',quantity:3,receivedQuantity:0,remainingQuantity:3};
const entries=[{id:'entry1',raw_serial:'7515CA50-A4',normalized_serial:'7515CA50-A4',inventory_item_id:'item',active_receipt_id:null},{id:'entry2',raw_serial:'NEW00001-AA',normalized_serial:'NEW00001-AA',inventory_item_id:'item',active_receipt_id:null}];
test('pending detail shows existing/new states and receives selected unit only',async()=>{
 const h=await harness('ReceivingDetailDialog',{item:pending},{entries});assert(text(h.render()).includes('系統已有 · 在庫'));assert(text(h.render()).includes('尚未建立庫存序號'));h.click('確認收到');h.check('7515CA50-A4');await h.click('確認收到 1 台');assert.equal(h.calls[0].args.p_quantity,1);assert.deepEqual(h.calls[0].args.p_entry_ids,['entry1']);
});
test('raw serial registration callback cannot write inventory',async()=>{
 const h=await harness('ReceivingDetailDialog',{item:pending},{entries});h.click('補序號');h.accept('NEW00002-AA');assert.equal(h.calls.length,0);await h.click('儲存待收序號');assert.deepEqual(h.calls,[{method:'registerRaw',args:['SE_SUPPLY','source','item','NEW00002-AA']}]);
});
test('leave inventory causes no mutation; SE reservation excludes reserved serial',async()=>{
 const h=await harness('InventoryRoutingPanel',{itemId:'item'},{reservations:[{inventory_serial_id:'s1',replace_date:null,cancelled_at:null}]});h.click('留在庫存');assert.equal(h.calls.length,0);h.click('加入 SE 供貨追蹤');assert(!text(h.render()).includes('7515CA50-A4'));h.check('7515CACE-22');await h.submit();assert.equal(h.calls[0].method,'reserve');assert.equal(h.calls[0].args.p_serial_id,'s2');
});
test('project routing requires explicit existing/new selection and sends selected identity',async()=>{
 const h=await harness('InventoryRoutingPanel',{itemId:'item'},{materials:[{id:'m1',project_id:'project',inventory_item_id:'item',unit:'台',delivery_destination:'SITE',procurement_status:'ORDERED',item_name:'need',quantity:2}]});h.click('送至案場');h.change('送達案場','project');await h.settle();h.check('7515CA50-A4');await h.submit();assert.equal(h.calls.length,0);h.change('案場物料需求','m1');await h.submit();assert.equal(h.calls[0].args.p_material_id,'m1');assert.equal(h.calls[0].args.p_create_new,false);
});
test('OFFICE and SITE projections do not double count; null legacy stays visible',()=>{
 const receipts=[{source_type:'PROJECT_MATERIAL',project_material_id:'m',quantity_received:1,event_type:'RECEIVE',received_at:'2026-09-23',receipt_location:'OFFICE'},{source_type:'PROJECT_MATERIAL',project_material_id:'m',quantity_received:2,event_type:'RECEIVE',received_at:'2026-09-23',receipt_location:'SITE'}];
 assert.equal(projections.summarizeMaterialReceipts(receipts,'PROJECT_MATERIAL','m',3,'OFFICE').effectiveQuantity,1);assert.equal(projections.summarizeMaterialReceipts(receipts,'PROJECT_MATERIAL','m',3,'SITE').effectiveQuantity,2);
});

test('real Inventory adapter retains the SE eligibility flag and SE read retains reservation state',async()=>{
 const rawSE={id:'se',inventory_serial_id:'s1',receiving_only:false,inventory_routed:true,cancelled_at:null,replace_date:null};
 const supabase={from(table){return{select(){return{order:async()=>({data:table==='inventory_items'?[item]:[rawSE],error:null})}}}}};
 const {pocSupabaseAdapter}=load(path.resolve('src/lib/db/poc-supabase.ts'),{'./supabaseClient':{supabase}});
 const rows=await pocSupabaseAdapter.getInventoryItems();assert.equal(rows[0].is_se_maintenance_equipment,true);
 const records=await pocSupabaseAdapter.getSESupplyRecords();assert.equal(records[0].inventory_routed,true);assert(helpers.isActiveSEReservation(records[0]));
});
test('legacy or mixed receipt histories are not relabeled fully stocked',()=>{
 const linked={source_type:'SE_SUPPLY',se_supply_record_id:'source',quantity_received:1,event_type:'RECEIVE',inventory_linked:true,receipt_location:'OFFICE'};
 assert.equal(projections.receivingInventoryLabel([linked],'source',1),'已入庫');
 assert.equal(projections.receivingInventoryLabel([linked],'source',3),'已收貨 · 庫存關聯待確認');
});

test('RECEIVE-1/2: new scanned raw remains draft until final receive, selected count is quantity',async()=>{
 const h=await harness('ReceivingDetailDialog',{item:pending},{entries:[]});
 h.click('確認收到');h.accept('NEW00002-AA');h.accept('NEW00003-AA');
 assert.equal(h.calls.length,0);assert.equal(h.accept('new00002-aa').status,'duplicate');
 await h.click('確認收到 2 台');await h.settle();
 assert.deepEqual(h.calls.map(c=>c.method),['registerRaw','registerRaw','receive']);
 assert.equal(h.calls[2].args.p_quantity,2);assert.equal(h.calls[2].args.p_entry_ids.length,2);
});
test('RECEIVE-5: nonserialized quantity flow omits serial controls',async()=>{
 const h=await harness('ReceivingDetailDialog',{item:pending},{items:[{...item,requires_serial:false}]});
 assert(!h.find(n=>n.type?.name==='ReceivingSerialControls'));
 h.click('確認收到');h.change('本次收到','2');await h.click('確認收到');
 assert.equal(h.calls[0].method,'receive');assert.equal(h.calls[0].args.p_quantity,2);assert.deepEqual(h.calls[0].args.p_entry_ids,[]);
});
test('partial 12/20 can be created, all 20 and zero are accepted, 21st is capped',async()=>{
 for(const count of [0,12,20]){
 const h=await harness('OfficeArrivalDialog');h.change('品項','item');h.change('數量','20');
 for(let n=0;n<count;n++) assert.equal(h.accept('TEST'+String(n).padStart(4,'0')+'-AA').status,'valid');
 if(count===20)assert.equal(h.accept('TEST0021-AA').status,'cap');
 await h.submit();assert.equal(h.calls[0].args.p_serials.length,count);assert.equal(h.calls[0].args.p_quantity,20);
 }
});
test('no dropped callbacks when a batch arrives in one React event',async()=>{
 const h=await harness('OfficeArrivalDialog');h.change('品項','item');h.change('數量','20');
 const callback=h.find(n=>n.type?.name==='ReceivingSerialControls').props.onAccept;
 for(let n=0;n<20;n++)assert.equal(callback('TEST'+String(n).padStart(4,'0')+'-AA').status,'valid');
 await h.submit();assert.equal(h.calls[0].args.p_serials.length,20);
});

test('V4 UI-2 inline serialized receive selects serials immediately and commits once without modal',async()=>{
 const h=await harness('ReceivingDetailDialog',{item:pending,inline:true},{entries});
 assert.equal(h.render().type.name,'ReceivingInlineFrame');
 assert(!h.find(n=>n.type==='button'&&text(n)==='確認收到'));
 h.check('7515CA50-A4');assert.equal(h.calls.length,0);
 await h.click('確認收到 1 台');assert.equal(h.calls.length,1);assert.equal(h.calls[0].method,'receive');
 assert(!h.find(n=>n.type?.name==='InventoryRoutingPanel'));
});
