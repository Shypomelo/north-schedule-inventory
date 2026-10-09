const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const filename = path.join(__dirname,'project-work-item-order.ts');
const mod = new Module(filename,module);
mod.filename=filename;
mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
const {mergeProjectWorkItems,moveProjectWorkItem}=mod.exports;

test('common saved positions interleave milestone and construction without copying business rows',()=>{
  const milestone={id:'m',milestone_key:'METER_INSTALLATION',sort_order:100,deleted_at:null,archived_at:null};
  const construction={id:'c',sort_order:20,deleted_at:null,status_override:null};
  const items=mergeProjectWorkItems([milestone],[construction],{'CONSTRUCTION:c':100,'MILESTONE:m':200});
  assert.deepEqual(items.map(item=>`${item.kind}:${item.id}`),['CONSTRUCTION:c','MILESTONE:m']);
  assert.equal(items[0].construction,construction);
  assert.equal(items[1].milestone,milestone);
  assert.deepEqual(moveProjectWorkItem(items,'MILESTONE:m','CONSTRUCTION:c').map(item=>item.kind),['MILESTONE','CONSTRUCTION']);
});

test('hidden duplicate entry and disabled rows are excluded from draggable set',()=>{
  const items=mergeProjectWorkItems([
    {id:'entry',milestone_key:'SITE_ENTRY',deleted_at:null,archived_at:null},
    {id:'real',milestone_key:'EQUIPMENT_REGISTRATION',deleted_at:null,archived_at:null},
  ],[{id:'disabled',deleted_at:null,status_override:'disabled'}],{});
  assert.deepEqual(items.map(item=>item.id),['real']);
});
