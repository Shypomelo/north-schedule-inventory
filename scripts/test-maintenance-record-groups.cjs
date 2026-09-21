const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),React=require('react');
const load=require('../src/lib/test-load-ts.cjs');
const {groupMaintenanceEquipmentRecords}=load(path.resolve('src/lib/db/maintenance-usage.ts'));
const rows=[1,2,3].map(n=>({id:`event-${n}`,request_id:`request-${n}`,model_snapshot:'P401-5RM4MRM',serial_snapshot:`serial-${n}`,source_type:'INVENTORY',replaced_at:'2026-09-21T15:11:00Z',revision:1,notes:null}));
function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t?.props?[t,...nodes(t.props.children)]:[];}
function text(t){return Array.isArray(t)?t.map(text).join(''):t?.props?text(t.props.children):typeof t==='string'||typeof t==='number'?String(t):'';}
test('presentation grouping uses exact model, actual instant and source, never per-device request id',()=>{
 const groups=groupMaintenanceEquipmentRecords([...rows,{...rows[0],id:'4',source_type:'SE_SUPPLY'},{...rows[0],id:'5',replaced_at:'2026-09-21T15:12:00Z'},{...rows[0],id:'6',model_snapshot:'R800'}]);
 assert.equal(groups.length,4);assert.equal(groups[0].records.length,3);assert.equal(rows.length,3);
 assert.equal(groupMaintenanceEquipmentRecords([rows[0],{...rows[1],replaced_at:'2026-09-21T23:11:00+08:00'}]).length,1);
});
test('real records component renders collapsed x3, expands serials and opens shared edit modal',async()=>{
 const states=[],effects=[];let si=0,mounted=false;function Modal(){}
 const react={...React,useEffect:f=>{if(!mounted)effects.push(f);},useState(init){const i=si++;if(!(i in states))states[i]=init;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];}};
 const {MaintenanceEquipmentRecords}=load(path.resolve('src/components/MaintenanceUsage.tsx'),{react,'./MaintenanceEquipmentModal':{MaintenanceEquipmentModal:Modal},'./UserContext':{useUser:()=>({currentUser:{role:'ENGINEER'}})},'@/lib/db/supabaseClient':{supabase:{from:()=>({select:()=>({eq:()=>({order:async()=>({data:rows,error:null})})})})}}});
 const render=()=>{si=0;const t=MaintenanceEquipmentRecords({taskId:'task'});mounted=true;return t;};render();effects.forEach(f=>f());await new Promise(r=>setImmediate(r));
 assert(text(render()).includes('P401-5RM4MRM ×3'));assert(!text(render()).includes('serial-1'));assert.equal(text(render()).split('庫存').length-1,1);
 nodes(render()).find(n=>n.type==='button'&&n.props['aria-expanded']===false).props.onClick();for(const row of rows)assert(text(render()).includes(row.serial_snapshot));
 nodes(render()).find(n=>n.props['aria-label']==='修改 serial-2').props.onClick();const edit=nodes(render()).find(n=>n.type===Modal);assert.equal(edit.props.record.id,'event-2');assert.equal(edit.props.taskId,'task');
});
