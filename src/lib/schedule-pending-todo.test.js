const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app/schedule/page.tsx'),'utf8');

test('pending Todo left click and mobile tap retain schedule conversion',()=>{
 assert.match(source,/onClick=\{\(\) => openTodoConvertForm\(todo, format\(new Date\(\), 'yyyy-MM-dd'\)\)\}/);
});

test('desktop pending Todo context menu prevents browser menu and opens shared editor',()=>{
 assert.match(source,/onContextMenu=\{event => \{[\s\S]{0,120}event\.preventDefault\(\);[\s\S]{0,260}setTodoContextMenu\(\{ todoId: todo\.id/);
 assert.match(source,/>編輯待辦<\/button>/);
 assert.match(source,/<TodoTextEditDialog todo=\{editingTodo\}/);
});

test('right click edit cannot bubble into schedule conversion',()=>{
 assert.match(source,/event\.stopPropagation\(\);const todo=todos\.find/);
});

test('mobile ellipsis exposes edit and delete menu without replacing tap conversion',()=>{
 assert.match(source,/aria-label=\{`待辦操作：\$\{todo\.title\}`\}/);
 assert.match(source,/md:hidden/);
 assert.match(source,/>⋯<\/button>/);
 assert.match(source,/>刪除待辦<\/button>/);
});
