const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const fs=require('node:fs');
const load=file=>require('./test-load-ts.cjs')(path.join(__dirname,file));
const {isActiveProject,selectActiveProjects}=load('project-selectors.ts');
const project=(status,is_active=true)=>({status,is_active});

test('canonical active project predicate excludes terminal and deleted states',()=>{
  assert.equal(isActiveProject(project('進行中')),true);
  for(const status of ['已完工','已結案','已撤案','作廢'])assert.equal(isActiveProject(project(status)),false);
  assert.equal(isActiveProject(project('進行中',false)),false);
});

test('all three perspective surfaces reuse the canonical active predicate',()=>{
  const dashboard=fs.readFileSync(path.join(__dirname,'../app/page.tsx'),'utf8');
  const design=fs.readFileSync(path.join(__dirname,'../components/DesignWorkbench.tsx'),'utf8');
  const activePage=fs.readFileSync(path.join(__dirname,'../app/projects/[[...filter]]/page.tsx'),'utf8');
  assert.match(dashboard,/selectActiveProjects\(projectRows\)/);
  assert.match(dashboard,/responsibilityRows\.filter\(row => isActiveProject\(row\.project\)\)/);
  assert.match(design,/selectActiveProjects\(projects\)/);
  assert.match(activePage,/isActiveProject\(p\)/);
  assert.deepEqual(selectActiveProjects([project('進行中'),project('已結案')]).map(p=>p.status),['進行中']);
});

test('perspective selector uses short labels and sidebar visual tokens',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../components/DashboardViewContext.tsx'),'utf8');
  assert.match(source,/ENGINEERING:'工程'/);
  assert.match(source,/PROJECT_MANAGEMENT:'專案管理'/);
  assert.match(source,/DESIGN:'設計'/);
  assert.doesNotMatch(source,/視角：/);
  assert.match(source,/sidebar-border/);
  assert.match(source,/sidebar-hover/);
});
