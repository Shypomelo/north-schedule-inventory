// In-memory browser test transport. Never imported by the application or connected to Supabase.
import { resolveInventorySerialLookupFromList, normalizeSerialInput } from '../src/lib/inventory-serial-normalization';
const initial = () => ({
  projects: [{id:'north',name:'北港案場',status:'ACTIVE',is_active:true},{id:'south',name:'南投案場',status:'ACTIVE',is_active:true}],
  inventory_items: [{id:'serial',code:'P401',name:'序號設備',unit:'台',is_active:true,requires_serial:true},{id:'plain',code:'CABLE',name:'電纜',unit:'m',is_active:true,requires_serial:false}],
  project_materials: [], project_material_batches: [],
  se_supply_records: [{id:'legacy-source',new_model:'歷史設備',quantity:2,unit:'台',receiving_only:true,procurement_status:'RECEIVED',receiving_archived_at:null}],
  material_receipts: [{id:'legacy-receipt',source_type:'SE_SUPPLY',se_supply_record_id:'legacy-source',event_type:'RECEIVE',quantity_received:2,receipt_location:'OFFICE',received_at:'2026-09-20T02:00:00Z',inventory_linked:true},{id:'legacy-reversal',source_type:'SE_SUPPLY',se_supply_record_id:'legacy-source',event_type:'REVERSAL',reversal_of_id:'legacy-receipt',quantity_received:1,receipt_location:'OFFICE',received_at:'2026-09-21T02:00:00Z'}],
  receiving_arrivals: [], receiving_arrival_lines: [], receiving_serial_entries: [], receiving_arrival_matches: [], receiving_arrival_match_serials: [],
  receiving_inventory_allocations: [],
  inventory_transactions: [], inventory_transaction_serials: [], material_receipt_serials: [],
  inventory_serials: [{id:'existing',item_id:'serial',serial_number:'CONFLICT-AA',status:'在庫'}],
  calls: [], inventoryWrites: 0, cancellations: {}, cache: {}, counter: 0,
});
export const store = JSON.parse(sessionStorage.getItem('v5-fixture') || 'null') || initial();
const persist = () => sessionStorage.setItem('v5-fixture',JSON.stringify(store));
const uid = () => 'fixture-' + ++store.counter;
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
export const useUser = () => ({currentUser:{id:'reviewer',role:'ADMIN'},allUsers:[]});
export const dbAdapter = {};
const key = source => source.project_material_id ? 'PROJECT_MATERIAL:' + source.project_material_id : 'SE_SUPPLY:' + source.se_supply_record_id;
const source = args => store[args.p_project_material_id ? 'project_materials' : 'se_supply_records'].find(s => s.id === (args.p_project_material_id || args.p_se_supply_record_id));
function fulfilment(args) {
  const row = source(args); if (!row) throw new Error('Pending not found');
  const identity = key({project_material_id:args.p_project_material_id,se_supply_record_id:args.p_se_supply_record_id});
  const fulfilled = store.receiving_arrival_matches.filter(m => !m.cancelled_at && key(m) === identity).reduce((n,m) => n + m.quantity, 0);
  const remaining = row.quantity - fulfilled, cancellation = store.cancellations[identity] || null;
  const active = !row.receiving_archived_at && !row.cancelled_at && row.procurement_status !== 'RECEIVED' && remaining > 0;
  return {expected:row.quantity,quantity:row.quantity,fulfilled,remaining,active,cancellation,remaining_status:cancellation?'CANCELLED':remaining<=0?'FULFILLED':active?'ACTIVE':'INACTIVE'};
}
function entry(raw, owner, itemId) {return {id:uid(),project_material_id:null,se_supply_record_id:null,arrival_line_id:null,...owner,inventory_item_id:itemId,raw_serial:raw,normalized_serial:normalizeSerialInput(raw),retired_at:null,active_receipt_id:null,updated_at:now()};}
function post(line, itemId) {
  const item=store.inventory_items.find(i=>i.id===itemId);
  const entries=store.receiving_serial_entries.filter(e=>e.arrival_line_id===line.id);
  if(entries.some(e=>resolveInventorySerialLookupFromList(e.raw_serial,store.inventory_serials).result_type!=='no_match'))throw new Error('ARRIVAL_SERIAL_IDENTITY_CONFLICT');
  const receipt={id:uid(),source_type:'ARRIVAL',arrival_line_id:line.id,receipt_location:'OFFICE',quantity_received:line.quantity,event_type:'RECEIVE',received_at:store.receiving_arrivals.find(a=>a.id===line.arrival_id).actual_received_at,inventory_linked:true};
  store.material_receipts.push(receipt);Object.assign(line,{inventory_item_id:item.id,unit:item.unit,resolution_state:'POSTED',receipt_id:receipt.id,version:line.version+1});
  for(const e of entries){e.active_receipt_id=receipt.id;e.inventory_item_id=item.id;e.inventory_serial_id=uid();store.inventory_serials.push({id:e.inventory_serial_id,item_id:item.id,serial_number:e.normalized_serial,status:'在庫'});}
  store.inventoryWrites++;
}
function match(line, spec) {
  const p=source({p_project_material_id:spec.project_material_id,p_se_supply_record_id:spec.se_supply_record_id});
  const f=fulfilment({p_project_material_id:spec.project_material_id,p_se_supply_record_id:spec.se_supply_record_id});
  if(p.receiving_archived_at || p.procurement_status==='RECEIVED')throw new Error('MATCH_PENDING_INACTIVE');
  const arrival=store.receiving_arrivals.find(a=>a.id===line.arrival_id);
  if(arrival.project_id && p.project_id && arrival.project_id!==p.project_id)throw new Error('MATCH_PROJECT_CONFLICT');
  if(p.inventory_item_id!==line.inventory_item_id || p.unit!==line.unit)throw new Error('MATCH_ITEM_UNIT_CONFLICT');
  const used=store.receiving_arrival_matches.filter(m=>m.arrival_line_id===line.id&&!m.cancelled_at).reduce((n,m)=>n+m.quantity,0);
  if(spec.quantity>f.remaining || used+spec.quantity>line.quantity)throw new Error('MATCH_CAPACITY_CONFLICT');
  const result={id:uid(),arrival_line_id:line.id,quantity:spec.quantity,project_material_id:spec.project_material_id||null,se_supply_record_id:spec.se_supply_record_id||null,created_at:now(),cancelled_at:null};
  const item=store.inventory_items.find(i=>i.id===line.inventory_item_id);
  if(item.requires_serial && (spec.entry_ids?.length!==spec.quantity || new Set(spec.entry_ids).size!==spec.quantity))throw new Error('MATCH_SERIAL_COUNT');
  store.receiving_arrival_matches.push(result);
  for(const id of spec.entry_ids||[])store.receiving_arrival_match_serials.push({match_id:result.id,arrival_entry_id:id,pending_entry_id:null,cancelled_at:null});
  line.version++;arrival.version++;return result;
}
function execute(name,a) {
  if(name==='get_receiving_pending_fulfilment')return fulfilment(a);
  if(name==='delete_receiving_pending_source'){
    if(store.failDelete)throw new Error('permission denied for table receiving_requests');
    if(!a.p_request_id||!a.p_source_id||!a.p_expected_updated_at||!['PROJECT_MATERIAL','SE_SUPPLY'].includes(a.p_source_type))throw new Error('PENDING_DELETE_ARGUMENT_REQUIRED');
    const sourceArgs=a.p_source_type==='PROJECT_MATERIAL'?{p_project_material_id:a.p_source_id}:{p_se_supply_record_id:a.p_source_id};
    const row=source(sourceArgs);
    if(!row)throw new Error('PENDING_DELETE_INACTIVE');
    if(row.updated_at!==a.p_expected_updated_at)throw new Error('PENDING_DELETE_VERSION_CONFLICT');
    if(row.receiving_archived_at||row.receiving_deleted_at||row.cancelled_at||row.procurement_status==='RECEIVED'||a.p_source_type==='SE_SUPPLY'&&row.receiving_only!==true)throw new Error('PENDING_DELETE_INACTIVE');
    const linked=value=>a.p_source_type==='PROJECT_MATERIAL'?value.project_material_id===row.id:value.se_supply_record_id===row.id;
    if(store.receiving_arrival_matches.some(linked)||store.material_receipts.some(linked)||store.receiving_inventory_allocations.some(linked)
      ||store.receiving_serial_entries.some(entry=>linked(entry)&&(entry.active_receipt_id||entry.inventory_serial_id
        ||store.material_receipt_serials.some(link=>link.entry_id===entry.id)||store.receiving_arrival_match_serials.some(link=>link.pending_entry_id===entry.id)))
      ||row.received_at||row.received_on||row.inventory_serial_id||row.inventory_routed)throw new Error('PENDING_DELETE_DOWNSTREAM_EXISTS');
    const at=now(), retired=[];
    for(const entry of store.receiving_serial_entries.filter(linked))if(!entry.retired_at){entry.retired_at=at;entry.updated_at=at;retired.push(entry.id);}
    row.receiving_archived_at=at;row.receiving_deleted_at=at;row.updated_at=at;
    return {outcome:'DELETED',id:row.id,source_type:a.p_source_type,archived_at:at,retired_entry_ids:retired,inventory_effect:0};
  }
  if(name==='get_receiving_handoff_scope'){
    const receipt=store.material_receipts.find(row=>row.id===a.p_receipt_id);
    return {receipt_id:receipt.id,item_id:receipt.inventory_item_id,requires_serial:store.inventory_items.find(item=>item.id===receipt.inventory_item_id)?.requires_serial||false,received:receipt.quantity_received,se:0,site:0,other:0,available:receipt.quantity_received,available_serial_ids:store.receiving_serial_entries.filter(entry=>entry.active_receipt_id===receipt.id).map(entry=>entry.inventory_serial_id),allocations:[]};
  }
  if(name==='post_receiving_arrival_line'){
    if(store.failPost)throw new Error('POST_TEST_FAILURE');
    const line=store.receiving_arrival_lines.find(row=>row.id===a.p_line_id);
    if(!line||!['STAGED','POSTED'].includes(line.resolution_state))throw new Error('ARRIVAL_LINE_NOT_STAGED');
    const item=store.inventory_items.find(row=>row.id===line.inventory_item_id);
    const posted=store.material_receipts.filter(row=>row.source_type==='ARRIVAL_ROUTE'&&row.route_arrival_line_id===line.id&&row.event_type==='RECEIVE'&&!row.reentry_of_reversal_id).reduce((sum,row)=>sum+row.quantity_received,0);
    if(!Number.isFinite(a.p_quantity)||a.p_quantity<=0||posted+a.p_quantity>line.quantity)throw new Error('ARRIVAL_POST_QUANTITY');
    const ids=a.p_entry_ids||[];
    if(item.requires_serial){
      if(ids.length!==a.p_quantity||new Set(ids).size!==ids.length)throw new Error('ARRIVAL_POST_SERIAL_COUNT');
      for(const id of ids){const entry=store.receiving_serial_entries.find(row=>row.id===id);if(!entry||entry.arrival_line_id!==line.id||entry.retired_at||entry.inventory_serial_id||entry.active_receipt_id)throw new Error('ARRIVAL_POST_SERIAL_IDENTITY');}
    }else if(ids.length)throw new Error('ARRIVAL_POST_NON_SERIAL_IDS');
    const tx={id:uid(),item_id:item.id,transaction_type:'IN',source:'ARRIVAL_ROUTE',quantity:a.p_quantity,transaction_date:a.p_posting_date||now().slice(0,10),handler:'測試員',created_at:now(),is_voided:false};
    const receipt={id:uid(),source_type:'ARRIVAL_ROUTE',route_arrival_line_id:line.id,inventory_item_id:item.id,inventory_transaction_id:tx.id,event_type:'RECEIVE',quantity_received:a.p_quantity,receipt_location:'OFFICE',received_at:now(),created_at:now(),received_by:'reviewer',inventory_linked:true,reentry_of_reversal_id:null};
    store.inventory_transactions.push(tx);store.material_receipts.push(receipt);
    for(const id of ids){const entry=store.receiving_serial_entries.find(row=>row.id===id);entry.inventory_serial_id=uid();entry.active_receipt_id=receipt.id;store.inventory_serials.push({id:entry.inventory_serial_id,item_id:item.id,serial_number:entry.normalized_serial,status:'在庫'});store.inventory_transaction_serials.push({id:uid(),transaction_id:tx.id,serial_id:entry.inventory_serial_id,is_pending:false,created_at:now()});store.material_receipt_serials.push({receipt_id:receipt.id,entry_id:entry.id,inventory_serial_id:entry.inventory_serial_id,linked_existing:false});}
    line.resolution_state=posted+a.p_quantity===line.quantity?'POSTED':'STAGED';line.version++;
    return {line,receipt,inventory_transaction:tx,remaining_staged_quantity:line.quantity-posted-a.p_quantity};
  }
  if(name==='reverse_receiving_inventory_in'){
    if(store.failReverse)throw new Error('REVERSE_TEST_FAILURE');
    const original=store.material_receipts.find(row=>row.id===a.p_receipt_id);
    const originTx=store.inventory_transactions.find(row=>row.id===original?.inventory_transaction_id);
    const line=store.receiving_arrival_lines.find(row=>row.id===original?.route_arrival_line_id);
    const item=store.inventory_items.find(row=>row.id===originTx?.item_id);
    const already=store.material_receipts.filter(row=>row.reversal_of_id===original?.id&&row.event_type==='REVERSAL').reduce((sum,row)=>sum+row.quantity_received,0);
    if(!original||original.event_type!=='RECEIVE'||original.receipt_location!=='OFFICE'||!original.inventory_linked||originTx?.transaction_type!=='IN'||!line||!item||!a.p_reason?.trim()||a.p_quantity<=0||already+a.p_quantity>original.quantity_received)throw new Error('RECEIPT_REVERSAL_INVALID');
    const ids=a.p_entry_ids||[];
    if(item.requires_serial){
      if(ids.length!==a.p_quantity||new Set(ids).size!==ids.length)throw new Error('RECEIPT_SERIAL_COUNT_MISMATCH');
      for(const id of ids){const link=store.material_receipt_serials.find(row=>row.receipt_id===original.id&&row.entry_id===id&&!row.linked_existing);const entry=store.receiving_serial_entries.find(row=>row.id===id);const serial=store.inventory_serials.find(row=>row.id===link?.inventory_serial_id);if(!link||entry?.active_receipt_id!==original.id||serial?.status!=='在庫'||!store.inventory_transaction_serials.some(row=>row.transaction_id===originTx.id&&row.serial_id===serial.id))throw new Error('RECEIPT_SERIAL_PROVENANCE_CONFLICT');}
    }else if(ids.length)throw new Error('NON_SERIAL_ENTRY_IDS_NOT_ALLOWED');
    const tx={id:uid(),item_id:item.id,transaction_type:'IN_REVERSAL',source:'RECEIVING_IN_REVERSAL',quantity:a.p_quantity,transaction_date:a.p_reversed_at.slice(0,10),handler:'測試員',created_at:now(),is_voided:false,reverses_transaction_id:originTx.id,reenters_reversal_id:null};
    const receipt={id:uid(),source_type:original.source_type,route_arrival_line_id:line.id,inventory_transaction_id:tx.id,event_type:'REVERSAL',reversal_of_id:original.id,quantity_received:a.p_quantity,receipt_location:'OFFICE',received_at:a.p_reversed_at,created_at:now(),received_by:'reviewer',inventory_linked:true};
    store.inventory_transactions.push(tx);store.material_receipts.push(receipt);
    for(const id of ids){const link=store.material_receipt_serials.find(row=>row.receipt_id===original.id&&row.entry_id===id);const entry=store.receiving_serial_entries.find(row=>row.id===id);const serial=store.inventory_serials.find(row=>row.id===link.inventory_serial_id);entry.active_receipt_id=null;serial.status='待入庫';store.material_receipt_serials.push({...link,receipt_id:receipt.id});store.inventory_transaction_serials.push({id:uid(),transaction_id:tx.id,serial_id:serial.id,is_pending:false,created_at:now()});}
    line.resolution_state='STAGED';line.version++;
    return {receipt,inventory_transaction:tx,staged_quantity:a.p_quantity};
  }
  if(name==='reenter_receiving_inventory'){
    if(store.failReenter)throw new Error('REENTER_TEST_FAILURE');
    const reversal=store.material_receipts.find(row=>row.id===a.p_reversal_receipt_id);
    const reversalTx=store.inventory_transactions.find(row=>row.id===reversal?.inventory_transaction_id);
    const line=store.receiving_arrival_lines.find(row=>row.id===reversal?.route_arrival_line_id);
    const item=store.inventory_items.find(row=>row.id===reversalTx?.item_id);
    const already=store.inventory_transactions.filter(row=>row.reenters_reversal_id===reversalTx?.id).reduce((sum,row)=>sum+row.quantity,0);
    if(!reversal||reversal.event_type!=='REVERSAL'||reversalTx?.transaction_type!=='IN_REVERSAL'||!line||!item||a.p_quantity<=0||already+a.p_quantity>reversal.quantity_received)throw new Error('REENTRY_INVALID');
    const ids=a.p_entry_ids||[];
    if(item.requires_serial){
      if(ids.length!==a.p_quantity||new Set(ids).size!==ids.length)throw new Error('REENTRY_SERIAL_COUNT_MISMATCH');
      for(const id of ids){const link=store.material_receipt_serials.find(row=>row.receipt_id===reversal.id&&row.entry_id===id);const entry=store.receiving_serial_entries.find(row=>row.id===id);const serial=store.inventory_serials.find(row=>row.id===link?.inventory_serial_id);if(!link||entry?.active_receipt_id||serial?.status!=='待入庫'||!store.inventory_transaction_serials.some(row=>row.transaction_id===reversalTx.id&&row.serial_id===serial.id))throw new Error('REENTRY_SERIAL_PROVENANCE_CONFLICT');}
    }else if(ids.length)throw new Error('NON_SERIAL_ENTRY_IDS_NOT_ALLOWED');
    const tx={id:uid(),item_id:item.id,transaction_type:'IN',source:'RECEIVING_REENTRY',quantity:a.p_quantity,transaction_date:a.p_received_at.slice(0,10),handler:'測試員',created_at:now(),is_voided:false,reverses_transaction_id:null,reenters_reversal_id:reversalTx.id};
    const receipt={id:uid(),source_type:'ARRIVAL_ROUTE',route_arrival_line_id:line.id,inventory_transaction_id:tx.id,event_type:'RECEIVE',reentry_of_reversal_id:reversal.id,quantity_received:a.p_quantity,receipt_location:'OFFICE',received_at:a.p_received_at,created_at:now(),received_by:'reviewer',inventory_linked:true};
    store.inventory_transactions.push(tx);store.material_receipts.push(receipt);
    for(const id of ids){const link=store.material_receipt_serials.find(row=>row.receipt_id===reversal.id&&row.entry_id===id);const entry=store.receiving_serial_entries.find(row=>row.id===id);const serial=store.inventory_serials.find(row=>row.id===link.inventory_serial_id);entry.active_receipt_id=receipt.id;serial.status='在庫';store.material_receipt_serials.push({...link,receipt_id:receipt.id});store.inventory_transaction_serials.push({id:uid(),transaction_id:tx.id,serial_id:serial.id,is_pending:false,created_at:now()});}
    const net=store.material_receipts.filter(row=>row.route_arrival_line_id===line.id).reduce((sum,row)=>sum+(row.event_type==='REVERSAL'?-row.quantity_received:row.quantity_received),0);
    line.resolution_state=net===line.quantity?'POSTED':'STAGED';line.version++;
    return {receipt,inventory_transaction:tx,remaining_staged_quantity:reversal.quantity_received-already-a.p_quantity};
  }
  if(name==='lookup_inventory_serial') {const result=resolveInventorySerialLookupFromList(a.p_input,store.inventory_serials);return result.candidates.length?result.candidates.map(c=>({...result,...c})): [{...result,id:null}];}
  if(name==='create_office_equipment_arrival'){
    const item=store.inventory_items.find(i=>i.id===a.p_item_id);const result={id:uid(),inventory_item_id:item.id,new_model:item.code,quantity:a.p_quantity,unit:item.unit,project_id:a.p_project_id,notes:a.p_notes,expected_delivery_at:a.p_expected_at,receiving_only:true,procurement_status:'ORDERED',receiving_archived_at:null,cancelled_at:null,updated_at:now()};
    store.se_supply_records.push(result);store.receiving_serial_entries.push(...a.p_serials.map(raw=>entry(raw,{se_supply_record_id:result.id},item.id)));return result;
  }
  if(name==='register_receiving_serial'){
    const owner=a.p_source_type==='SE_SUPPLY'?{se_supply_record_id:a.p_source_id}:{project_material_id:a.p_source_id};
    const result=store.receiving_serial_entries.find(e=>key(e)===key(owner)&&e.normalized_serial===normalizeSerialInput(a.p_raw_serial));
    if(result)return result;const fresh=entry(a.p_raw_serial,owner,a.p_inventory_item_id);store.receiving_serial_entries.push(fresh);return fresh;
  }
  if(name==='create_receiving_arrival'){
    const arrival={id:uid(),actual_received_at:a.p_actual_received_at,project_id:a.p_project_id,notes:null,version:1,created_at:now(),voided_at:null};store.receiving_arrivals.push(arrival);
    const lines=a.p_lines.map(spec=>{const line={id:uid(),arrival_id:arrival.id,quantity:spec.quantity,inventory_item_id:spec.inventory_item_id,unit:spec.unit||null,resolution_state:'UNRESOLVED',receipt_id:null,version:1};store.receiving_arrival_lines.push(line);store.receiving_serial_entries.push(...(spec.raw_serials||[]).map(raw=>entry(raw,{arrival_line_id:line.id},spec.inventory_item_id)));if(spec.inventory_item_id)post(line,spec.inventory_item_id);return line;});
    const matches=a.p_matches.map(spec=>{try{const line=lines[spec.line_index];const ids=store.receiving_serial_entries.filter(e=>e.arrival_line_id===line.id&&(spec.raw_serials||[]).includes(e.normalized_serial)).map(e=>e.id);return {status:'MATCHED',match:match(line,{...spec,entry_ids:ids})};}catch(e){return {status:'CONFLICT',message:e.message};}});return {arrival,lines,matches};
  }
  if(name==='complete_receiving_arrival_line'){const line=store.receiving_arrival_lines.find(l=>l.id===a.p_line_id);post(line,a.p_item_id);return line;}
  if(name==='update_receiving_arrival_metadata'){
    const arrival=store.receiving_arrivals.find(r=>r.id===a.p_arrival_id);if(arrival.version!==a.p_expected_version)throw new Error('ARRIVAL_VERSION_CONFLICT');
    const matched=store.receiving_arrival_matches.filter(m=>!m.cancelled_at&&store.receiving_arrival_lines.find(l=>l.id===m.arrival_line_id)?.arrival_id===arrival.id);
    if(a.p_project_id!==arrival.project_id&&matched.some(m=>{const p=source({p_project_material_id:m.project_material_id,p_se_supply_record_id:m.se_supply_record_id});return p.project_id&&p.project_id!==a.p_project_id;}))throw new Error('ARRIVAL_PROJECT_CONFLICT_WITH_MATCH');
    Object.assign(arrival,{project_id:a.p_project_id,notes:a.p_notes,version:arrival.version+1});return arrival;
  }
  if(name==='cancel_receiving_pending_remaining'){
    const args=a.p_source_type==='SE_SUPPLY'?{p_se_supply_record_id:a.p_source_id}:{p_project_material_id:a.p_source_id};const f=fulfilment(args);const p=source(args);p.receiving_archived_at=now();
    store.cancellations[a.p_source_type+':'+a.p_source_id]={cancelled_remaining:f.remaining,fulfilled_at_cancellation:f.fulfilled,cancelled_at:now()};return fulfilment(args);
  }
  if(name==='replace_receiving_arrival_matches'){
    const line=store.receiving_arrival_lines.find(l=>l.id===a.p_line_id);if(line.version!==a.p_expected_version)throw new Error('MATCH_LINE_VERSION_CONFLICT');
    store.receiving_arrival_matches.filter(m=>m.arrival_line_id===line.id&&!m.cancelled_at).forEach(m=>{m.cancelled_at=now();store.receiving_arrival_match_serials.filter(s=>s.match_id===m.id).forEach(s=>s.cancelled_at=m.cancelled_at);});
    for(const spec of a.p_matches)match(line,spec);line.version++;return {version:line.version};
  }
  throw new Error('Fixture RPC not implemented: '+name);
}
export const supabase={
  from(table){const filters=[];let offset=0,end=Infinity,updates=null;const q={
    select(){return q},order(){return q},range(a,b){offset=a;end=b;return q},eq(k,v){filters.push([k,v]);return q},is(k,v){filters.push([k,v]);return q},in(k,values){filters.push([k,new Set(values)]);return q},
    update(value){updates=value;return q},maybeSingle(){q.single=true;return q},
    then(resolve,reject){try{let data=(store[table]||[]).filter(row=>filters.every(([k,v])=>v instanceof Set?v.has(row[k]):v===null?row[k]==null:row[k]===v)).slice(offset,end+1);if(updates){if(table==='se_supply_records'&&'inventory_item_id'in updates)throw new Error('permission denied inventory_item_id');data.forEach(row=>Object.assign(row,updates,{updated_at:now()}));store.calls.push({name:'update:'+table,args:updates});persist();}return Promise.resolve({data:clone(q.single?data[0]||null:data),error:null}).then(resolve,reject);}catch(e){return Promise.resolve({data:null,error:{message:e.message}}).then(resolve,reject);}}
  };return q;},
  async rpc(name,args){
    if(name==='get_receiving_pending_fulfilment'||name==='lookup_inventory_serial')return {data:clone(execute(name,args)),error:null};
    if(name==='post_receiving_arrival_line'&&store.postDelayMs)await new Promise(resolve=>setTimeout(resolve,store.postDelayMs));
    if(name==='delete_receiving_pending_source'&&store.deleteDelayMs)await new Promise(resolve=>setTimeout(resolve,store.deleteDelayMs));
    if(name==='reverse_receiving_inventory_in'&&store.reverseDelayMs)await new Promise(resolve=>setTimeout(resolve,store.reverseDelayMs));
    const payload=JSON.stringify({name,args});if(args.p_request_id&&store.cache[args.p_request_id]){const cache=store.cache[args.p_request_id];return cache.payload===payload?{data:clone(cache.data),error:null}:{data:null,error:{message:'Request conflict'}};}
    const before=clone(store);try{const data=clone(execute(name,args));store.calls.push({name,args});if(args.p_request_id)store.cache[args.p_request_id]={payload,data};persist();return {data,error:null};}catch(e){Object.assign(store,before);store.calls.push({name,args,error:e.message});persist();return {data:null,error:{message:e.message}};}
  },
};
