const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, 'keyed-write-queue.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const { createKeyedWriteQueue } = mod.exports;

test('rapid writes to two different rows both start and finish', async () => {
  const queue = createKeyedWriteQueue();
  const started = [];
  const finish = [];
  const first = queue.run('project-a:racking', () => new Promise(resolve => {
    started.push('a'); finish[0] = () => resolve('saved-a');
  }));
  const second = queue.run('project-b:electrical', () => new Promise(resolve => {
    started.push('b'); finish[1] = () => resolve('saved-b');
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b']);
  finish[1](); finish[0]();
  assert.deepEqual(await Promise.all([first, second]), ['saved-a', 'saved-b']);
});

test('same row stays ordered and a rejected write does not become success', async () => {
  const queue = createKeyedWriteQueue();
  const calls = [];
  let finishFirst;
  const first = queue.run('project-a:racking', () => new Promise((_, reject) => {
    calls.push('first'); finishFirst = () => reject(new Error('RLS denied'));
  }));
  const second = queue.run('project-a:racking', async () => { calls.push('second'); return 'saved'; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['first']);
  finishFirst();
  await assert.rejects(first, /RLS denied/);
  assert.equal(await second, 'saved');
  assert.deepEqual(calls, ['first', 'second']);
});
