const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');

test('Design Workbench loads PROJECT Team Todo below global private Todo',()=>{
  const source=read('../components/DesignWorkbench.tsx');
  assert.match(source,/group\.is_active&&group\.key==='PROJECT'/);
  assert.match(source,/projectGroup\?dbAdapter\.getTodos\(projectGroup\.id\)/);
  assert.match(source,/我的 TODO[\s\S]*團隊 TODO/);
});

test('quick Todo omits date input and adapter defaults received_at now without changing created_at',()=>{
  const source=read('../components/DesignWorkbench.tsx');
  const adapter=read('db/poc-supabase.ts');
  assert.doesNotMatch(source,/aria-label="收到日期" required type="date"/);
  assert.match(source,/createPrivateTodo\(\{title:title\.trim\(\),created_by:currentUser\.id\}\)/);
  assert.match(adapter,/received_at: input\.received_at \?\? new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(adapter,/created_at: input\.received_at/);
});

test('Todo cards expose received date as secondary metadata',()=>{
  const source=read('../components/DesignWorkbench.tsx');
  assert.match(source,/<TodoReceivedDate/);
  assert.match(source,/formatTodoReceivedDate/);
  assert.match(source,/updatePrivateTodo[\s\S]*updateTodo/);
});

test('desktop workbench panels scroll independently while mobile keeps natural page scroll',()=>{
  const design=read('../components/DesignWorkbench.tsx');
  const dashboard=read('../app/page.tsx');
  for(const source of [design,dashboard])assert.match(source,/min-\[1100px\]:h-\[/);
  assert.match(design,/min-\[1100px\]:\[&>section\]:overflow-y-auto/);
  assert.match(dashboard,/min-\[1100px\]:overflow-y-auto/);
  assert.doesNotMatch(design,/(?:^|\s)h-\[100dvh\](?:\s|$)/);
  assert.doesNotMatch(dashboard,/(?:^|\s)h-\[100dvh\](?:\s|$)/);
});

test('work item editor persists project label and editable business dates but never created_at',()=>{
  const source=read('../components/DesignWorkbench.tsx');
  const adapter=read('db/workbench-adapter.ts');
  assert.match(source,/WorkItemProjectCombobox/);
  assert.match(source,/project_label:draft\.project_label/);
  for(const label of ['收到日期','預計開始','預計完成'])assert.match(source,new RegExp(`FlexibleDateInput label="${label}"`));
  assert.match(adapter,/Pick<WorkItem,'title'\|'content'\|'project_id'\|'project_label'\|'received_at'\|'expected_start_date'\|'due_date'\|'status'>/);
  assert.doesNotMatch(adapter,/Pick<WorkItem[^>]*created_at/);
});

test('flexible date editor commits on blur or Enter and visibly rejects invalid input',()=>{
  const source=read('../components/FlexibleDateInput.tsx');
  assert.match(source,/onBlur=\{commit\}/);
  assert.match(source,/event\.key === 'Enter'/);
  assert.match(source,/aria-invalid=\{invalid\}/);
  assert.match(source,/目前儲存值未變更/);
  assert.match(source,/type="date"/);
});

test('candidate migration adds project_label without changing existing work item ownership RLS',()=>{
  const migration=read('../../supabase/migrations/20260912020803_add_work_item_project_label.sql');
  assert.match(migration,/ADD COLUMN project_label text/);
  assert.match(migration,/NEW\.project_id IS NOT NULL[\s\S]*project\.name INTO NEW\.project_label/);
  assert.doesNotMatch(migration,/CREATE POLICY|DROP POLICY|ALTER TABLE public\.work_items DISABLE ROW LEVEL SECURITY/);
});
