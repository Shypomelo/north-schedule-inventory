const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const fs=require('node:fs');
const load=file=>require('./test-load-ts.cjs')(path.join(__dirname,file));
const {getScheduleAuditPresentation,selectLastBusinessScheduleActivity}=load('schedule-audit.ts');
const log=(action_type,created_at,extra={})=>({id:action_type+created_at,actor_user_id:'human',actor_name:'慈芸',action_type,target_type:'ScheduleTask',target_id:'t',target_label:'TEST',project_id:null,project_name:null,before_value:null,after_value:null,message:null,created_at,...extra});
const task={id:'t',created_by_name:'柚子',created_at:'2026-09-11T00:30:00Z',creation_source:'APP'};

test('creator and created_at remain task provenance while latest human business action comes from history',()=>{
 const logs=[log('UPDATE_TASK','2026-09-11T02:00:00Z'),log('RESCHEDULE_TASK','2026-09-11T03:00:00Z')];
 const result=getScheduleAuditPresentation(task,logs);
 assert.equal(result.creatorName,'柚子');assert.equal(result.createdAt,task.created_at);
 assert.equal(result.lastBusinessModifiedBy,'慈芸');assert.equal(result.lastBusinessModifiedAt,'2026-09-11T03:00:00Z');assert.equal(result.lastBusinessModifiedAction,'改期');
});

test('Google and system technical activity cannot replace the last human business modifier',()=>{
 const human=log('UPDATE_TASK','2026-09-11T02:00:00Z');
 const logs=[human,log('UPDATE_TASK','2026-09-11T04:00:00Z',{actor_user_id:'system',actor_name:'Google'}),log('UPDATE_PROJECT','2026-09-11T05:00:00Z')];
 assert.equal(selectLastBusinessScheduleActivity(logs,'t'),human);
});

test('drag, edit, reschedule, complete and cancel share schedule activity vocabulary',()=>{
 const actions=fs.readFileSync(path.join(__dirname,'schedule-task-actions.ts'),'utf8');
 const schedule=fs.readFileSync(path.join(__dirname,'../app/schedule/page.tsx'),'utf8');
 assert.match(schedule,/actionType: 'DRAG_MOVE_TASK'/);
 for(const action of ['RESCHEDULE_TASK','UPDATE_TASK','ASSIGNEE_CHANGE_TASK','COMPLETE_TASK','DELETE_TASK'])assert.match(actions,new RegExp(action));
 assert.doesNotMatch(schedule,/action_type: 'RESCHEDULE_TASK'[\s\S]{0,240}message: '拖曳改期'/);
});

test('detail shows creation time and derived last business modification metadata',()=>{
 const detail=fs.readFileSync(path.join(__dirname,'../components/ScheduleTaskDetail.tsx'),'utf8');
 assert.match(detail,/getScheduleAuditPresentation/);
 assert.match(detail,/label="建立"/);
 assert.match(detail,/label="最後修改"/);
});
