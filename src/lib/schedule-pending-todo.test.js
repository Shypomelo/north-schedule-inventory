const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app/schedule/page.tsx'),'utf8');

test('pending Todo left click and mobile tap open the existing Todo editor',()=>{
 assert.match(source,/onActivate=\{\(\) => setEditingTodo\(todo\)\}/);
 assert.match(source,/<TodoTextEditDialog todo=\{editingTodo\}/);
});

test('desktop pending Todo context menu uses shared pointer positioning',()=>{
 assert.match(source,/onOpenMenu=\{point => \{[\s\S]{0,220}setTodoContextMenu\(\{ todoId: todo\.id, \.\.\.point \}\)/);
 assert.match(source,/<TodoContextMenu/);
});

test('right click offers schedule conversion and deletion without editing',()=>{
 assert.match(source,/label: '加入排程'[\s\S]{0,180}openTodoConvertForm/);
 assert.match(source,/label: '刪除待辦'[\s\S]{0,180}handleDeleteTodo/);
 const menu = source.slice(source.indexOf("label: '加入排程'"), source.indexOf(')()}'));
 assert.doesNotMatch(menu,/setEditingTodo/);
});

test('mobile TodoRow affordance exposes schedule and delete actions',()=>{
 const row=fs.readFileSync(path.join(__dirname,'../components/TodoRow.tsx'),'utf8');
 assert.match(row,/aria-label=\{`\$\{todo\.title\} 更多操作`\}/);
 assert.match(row,/md:hidden/);
 assert.match(row,/>\s*⋯\s*<\/button>/);
 assert.match(source,/label: '加入排程'/);
 assert.match(source,/label: '刪除待辦'/);
});
