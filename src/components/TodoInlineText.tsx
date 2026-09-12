'use client';
import {useRef,useState,type ReactNode} from 'react';
import type {Todo} from '@/lib/db/types';
import {dbAdapter} from '@/lib/db';
import {canEditTodoText,saveTodoText} from '@/lib/todo-text-actions';
import {useUser} from './UserContext';
export function TodoInlineText({todo,onSaved,display}:{todo:Todo;onSaved:()=>Promise<void>;display?:ReactNode}) {
 const {currentUser}=useUser();
 const [editing,setEditing]=useState(false),[title,setTitle]=useState(todo.title),[content,setContent]=useState(todo.content||''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const busy=useRef(false),cancelled=useRef(false);
 const editable=canEditTodoText(todo,currentUser)&&todo.status!=='已收納';
 function open(){if(!editable)return;cancelled.current=false;setTitle(todo.title);setContent(todo.content||'');setError('');setEditing(true);}
 async function save(){if(busy.current||cancelled.current)return;if(!title.trim()){setError('標題為必填');return;}busy.current=true;setSaving(true);setError('');try{await saveTodoText(dbAdapter,todo,currentUser,{title,content});setEditing(false);await onSaved();}catch{setError('儲存失敗，文字仍保留，可重試。');}finally{busy.current=false;setSaving(false);}}
 if(!editing)return <button type="button" disabled={!editable} onClick={open} aria-label={`編輯待辦文字：${todo.title}`} className="block min-h-11 w-full min-w-0 text-left disabled:cursor-default">{display??<><span className="block break-words font-medium">{todo.title}</span>{todo.content&&<span className="mt-1 block whitespace-pre-wrap break-words text-sm text-secondary">{todo.content}</span>}{todo.status==='已收納'&&<span className="text-xs text-secondary">已收納</span>}</>}</button>;
 return <div className="min-w-0 space-y-2" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))void save();}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();cancelled.current=true;setEditing(false);}}}>
  <input autoFocus aria-label="待辦標題" disabled={saving} value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();void save();}}} className="min-h-11 w-full min-w-0 rounded border border-theme-border bg-page px-2"/>
  <textarea aria-label="待辦內容" disabled={saving} rows={3} value={content} onChange={e=>setContent(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.nativeEvent.isComposing){e.preventDefault();void save();}}} className="w-full min-w-0 rounded border border-theme-border bg-page p-2"/>
  <p className="text-xs text-secondary">Enter 儲存標題 · Ctrl+Enter 儲存內容 · Esc 取消</p>{error&&<p role="alert" className="text-sm text-danger">{error}<button type="button" onClick={()=>void save()} className="min-h-11 px-2">重試</button></p>}
 </div>;
}
