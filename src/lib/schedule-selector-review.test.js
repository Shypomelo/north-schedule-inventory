const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const load=file=>require('./test-load-ts.cjs')(path.join(__dirname,file));
const {selectScheduleTasksByWorkGroup}=load('schedule-selectors.ts');

test('2026/09/11 TEST fixture with PROJECT ownership and ENGINEERING assistant appears once in both views',()=>{
 const groups=[{id:'engineering',key:'ENGINEERING',name:'工程',is_active:true,sort_order:10},{id:'project',key:'PROJECT',name:'專案設計',is_active:true,sort_order:20}];
 const users=[{id:'ciyun',name:'慈芸',category:'OTHER'},{id:'yozi',name:'柚子',category:'ENGINEERING'}];
 const memberships=[];
 const members=[{id:'assistant',task_id:'test-task',user_id:'yozi',created_at:'2026-09-11T00:00:00Z'}];
 const task={id:'test-task',title:'TEST',task_date:'2026-09-11',work_group_id:'project',main_assignee_id:'ciyun'};
 const context={groups,users,members,memberships};
 assert.deepEqual(selectScheduleTasksByWorkGroup([task,task],'engineering',context).map(row=>row.id),['test-task']);
 assert.deepEqual(selectScheduleTasksByWorkGroup([task,task],'project',context).map(row=>row.id),['test-task']);
 assert.equal(task.work_group_id,'project');
});
