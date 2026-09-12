const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const loadTypeScript = require('./test-load-ts.cjs');

const { resolveWorkItemProjectInput, displayWorkItemProjectLabel } = loadTypeScript(path.join(__dirname, 'work-item-project.ts'));
const projects = [{ id: 'project-1', name: '正式案場' }];

test('arbitrary project name remains an unlinked custom label', () => {
  assert.deepEqual(resolveWorkItemProjectInput('臨時勘查點', projects), { projectId: null, projectLabel: '臨時勘查點' });
});

test('official project selection preserves stable project linkage and canonical name', () => {
  assert.deepEqual(resolveWorkItemProjectInput('正式案場', projects), { projectId: 'project-1', projectLabel: '正式案場' });
});

test('custom project label survives a reload presentation', () => {
  const reloaded = structuredClone({ project_id: null, project_label: '臨時勘查點' });
  assert.equal(displayWorkItemProjectLabel(reloaded, projects), '臨時勘查點');
});
