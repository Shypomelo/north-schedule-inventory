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

test('quick Todo defaults received date locally and sends it without changing created_at',()=>{
  const source=read('../components/DesignWorkbench.tsx');
  const adapter=read('db/poc-supabase.ts');
  assert.match(source,/useState\(format\(new Date\(\),'yyyy-MM-dd'\)\)/);
  assert.match(source,/aria-label="收到日期" required type="date"/);
  assert.match(source,/received_at:receivedDate\+'T00:00:00\+08:00'/);
  assert.match(adapter,/received_at: input\.received_at/);
  assert.doesNotMatch(adapter,/created_at: input\.received_at/);
});

test('Todo cards expose received date as secondary metadata',()=>{
  const source=read('../components/DesignWorkbench.tsx');
  assert.match(source,/replace\('-','\/'\)\} 收到/);
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
