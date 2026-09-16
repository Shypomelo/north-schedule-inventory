const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

test('Phase 1 editors use the shared debounced row autosave flow', () => {
  const hook = read('../hooks/useRowAutosave.ts');
  const catalog = read('../app/admin/materials/page.tsx');
  const projectMaterials = read('../components/ProjectMaterials.tsx');
  const workflow = read('../app/admin/workflow-settings/page.tsx');

  assert.match(hook, /delay = 700/);
  assert.match(hook, /timersRef/);
  assert.match(hook, /versionsRef/);
  assert.match(hook, /queuesRef/);
  assert.match(hook, /const flush = useCallback/);
  for (const source of [catalog, workflow]) {
    assert.match(source, /useRowAutosave/);
    assert.match(source, /delay: 700/);
    assert.match(source, /autosave\.flush/);
    assert.match(source, /儲存中…/);
    assert.match(source, /已儲存/);
    assert.match(source, /儲存失敗/);
  }
  assert.match(projectMaterials, /const batchAutosave = useRowAutosave/);
  assert.match(projectMaterials, /const materialAutosave = useRowAutosave/);
  assert.match(projectMaterials, /batchAutosave\.flush/);
  assert.match(projectMaterials, /materialAutosave\.flush/);
  assert.match(projectMaterials, /delay: 700/g);
  assert.match(projectMaterials, /儲存中…/);
  assert.match(projectMaterials, /已儲存/);
  assert.match(projectMaterials, /儲存失敗/);
  assert.match(workflow, /dbAdapter\.updateWorkflowPhase/);
  assert.match(workflow, /dbAdapter\.updateWorkflowType/);
  assert.match(workflow, /dbAdapter\.updateWorkflowTemplateStep/);
});

test('schedule project suggestions stay closed until the first nonblank character', () => {
  const scheduleForm = read('../components/ScheduleTaskForm.tsx');
  assert.match(scheduleForm, /setIsDropdownOpen\(Boolean\(val\.trim\(\)\)\)/);
  assert.match(scheduleForm, /if \(!projectNameInput\.trim\(\)\) return \[\]/);
  assert.match(scheduleForm, /onFocus=\{\(\) => setIsDropdownOpen\(Boolean\(projectNameInput\.trim\(\)\)\)\}/);
  assert.match(scheduleForm, /onClick=\{\(\) => setIsDropdownOpen\(Boolean\(projectNameInput\.trim\(\)\)\)\}/);
});

test('material selection uses canonical groups, five quick slots, ESC, and inline custom drafts', () => {
  const projectMaterials = read('../components/ProjectMaterials.tsx');
  const quickAdd = projectMaterials.slice(
    projectMaterials.indexOf('min-w-[32rem]'),
    projectMaterials.indexOf('min-w-[50rem]'),
  );
  const catalogAdmin = read('../app/admin/materials/page.tsx');
  assert.match(projectMaterials, /dbAdapter\.listMaterialGroups\(false\)/);
  assert.match(projectMaterials, /createQuickSlots\(5\)/);
  assert.match(projectMaterials, /filterMaterialCatalogByGroupId\(catalog, slot\.groupId\)/);
  assert.match(projectMaterials, /event\.key === 'Escape'/);
  assert.match(projectMaterials, /再加 5 格/);
  assert.match(projectMaterials, /buildProjectMaterialFromCatalog/);
  assert.match(quickAdd, /品項／型號/);
  assert.match(quickAdd, /selectedItem\?\.default_unit/);
  assert.doesNotMatch(quickAdd, /型號／規格/);
  assert.match(projectMaterials, /buildCustomProjectMaterial/);
  assert.match(projectMaterials, /CustomDraftGridRow/);
  assert.match(catalogAdmin, /dbAdapter\.createMaterialGroup/);
  assert.match(catalogAdmin, /dbAdapter\.updateMaterialGroup/);
  assert.match(catalogAdmin, /group_id: group\.id/);
  assert.doesNotMatch(catalogAdmin, />儲存</);
});
