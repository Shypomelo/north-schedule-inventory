const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const ts = require('typescript');

const source = readFileSync(require.resolve('./toolbox-links.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const moduleCopy = { exports: {} };
new Function('module', 'exports', outputText)(moduleCopy, moduleCopy.exports);
const { creatableToolLinkScopes, newToolLinkValues, sortPersonalToolLinks } = moduleCopy.exports;

test('blank name uses URL hostname and optional fields use compact defaults', () => {
  const values = newToolLinkValues({
    url: ' https://docs.example.com/guide ', name: ' ', scope: 'PERSONAL',
    workGroupId: null, memberId: 'member-1',
    links: [
      { scope: 'PERSONAL', owner_member_id: 'member-1', sort_order: 4 },
      { scope: 'PERSONAL', owner_member_id: 'member-2', sort_order: 99 },
    ],
  });
  assert.deepEqual(values, {
    name: 'docs.example.com', url: 'https://docs.example.com/guide', category: '常用',
    description: null, icon_key: null, sort_order: 5, scope: 'PERSONAL',
    owner_member_id: 'member-1', work_group_id: null,
  });
});

test('department link uses its group and appends within that group', () => {
  const values = newToolLinkValues({
    url: 'https://example.com', name: '工程入口', scope: 'DEPARTMENT',
    workGroupId: 'engineering', memberId: 'admin-1',
    links: [
      { scope: 'DEPARTMENT', work_group_id: 'engineering', sort_order: 7 },
      { scope: 'DEPARTMENT', work_group_id: 'design', sort_order: 50 },
    ],
  });
  assert.equal(values.sort_order, 8);
  assert.equal(values.owner_member_id, null);
  assert.equal(values.work_group_id, 'engineering');
});

test('all active ordinary roles can create every toolbox scope', () => {
  assert.deepEqual(creatableToolLinkScopes('ADMIN'), ['PERSONAL', 'DEPARTMENT', 'GLOBAL']);
  assert.deepEqual(creatableToolLinkScopes('ENGINEER'), ['PERSONAL', 'DEPARTMENT', 'GLOBAL']);
  assert.deepEqual(creatableToolLinkScopes('VIEWER'), ['PERSONAL', 'DEPARTMENT', 'GLOBAL']);
  assert.deepEqual(creatableToolLinkScopes('PROCUREMENT'), []);
});

test('personal positions mix scopes and never change shared global order', () => {
  const links = [
    { id: 'a', name: 'A', sort_order: 1, scope: 'GLOBAL' },
    { id: 'b', name: 'B', sort_order: 2, scope: 'PERSONAL' },
    { id: 'c', name: 'C', sort_order: 3, scope: 'DEPARTMENT' },
  ];
  assert.deepEqual(sortPersonalToolLinks(links, { c: 1, a: 2, b: 3 }).map(link => link.id), ['c', 'a', 'b']);
  assert.deepEqual(sortPersonalToolLinks(links, { b: 1, c: 2, a: 3 }).map(link => link.id), ['b', 'c', 'a']);
  assert.deepEqual(links.map(link => link.sort_order), [1, 2, 3]);
});

test('invalid URL and missing department are rejected before insert', () => {
  const input = { url: 'http://example.com', name: '', scope: 'PERSONAL', workGroupId: null, memberId: 'member-1', links: [] };
  assert.throws(() => newToolLinkValues(input), /HTTPS/);
  assert.throws(() => newToolLinkValues({ ...input, url: 'https://example.com', scope: 'DEPARTMENT' }), /部門/);
});
