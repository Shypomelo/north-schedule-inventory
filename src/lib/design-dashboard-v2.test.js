const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const load=require('./test-load-ts.cjs');
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');
const {classifyDesignTodos,selectTodoPool,sortTodosNewestFirst}=load(path.join(__dirname,'workbench.ts'));

const todo=(id,status,received,created)=>({id,status,received_at:received,created_at:created});
const item=(source,status,zone='zone-a')=>({id:`item-${source}`,source_todo_id:source,status,work_zone_id:zone,received_at:'2026-09-12',created_at:'2026-09-12'});

test('Design Todo sorting uses received_at DESC then created_at DESC',()=>{
 const rows=[todo('older','待安排','2026-09-10','2026-09-11'),todo('same-a','待安排','2026-09-12','2026-09-12T08:00:00Z'),todo('same-b','待安排','2026-09-12','2026-09-12T09:00:00Z')];
 assert.deepEqual(sortTodosNewestFirst(rows).map(row=>row.id),['same-b','same-a','older']);
});

test('Design TO DO pool excludes every Todo already collected into a Work Item',()=>{
 const rows=[todo('pending','待安排','2026-09-12','2026-09-12'),todo('stored','已收納','2026-09-11','2026-09-11'),todo('done','待安排','2026-09-10','2026-09-10'),todo('standalone-complete','已完成','2026-09-09','2026-09-09')];
 const classified=classifyDesignTodos(rows,[item('done','已完成')]);
 assert.deepEqual(Object.fromEntries(classified.map(row=>[row.todo.id,row.view])),{pending:'pending'});
 assert.equal(classified.some(row=>row.todo.id==='stored'||row.todo.id==='done'),false);
});

test('deleted Work Item does not restore its canonically stored Todo to the TO DO pool',()=>{
 const classified=classifyDesignTodos([todo('stored','已收納','2026-09-11','2026-09-11')],[]);
 assert.deepEqual(classified,[]);
});

test('actual Dashboard render path uses the canonical Work Item-aware TO DO pool',()=>{
 const rows=[todo('pending','待安排','2026-09-12','2026-09-12'),todo('stored','已收納','2026-09-11','2026-09-11'),todo('linked','待安排','2026-09-10','2026-09-10')];
 assert.deepEqual(selectTodoPool(rows,[item('linked','進行中')]).map(row=>row.id),['pending']);
 const dashboard=read('../app/page.tsx');
 assert.match(dashboard,/workbenchAdapter\.getItems\(currentUser\.id\)/);
 assert.match(dashboard,/selectTodoPool\(privateTodos, workItems\)/);
 assert.match(dashboard,/selectTodoPool\(selectActiveTeamTodos\([\s\S]*?\), workItems\)/);
 assert.match(dashboard,/aria-label="TO DO 類型"[\s\S]*>我的<[\s\S]*>團隊</);
 assert.equal((dashboard.match(/title="TO DO"/g)||[]).length,2);
 assert.doesNotMatch(dashboard,/TODO/);
});

test('Design fixed completed view uses canonical Work Items without duplicating the TO DO status tabs',()=>{
 const source=read('../components/DesignWorkbench.tsx');
 assert.match(source,/key:'active',label:'進行中'/);
 assert.doesNotMatch(source,/label:'已收納'/);
 assert.doesNotMatch(source,/key:'completed',label:'已完成'/);
 assert.match(source,/\['zones','工作區'\],\['timeline','時間軸'\],\['completed','已完工'\]/);
 assert.match(source,/completedItems=useMemo\(\(\)=>items\.filter\(item=>item\.status==='已完成'\)\.sort\(\(a,b\)=>\(b\.completed_at\|\|''\)\.localeCompare\(a\.completed_at\|\|''\)\)/);
 assert.match(source,/zoneItems=activeItems\.filter/);
});

test('Design cards reuse engineering date presentation for Work Items and project milestones',()=>{
 const design=read('../components/DesignWorkbench.tsx');
 const projects=read('../components/ProjectOverviewCards.tsx');
 assert.match(design,/presentBusinessDate\(\{planned:item\.due_date,actual:item\.completed_at,completed:item\.status==='已完成',today\}\)/);
 assert.match(design,/formatBusinessDay\(item\.received_at\)/);
 assert.match(projects,/presentBusinessDate\(\{planned:node\.planned_date,actual:node\.actual_date,completed:node\.status==='COMPLETED',today\}\)/);
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
