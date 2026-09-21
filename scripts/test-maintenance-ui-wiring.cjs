const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),React=require('react');
const load=require('../src/lib/test-load-ts.cjs');
function EquipmentRecords(){}
function form(status='已排程',type='維修'){
 const states=[],refs=[];let si=0,ri=0;
 const react={...React,useEffect(){},useMemo:f=>f(),useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},useRef(v){return refs[ri++]||={current:v}}};
 const {ScheduleTaskForm}=load(path.resolve('src/components/ScheduleTaskForm.tsx'),{react,'@/lib/db':{dbAdapter:{}},'./MaintenanceUsage':{MaintenanceEquipmentRecords:EquipmentRecords},'./UserContext':{useUser:()=>({currentUser:{id:'editor',role:'ENGINEER'}})},'@/hooks/useScheduleTaskTypes':{useScheduleTaskTypes:()=>({activeTaskTypes:[],isLoading:false,shouldShowLegacyValue:false})}});
 const props={initialData:{id:'task',work_group_id:'group',task_type:type,status,title:'fixture',project_name:'Site',project_id:'site',task_date:'2026-09-21'},initialMemberIds:[],isSubmitting:false,onCancel(){},onSubmit:async()=>{}};
 return {render(){si=ri=0;return ScheduleTaskForm(props)}};
}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object'||!tree.props)return [];return [tree,...nodes(tree.props.children)]}
test('real form renders equipment records for ongoing and completed maintenance',()=>{
 for(const status of ['已排程','完成','已完成']){
  const tree=form(status).render();assert(nodes(tree).some(n=>n.type===EquipmentRecords&&n.props.taskId==='task'));
  assert.equal(nodes(tree).filter(n=>n.type==='input'&&n.props.name==='taskStatus').length,3);
 }
 assert(!nodes(form('已排程','施工').render()).some(n=>n.type===EquipmentRecords));
});
test('unsaved project edits block equipment registration until persisted',()=>{
 const f=form();const input=nodes(f.render()).find(n=>n.type==='input'&&n.props.placeholder==='請輸入或選擇案場名稱...');
 input.props.onChange({target:{value:'Changed site'}});
 assert.equal(nodes(f.render()).find(n=>n.type===EquipmentRecords).props.beforeAdd(),false);
});
test('all completion paths are independent of equipment modal',()=>{
 for(const file of ['src/app/page.tsx','src/app/schedule/page.tsx']){
  const text=fs.readFileSync(file,'utf8');assert.doesNotMatch(text,/MaintenanceCompletionModal|setMaintenanceTask|onCompleteMaintenance/);assert.match(text,/completeScheduleTaskWithActivity/);
 }
 const detail=fs.readFileSync('src/components/ScheduleTaskDetail.tsx','utf8');assert.match(detail,/isMaintenanceScheduleTask\(task\) && <MaintenanceEquipmentRecords/);
 const modal=fs.readFileSync('src/components/MaintenanceEquipmentModal.tsx','utf8');assert.match(modal,/createPortal/);assert.doesNotMatch(modal,/updateScheduleTask|completeSchedule|使用物料/);
});
