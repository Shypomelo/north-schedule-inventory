// Isolated browser transport for the real V6 components. Never imported by the app.
import { store, supabase as base, useUser, dbAdapter } from './receiving-v5-fixture';
export { store, useUser, dbAdapter };
const uid = () => 'v6-' + ++store.counter;
const now = () => new Date().toISOString();
const persist = () => sessionStorage.setItem('v5-fixture', JSON.stringify(store));
store.inventory_transactions ||= []; store.inventory_monthly_closings ||= []; store.receiving_inventory_allocations ||= [];
store.inventory_transaction_serials ||= [];
Object.assign(dbAdapter, {
  listProjectMaterialBatches: async id => structuredClone(store.project_material_batches.filter(r=>r.project_id===id)),
  listProjectMaterials: async id => structuredClone(store.project_materials.filter(r=>r.project_id===id)),
  listMaterialCatalogItems: async () => [], listMaterialGroups: async () => [],
  listMaterialReceipts: async () => structuredClone(store.material_receipts),
});
const normalize = s => String(s||'').trim().replace(/\s+/g,' ').toLowerCase();
const received = id => store.material_receipts.filter(r=>r.project_material_id===id).reduce((n,r)=>n+(r.event_type==='REVERSAL'?-1:1)*r.quantity_received,0);
function requirements(project,item) {
  return store.project_materials.filter(m=>m.project_id===project&&m.inventory_item_id===item&&!m.receiving_archived_at&&m.delivery_destination==='SITE'&&m.quantity>received(m.id))
    .map(m=>({...m,batch_name:store.project_material_batches.find(b=>b.id===m.batch_id)?.batch_name,received:received(m.id)}));
}
function ensureTransactions() {
  for (const r of store.material_receipts.filter(r => r.arrival_line_id && r.event_type === 'RECEIVE' && !r.inventory_transaction_id)) {
    const l = store.receiving_arrival_lines.find(l => l.id === r.arrival_line_id); r.inventory_transaction_id = uid();
    store.inventory_transactions.push({id:r.inventory_transaction_id,item_id:l.inventory_item_id,transaction_type:'IN',quantity:l.quantity,transaction_date:'2026-09-27',project_id:null,is_voided:false});
  }
}
function scope(id) {
  const r=store.material_receipts.find(r=>r.id===id), l=store.receiving_arrival_lines.find(l=>l.id===r?.arrival_line_id);
  if(!l)throw Error('HANDOFF_SOURCE_INACTIVE');
  const item=store.inventory_items.find(i=>i.id===l.inventory_item_id);
  const allocations=store.receiving_inventory_allocations.filter(a=>a.office_receipt_id===id);
  const active=allocations.filter(a=>!a.cancelled_at);
  const se=active.filter(a=>a.route_type==='SE').reduce((n,a)=>n+a.quantity,0),site=active.filter(a=>a.route_type==='SITE').reduce((n,a)=>n+a.quantity,0);
  const serials=store.receiving_serial_entries.filter(e=>e.active_receipt_id===id).map(e=>e.inventory_serial_id).filter(id=>!active.some(a=>a.inventory_serial_id===id));
  return {receipt_id:id,arrival_line_id:l.id,item_id:item.id,requires_serial:item.requires_serial,received:l.quantity,se,site,available:l.quantity-se-site,other:0,available_serial_ids:serials,allocations};
}
function execute(name,a) {
  if(name==='get_receiving_project_requirements')return requirements(a.p_project_id,a.p_item_id);
  if(name==='get_or_create_inventory_item'){
    const key=normalize(a.p_identity_key);
    const existing=store.inventory_items.find(i=>normalize(i.canonical_identity_key)===key)||store.inventory_items.find(i=>normalize(i.code)===key);
    if(existing){if(normalize(existing.unit)!==normalize(a.p_unit)||existing.requires_serial!==a.p_requires_serial)throw Error('INVENTORY_ITEM_DEFINITION_CONFLICT');return {item:existing,created:false};}
    if(store.inventory_items.filter(i=>normalize(i.name)===key).length>1)throw Error('AMBIGUOUS_EXISTING_ITEMS');
    const item={id:uid(),code:a.p_identity_key.trim(),name:a.p_identity_key.trim(),canonical_identity_key:key,unit:a.p_unit,requires_serial:a.p_requires_serial,is_active:true,category:'設備維修'};
    store.inventory_items.push(item);return {item,created:true};
  }
  if(name==='get_receiving_handoff_scope')return scope(a.p_receipt_id);
  if(name==='route_receiving_inventory'){
    const s=scope(a.p_receipt_id);if(a.p_quantity>s.available||a.p_serial_ids.some(id=>!s.available_serial_ids.includes(id)))throw Error('HANDOFF_CAPACITY_CONFLICT');
    const groups=s.requires_serial?a.p_serial_ids.map(id=>({id,quantity:1})):[{id:null,quantity:a.p_quantity}];const out=[];
    let tx=null,site=null;
    if(a.p_route_type==='SITE'){
      let material=store.project_materials.find(m=>m.id===a.p_material_id);
      if(!material&&a.p_create_new){const item=store.inventory_items.find(i=>i.id===s.item_id);const batch={id:uid(),project_id:a.p_project_id,batch_name:'收貨送達批次',created_at:now(),same_day_delivery:true};store.project_material_batches.push(batch);material={id:uid(),project_id:a.p_project_id,batch_id:batch.id,inventory_item_id:item.id,item_name:item.name,specification:item.code,unit:item.unit,quantity:a.p_quantity,procurement_status:'ORDERED',delivery_destination:'SITE',created_at:now(),include_in_purchase_request:false};store.project_materials.push(material);}
      if(!material||material.quantity-received(material.id)<a.p_quantity)throw Error('PROJECT_REQUIREMENT_CHANGED');
      tx={id:uid(),item_id:s.item_id,project_id:a.p_project_id,transaction_type:'OUT',quantity:a.p_quantity,transaction_date:'2026-09-27',is_voided:false};store.inventory_transactions.push(tx);
      for(const serialId of a.p_serial_ids)store.inventory_transaction_serials.push({id:uid(),transaction_id:tx.id,serial_id:serialId,serial_no:store.inventory_serials.find(i=>i.id===serialId).serial_number});
      site={id:uid(),source_type:'PROJECT_MATERIAL',project_material_id:material.id,quantity_received:a.p_quantity,event_type:'RECEIVE',receipt_location:'SITE',inventory_transaction_id:tx.id,inventory_linked:true,received_at:now()};store.material_receipts.push(site);store.inventoryWrites++;
    }
    for(const g of groups){let se=null;if(a.p_route_type==='SE'){se={id:uid(),inventory_item_id:s.item_id,inventory_serial_id:g.id,quantity:g.quantity,unit:'台',project_id:a.p_project_id,receiving_only:false,cancelled_at:null,replace_date:null,updated_at:now()};store.se_supply_records.push(se);out.push(se);}
      store.receiving_inventory_allocations.push({id:uid(),office_receipt_id:s.receipt_id,inventory_item_id:s.item_id,inventory_serial_id:g.id,quantity:g.quantity,route_type:a.p_route_type,se_supply_record_id:se?.id||null,site_receipt_id:site?.id||null,inventory_transaction_id:tx?.id||null,project_material_id:site?.project_material_id||null,cancelled_at:null,created_at:now(),state:'ACTIVE',supersedes_allocation_id:null,reversal_receipt_id:null});
    }return site?[site]:out;
  }
  const alloc=store.receiving_inventory_allocations.find(x=>x.id===a.p_allocation_id);
  if(!alloc||alloc.cancelled_at)throw Error('HANDOFF_NOT_ACTIVE');if(alloc.state!=='ACTIVE')throw Error('DOWNSTREAM_CORRECTION_REQUIRED');
  if(name==='retract_receiving_handoff'){
    const group=store.receiving_inventory_allocations.filter(x=>alloc.route_type==='SITE'?x.site_receipt_id===alloc.site_receipt_id:x.id===alloc.id);
    for(const x of group){x.cancelled_at=now();x.state=x.route_type==='SE'?'CANCELLED':'REVERSED';if(x.se_supply_record_id)store.se_supply_records.find(s=>s.id===x.se_supply_record_id).cancelled_at=now();}
    if(alloc.route_type==='SITE'){store.inventory_transactions.find(t=>t.id===alloc.inventory_transaction_id).is_voided=true;store.material_receipts.push({id:uid(),source_type:'PROJECT_MATERIAL',project_material_id:alloc.project_material_id,reversal_of_id:alloc.site_receipt_id,event_type:'REVERSAL',quantity_received:group.reduce((n,x)=>n+x.quantity,0),receipt_location:'SITE',received_at:now()});store.inventoryWrites++;}
    return {outcome:'RETRACTED',scope:scope(alloc.office_receipt_id)};
  }
  if(name==='change_receiving_se_handoff'){
    const se=store.se_supply_records.find(s=>s.id===alloc.se_supply_record_id);if(se.updated_at!==a.p_expected_updated_at)throw Error('HANDOFF_VERSION_CONFLICT');
    const s=scope(alloc.office_receipt_id);if(a.p_quantity>s.available+alloc.quantity)throw Error('HANDOFF_CAPACITY_CONFLICT');
    if(a.p_quantity!==alloc.quantity||a.p_serial_id!==alloc.inventory_serial_id){alloc.cancelled_at=now();alloc.state='CANCELLED';store.receiving_inventory_allocations.push({...alloc,id:uid(),quantity:a.p_quantity,inventory_serial_id:a.p_serial_id,cancelled_at:null,state:'ACTIVE',supersedes_allocation_id:alloc.id});}
    Object.assign(se,{quantity:a.p_quantity,inventory_serial_id:a.p_serial_id,project_id:a.p_project_id,updated_at:now()});return {outcome:'MODIFIED'};
  }
  throw Error('Unexpected fixture command');
}
export const supabase={...base,async rpc(name,args){
  if(!['get_receiving_handoff_scope','route_receiving_inventory','retract_receiving_handoff','change_receiving_se_handoff','get_receiving_project_requirements','get_or_create_inventory_item'].includes(name)){
    const r=await base.rpc(name,args);ensureTransactions();persist();
    if(name==='get_receiving_pending_fulfilment'&&r.data){const source=args.p_se_supply_record_id;if(source==='legacy-source'){r.data.fulfilled=1;r.data.remaining=1;}if(r.data.cancellation)r.data.remaining=0;}
    return r;
  }
  if(['get_receiving_handoff_scope','get_receiving_project_requirements','get_or_create_inventory_item'].includes(name)){try{const data=structuredClone(execute(name,args));store.calls.push({name,args});persist();return {data,error:null};}catch(e){return {data:null,error:{message:e.message}};}}
  const payload=JSON.stringify({name,args}), cached=store.cache[args.p_request_id];if(cached)return cached.payload===payload?{data:structuredClone(cached.data),error:null}:{data:null,error:{message:'Request conflict'}};
  const before=structuredClone(store);try{const data=structuredClone(execute(name,args));store.calls.push({name,args});store.cache[args.p_request_id]={payload,data};persist();return {data,error:null};}catch(e){Object.assign(store,before);return {data:null,error:{message:e.message}};}
}};
export const seeded = (async()=>{
  if(store.v6Seed)return store.v6Seed;
  const create=async(item,quantity,project,serials=[]) => (await supabase.rpc('create_office_equipment_arrival',{p_request_id:uid(),p_item_id:item,p_quantity:quantity,p_project_id:project,p_expected_at:'2026-09-28T02:00:00Z',p_notes:null,p_serials:serials})).data.id;
  const serials=Array.from({length:8},(_,i)=>'V6A'+String(i+1).padStart(5,'0')+'-AA');
  const a=await create('serial',20,'north',serials), b=await create('serial',20,'south',['V6B00001-AA','V6B00002-AA']);
  const q=await create('plain',20,'north');
  for(let i=0;i<4;i++)await create(i%2?'serial':'plain',10+i,'south');
  store.v6Seed={a,b,q,serials};persist();return store.v6Seed;
})();
