const assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path'),fs=require('node:fs');
const load=file=>require('./test-load-ts.cjs')(path.join(__dirname,file));
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');
const {ROLE_LABELS,resolveEngineeringPosition,selectEngineeringMembers,selectProjectsForEngineeringMember,selectActiveProjectsForEngineeringMember,keepValidDefault}=load('personnel-workspace.ts');
const {buildMemberProjectsHref,parseProjectsRoute}=load('project-routes.ts');
const positions=[{id:'engineering',name:' 工程 ',is_active:true,sort_order:10},{id:'design',name:'電力設計',is_active:true,sort_order:20},{id:'old',name:'工程',is_active:false,sort_order:0}];
const users=[{id:'e',name:'工程員',is_active:true,category:'OTHER'},{id:'d',name:'設計員',is_active:true,category:'ENGINEERING'},{id:'off',name:'停用',is_active:false,category:'ENGINEERING'}];
test('system permission labels preserve underlying enum values',()=>assert.deepEqual(ROLE_LABELS,{ADMIN:'管理員',ENGINEER:'一般使用者',VIEWER:'唯讀'}));
test('engineering position resolver is centralized and active-only',()=>assert.equal(resolveEngineeringPosition(positions).id,'engineering'));
test('sidebar engineers come from member_positions, never category',()=>assert.deepEqual(selectEngineeringMembers(users,positions,[{member_id:'e',position_id:'engineering'},{member_id:'d',position_id:'design'}]).map(user=>user.id),['e']));
test('personal project filter requires engineering project assignment',()=>assert.deepEqual(selectProjectsForEngineeringMember(['p1','p2'],'e',positions,[{project_id:'p1',member_id:'e',position_id:'engineering'},{project_id:'p2',member_id:'e',position_id:'design'}]),['p1']));
test('member project href uses one stable member-id contract',()=>{
  assert.equal(buildMemberProjectsHref('member/with slash'),'/projects/member/member%2Fwith%20slash');
  assert.deepEqual(parseProjectsRoute(['member','member-id']),{kind:'member',memberId:'member-id',isLegacy:false});
});
test('projects routes preserve active, all, and legacy member-id compatibility',()=>{
  assert.deepEqual(parseProjectsRoute(undefined),{kind:'all',memberId:null,isLegacy:false});
  assert.deepEqual(parseProjectsRoute(['active']),{kind:'active',memberId:null,isLegacy:false});
  assert.deepEqual(parseProjectsRoute(['legacy-member-id']),{kind:'member',memberId:'legacy-member-id',isLegacy:true});
});
test('personal selectors isolate engineering assignments and exclude inactive or deleted projects',()=>{
  const projectRows=[
    {id:'yuzu-active',status:'進行中',is_active:true},
    {id:'weiyang-active',status:'進行中',is_active:true},
    {id:'yuzu-complete',status:'已完工',is_active:true},
    {id:'yuzu-deleted',status:'進行中',is_active:false},
    {id:'yuzu-design',status:'進行中',is_active:true},
  ];
  const assignmentRows=[
    {project_id:'yuzu-active',member_id:'yuzu',position_id:'engineering'},
    {project_id:'weiyang-active',member_id:'weiyang',position_id:'engineering'},
    {project_id:'yuzu-complete',member_id:'yuzu',position_id:'engineering'},
    {project_id:'yuzu-deleted',member_id:'yuzu',position_id:'engineering'},
    {project_id:'yuzu-design',member_id:'yuzu',position_id:'design'},
  ];
  assert.deepEqual(selectActiveProjectsForEngineeringMember(projectRows,'yuzu',positions,assignmentRows).map(project=>project.id),['yuzu-active']);
  assert.deepEqual(selectActiveProjectsForEngineeringMember(projectRows,'weiyang',positions,assignmentRows).map(project=>project.id),['weiyang-active']);
});
test('default invariant follows selected values',()=>{assert.equal(keepValidDefault(['a','b'],'b'),'b');assert.equal(keepValidDefault(['a'],'b'),'a');assert.equal(keepValidDefault([],null),null);});
test('sidebar and project page have no category or responsible-name canonical filter',()=>{const sidebar=read('../components/SidebarV3.tsx'),projects=read('../app/projects/[[...filter]]/page.tsx');assert.doesNotMatch(sidebar,/\.category/);assert.doesNotMatch(projects,/\.category|p\.manager\s*!==/);assert.match(projects,/selectActiveProjectsForEngineeringMember/);});
test('sidebar href and catch-all parser support direct personal-project refresh',()=>{const sidebar=read('../components/SidebarV3.tsx'),projects=read('../app/projects/[[...filter]]/page.tsx');assert.match(sidebar,/buildMemberProjectsHref\(user\.id\)/);assert.match(projects,/parseProjectsRoute\(params\.filter\)/);assert.match(projects,/memberId = projectsRoute\.kind === 'member'/);});
test('admin modal uses one atomic RPC adapter and hides compatibility category',()=>{const ui=read('../app/admin/users/page.tsx'),adapter=read('db/personnel-workspace-adapter.ts');assert.match(ui,/updateMemberWorkspaceProfile/);assert.doesNotMatch(ui,/既有分類|dbAdapter\.setMemberPositions|dbAdapter\.setMemberWorkGroups|setMemberDashboardViews/);assert.match(adapter,/rpc\('update_member_workspace_profile'/);});
test('workspace gate shows clean configuration state instead of engineering fallback',()=>{const layout=read('../components/LayoutContentV3.tsx');assert.match(layout,/尚未完成工作區設定/);assert.match(layout,/perspectives\.allowed\.length === 0 \|\| workGroups\.configurationRequired/);});
