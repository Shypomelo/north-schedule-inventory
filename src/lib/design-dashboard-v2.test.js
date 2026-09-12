const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const load=require('./test-load-ts.cjs');
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');
const {classifyDesignTodos,sortTodosNewestFirst}=load(path.join(__dirname,'workbench.ts'));

const todo=(id,status,received,created)=>({id,status,received_at:received,created_at:created});
const item=(source,status,zone='zone-a')=>({id:`item-${source}`,source_todo_id:source,status,work_zone_id:zone,received_at:'2026-09-12',created_at:'2026-09-12'});

test('Design Todo sorting uses received_at DESC then created_at DESC',()=>{
 const rows=[todo('older','待安排','2026-09-10','2026-09-11'),todo('same-a','待安排','2026-09-12','2026-09-12T08:00:00Z'),todo('same-b','待安排','2026-09-12','2026-09-12T09:00:00Z')];
 assert.deepEqual(sortTodosNewestFirst(rows).map(row=>row.id),['same-b','same-a','older']);
});

test('Todo relation separates pending, stored and completed without equating stored to completed',()=>{
 const rows=[todo('pending','待安排','2026-09-12','2026-09-12'),todo('stored','已收納','2026-09-11','2026-09-11'),todo('done','已收納','2026-09-10','2026-09-10')];
 const classified=classifyDesignTodos(rows,[item('stored','進行中'),item('done','已完成')]);
 assert.deepEqual(Object.fromEntries(classified.map(row=>[row.todo.id,row.view])),{pending:'pending',stored:'stored',done:'completed'});
 assert.equal(classified.find(row=>row.todo.id==='stored').item.work_zone_id,'zone-a');
});

test('work item actions use owner-scoped canonical row updates and no duplicate insert',()=>{
 const adapter=read('db/workbench-adapter.ts');
 assert.match(adapter,/moveItem[\s\S]*update\(\{work_zone_id:workZoneId\}\)[\s\S]*eq\('owner_member_id',item\.owner_member_id\)/);
 assert.match(adapter,/setItemStatus[\s\S]*completed_at:completedAt/);
 assert.match(adapter,/deleteItem[\s\S]*\.delete\(\)[\s\S]*eq\('owner_member_id',item\.owner_member_id\)/);
 assert.doesNotMatch(adapter,/moveItem[\s\S]{0,300}\.insert\(/);
});

test('Design cards expose desktop context menu, mobile ellipsis and cross-zone drag feedback',()=>{
 const source=read('../components/DesignWorkbench.tsx');
 assert.match(source,/onContextMenu=.*clientX.*clientY/);
 assert.match(source,/label="工作項目操作"/);
 for(const label of ["label:'編輯'","label:'完成'","label:'刪除'"])assert.match(source,new RegExp(label));
 assert.match(source,/MoreHorizontal/);
 assert.match(source,/draggable=\{editable\}/);
 assert.match(source,/workbenchAdapter\.moveItem/);
 assert.match(source,/ring-2 ring-accent\/20/);
});

test('hide completed is a compact header accessory and global scrollbar stays visible but subtle',()=>{
 const dashboard=read('../app/page.tsx'),css=read('../app/globals.css');
 assert.match(dashboard,/headerAccessory=\{<HideCompletedToggle/);
 assert.match(dashboard,/className="flex h-7/);
 assert.doesNotMatch(dashboard,/mb-3 flex min-h-10 cursor-pointer items-center justify-end/);
 assert.match(css,/\*::-webkit-scrollbar \{[\s\S]*width: 6px;[\s\S]*height: 6px;/);
 assert.match(css,/scrollbar-width: thin/);
});
