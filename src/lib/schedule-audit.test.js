const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const fs=require('node:fs');
const load=file=>require('./test-load-ts.cjs')(path.join(__dirname,file));
const {
 createScheduleAuditSnapshot,
 diffScheduleAuditSnapshots,
 formatScheduleAuditValue,
 getDeletedScheduleAuditEntries,
 getScheduleAuditPresentation,
 getScheduleHistoryEntries,
 selectLastBusinessScheduleActivity,
}=load('schedule-audit.ts');
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
 assert.match(detail,/\/>\u6b77\u7a0b/);
 assert.match(detail,/historyIndex \+ 1/);
});

test('schedule snapshot and diff retain only tracked fields that truly changed',()=>{
 const base={...task,project_id:'p',project_name:'舊案場',address:null,task_type:'現勘',title:'工作',description:null,task_date:'2026-09-16',start_time:'09:00',end_time:'10:00',is_all_day:false,main_assignee_id:'u1',status:'未開始'};
 const context={projects:[{id:'p',name:'久田貿易',short_name:null}],users:[{id:'u1',name:'竹哥'},{id:'u2',name:'柚子'}],memberIds:['u2']};
 const before=createScheduleAuditSnapshot(base,context);
 const after=createScheduleAuditSnapshot({...base,project_id:null,project_name:'聯華觀音廠',task_date:'2026-09-17'},context);
 const diff=diffScheduleAuditSnapshots(before,after);
 assert.deepEqual(diff.changedFields,['site','task_date']);
 assert.deepEqual(diff.before,{site:'久田貿易',task_date:'2026-09-16'});
 assert.deepEqual(diff.after,{site:'聯華觀音廠',task_date:'2026-09-17'});
 assert.equal(formatScheduleAuditValue(before.collaborators),'柚子');
});

test('history navigation data includes CREATE and structured UPDATE fields in chronological order',()=>{
 const logs=[
  log('UPDATE_TASK','2026-09-15T06:20:00Z',{before_value:'{"task_type":"現勘"}',after_value:'{"task_type":"維修"}'}),
  log('CREATE_TASK','2026-09-15T01:32:00Z',{before_value:null,after_value:'{"site":"久田貿易","title":"工作"}'}),
 ];
 const entries=getScheduleHistoryEntries(task,logs);
 assert.equal(entries.length,2);
 assert.equal(entries[0].action,'CREATE_TASK');
 assert.equal(entries[1].changes[0].label,'任務類型');
 assert.equal(entries[1].changes[0].before,'現勘');
 assert.equal(entries[1].changes[0].after,'維修');
});

test('general schedule history excludes DELETE and never falls back to raw JSON',()=>{
 const logs=[
  log('DELETE_TASK','2026-09-15T07:00:00Z',{before_value:'{"title":"不應出現"}'}),
  log('UPDATE_TASK','2026-09-15T06:20:00Z',{before_value:'{"unknown":"raw-before"}',after_value:'{"unknown":"raw-after"}'}),
 ];
 const entries=getScheduleHistoryEntries(task,logs);
 assert.equal(entries.some(entry=>entry.action==='DELETE_TASK'),false);
 assert.equal(entries.find(entry=>entry.action==='UPDATE_TASK').changes.length,0);
});

test('deleted Schedule audit keeps its snapshot after the task disappears',()=>{
 const deleted=log('DELETE_TASK','2026-09-15T07:00:00Z',{before_value:'{"site":"原案場","title":"原任務","primary_assignee":"竹哥"}',after_value:null});
 const entries=getDeletedScheduleAuditEntries([deleted]);
 assert.equal(entries.length,1);
 assert.equal(entries[0].snapshot.site,'原案場');
 assert.equal(entries[0].snapshot.primary_assignee,'竹哥');
});
