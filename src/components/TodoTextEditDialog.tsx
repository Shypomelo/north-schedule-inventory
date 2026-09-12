"use client";
import { useState } from 'react';
import type { Todo } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { useUser } from './UserContext';
import { canEditTodoText, saveTodoText } from '@/lib/todo-text-actions';

export function TodoTextEditDialog({ todo, onClose, onSaved }: { todo: Todo; onClose: () => void; onSaved: () => Promise<void> }) {
  const { currentUser } = useUser();
  const [title, setTitle] = useState(todo.title);
  const [content, setContent] = useState(todo.content || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="todo-edit-title" onSubmit={async e => {
      e.preventDefault(); if (saving) return; setSaving(true); setError('');
      try { await saveTodoText(dbAdapter, todo, currentUser, { title, content }); await onSaved(); onClose(); }
      catch (err) { setError(err instanceof Error ? err.message : '儲存失敗'); }
      finally { setSaving(false); }
    }} className="flex max-h-[calc(100dvh-1rem)] min-w-0 w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl border border-theme-border bg-card p-4 sm:p-6">
      <h2 id="todo-edit-title" className="text-xl font-bold">編輯{todo.scope === 'PRIVATE' ? '私人' : '團隊'}待辦</h2>
      <label className="min-w-0 text-sm">標題<input autoFocus required value={title} onChange={e => setTitle(e.target.value)} className="mt-1 min-h-11 min-w-0 w-full rounded border border-theme-border bg-page p-2 text-base" /></label>
      <label className="min-w-0 text-sm">詳細內容<textarea value={content} onChange={e => setContent(e.target.value)} rows={5} className="mt-1 min-w-0 w-full rounded border border-theme-border bg-page p-2 text-base" /></label>
      {todo.converted_task_id && <p className="text-sm text-secondary">已轉為排程。修改待辦文字不會同步修改排程。</p>}
      {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-card pt-2">
        <button type="button" disabled={saving} onClick={onClose} className="min-h-11 rounded border border-theme-border px-4">取消</button>
        <button type="submit" disabled={saving || !title.trim() || !canEditTodoText(todo, currentUser)} className="min-h-11 rounded bg-accent px-4 text-[var(--accent-text)] disabled:opacity-50">{saving ? '儲存中…' : '儲存文字'}</button>
      </div>
    </form>
  </div>;
}
