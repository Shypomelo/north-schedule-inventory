const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');

test('create form uses the existing optional project search without a project select', () => {
  const form = read('../components/TodoForm.tsx');
  const picker = read('../components/ReceivingProjectCombobox.tsx');
  assert.match(form, /project_id: initialData\?\.project_id \|\| null/);
  assert.match(form, /<ReceivingProjectCombobox[\s\S]*?label="關聯案場"[\s\S]*?project_id: projectId \|\| null/);
  assert.doesNotMatch(form, /<select[^>]*value=\{formData\.project_id/);
  assert.match(picker, /filterProjectsForAutocomplete\(projects, query\)/);
  assert.match(picker, /open && query\.trim\(\)/);
  assert.match(picker, /onChange\(''\)/);
});

test('all Team Todo entry points use the shared project editor', () => {
  const dialog = read('../components/TodoTextEditDialog.tsx');
  assert.match(dialog, /<ReceivingProjectCombobox label="關聯案場"/);
  assert.match(dialog, /projectId !== todo\.project_id \? \{ projectId \} : \{\}/);
  assert.match(dialog, /todo\.scope === 'TEAM' &&/);
  for (const file of ['../app/schedule/page.tsx', '../components/DesignWorkbench.tsx', '../app/todos/page.tsx']) {
    const source = read(file);
    assert.match(source, /<TodoTextEditDialog todo=/, file);
    assert.match(source, /canEditTodoText\(/, file);
  }
});
