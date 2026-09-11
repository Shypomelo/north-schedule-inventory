"use client";

import React, { useState, useEffect } from 'react';
import { Todo, Project, WorkGroup } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { TodoForm } from '@/components/TodoForm';
import { ScheduleTaskForm } from '@/components/ScheduleTaskForm';
import { Plus, Edit2, CalendarPlus, Trash2 } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { useWorkGroups } from '@/hooks/useWorkGroups';
import { requireTodoWorkGroup } from '@/lib/work-groups';
import { TodoTextEditDialog } from '@/components/TodoTextEditDialog';
import { TodoInlineText } from '@/components/TodoInlineText';

export default function TodosPage() {
  const { currentUser } = useUser();
  const workspace = useWorkGroups();
  const [groupId, setGroupId] = useState('');
  const [textTodo, setTextTodo] = useState<Todo | null>(null);
  const [error, setError] = useState('');
  const defaultGroupId = workspace.defaultGroup?.id;
  useEffect(() => { if (workspace.ready && defaultGroupId) setGroupId(defaultGroupId); }, [workspace.ready, defaultGroupId]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workGroups, setWorkGroups] = useState<WorkGroup[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    setIsLoading(true);
    const [tData, pData, groupData] = await Promise.all([
      groupId ? dbAdapter.getTodos(groupId) : Promise.resolve([]),
      dbAdapter.getProjects(),
      dbAdapter.getWorkGroups(),
    ]);
    setTodos(tData);
    setProjects(pData);
    setWorkGroups(groupData);
    setIsLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true); setError('');
    Promise.all([groupId ? dbAdapter.getTodos(groupId) : Promise.resolve([]), dbAdapter.getProjects(), dbAdapter.getWorkGroups()])
      .then(([t, p, g]) => { if (!cancelled) { setTodos(t); setProjects(p); setWorkGroups(g); } })
      .catch(() => { if (!cancelled) setError('待辦載入失敗，請重新整理'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [groupId]);

  const handleCreateOrUpdate = async (data: Omit<Todo, 'id' | 'created_at' | 'updated_at'>) => {
    setIsSubmitting(true);
    try {
      if (editingTodo) {
        await dbAdapter.updateTodo(editingTodo.id, data);
      } else {
        await dbAdapter.createTodo(data);
      }
      setIsModalOpen(false);
      setEditingTodo(null);
      await fetchData();
    } catch (e) {
      console.error(e);
      alert('儲存失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('確定要刪除/取消此待辦嗎？')) return;
    await dbAdapter.deleteTodo(id);
    await fetchData();
  };

  const handleConvertToTask = async (taskData: any, memberIds: string[]) => {
    setIsSubmitting(true);
    try {
      if (!editingTodo) throw new Error('找不到來源待辦');
      const newTask = await dbAdapter.createScheduleTask({
        ...taskData,
        work_group_id: requireTodoWorkGroup(editingTodo),
        source_todo_id: editingTodo.id,
      }, memberIds);
      if (editingTodo) {
        await dbAdapter.updateTodo(editingTodo.id, { status: '已排程', converted_task_id: newTask.id });
      }
      setIsTaskModalOpen(false);
      setEditingTodo(null);
      await fetchData();
    } catch (e) {
      console.error(e);
      alert('排程失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col p-3 sm:p-5 lg:p-8">
      <div className="mb-5 flex flex-col items-stretch justify-between gap-3 sm:mb-8 sm:flex-row sm:items-center">
        <h1 className="text-2xl font-bold text-primary sm:text-3xl">待辦事項</h1>
        <button 
          onClick={() => { setEditingTodo(null); setIsModalOpen(true); }}
          disabled={currentUser?.role === 'VIEWER' || !groupId}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} />
          新增待辦
        </button>
      </div>

      <div className="mb-4 space-y-2">
        <p className="text-sm text-secondary">團隊 TODO 工作群組（不影響 Dashboard 的全域私人 My TODO）</p>
        <div role="tablist" aria-label="團隊待辦工作群組" className="flex flex-wrap gap-2">
          {workGroups.map(group => <button role="tab" aria-selected={groupId === group.id} key={group.id} onClick={() => setGroupId(group.id)} className={`min-h-11 rounded px-3 ${groupId === group.id ? 'bg-accent text-[var(--accent-text)]' : 'bg-card'}`}>{group.name}</button>)}
        </div>
        {(error || workspace.error) && <p role="alert" className="text-danger">{error || workspace.error}</p>}
      </div>
      <div className="flex flex-col gap-4">
        {isLoading ? (
          <div className="text-secondary">載入中...</div>
        ) : todos.length === 0 ? (
          <div className="text-secondary bg-card/30 border border-theme-border p-8 text-center rounded-xl">目前沒有待辦事項</div>
        ) : (
          todos.map(todo => {
            const proj = projects.find(p => p.id === todo.project_id);
            return (
              <div key={todo.id} className={`bg-card/50 border border-theme-border p-4 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ${todo.status === '已排程' ? 'opacity-50' : 'hover:border-accent/50'}`}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-3">
                    <TodoInlineText todo={todo} onSaved={fetchData}/>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${todo.status === '待安排' ? 'bg-warning/20 text-warning' : 'bg-secondary/20 text-secondary'}`}>
                      {todo.status}
                    </span>
                    {todo.task_type && <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full">{todo.task_type}</span>}
                  </div>
                  {proj && <div className="text-sm text-accent mb-2">📍 {proj.name}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {todo.status === '待安排' && (
                    <button 
                      onClick={() => { setEditingTodo(todo); setIsTaskModalOpen(true); }} 
                      disabled={currentUser?.role === 'VIEWER'}
                      className="flex items-center gap-1 text-sm bg-accent/20 text-accent hover:bg-accent/30 px-3 py-1.5 rounded transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <CalendarPlus size={16} />
                      排入排程
                    </button>
                  )}
                  <button onClick={() => setTextTodo(todo)} disabled={currentUser?.role === 'VIEWER'} className="min-h-11 p-2 text-secondary hover:text-primary hover:bg-page rounded transition disabled:opacity-50 disabled:cursor-not-allowed" title="編輯文字" aria-label={`編輯 ${todo.title}`}>
                    <Edit2 size={16} />
                  </button>
                  <button onClick={() => handleDelete(todo.id)} disabled={currentUser?.role === 'VIEWER'} className="p-2 text-secondary hover:text-danger hover:bg-danger/10 rounded transition disabled:opacity-50 disabled:cursor-not-allowed" title="刪除">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {textTodo && <TodoTextEditDialog todo={textTodo} onClose={() => setTextTodo(null)} onSaved={fetchData} />}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:p-4">
          <div className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-theme-border bg-card p-4 shadow-2xl sm:p-6">
            <h2 className="text-2xl font-bold text-primary mb-6">{editingTodo ? '編輯待辦' : '新增待辦'}</h2>
            <TodoForm 
              initialData={editingTodo || { work_group_id: groupId }}
              onSubmit={handleCreateOrUpdate}
              onCancel={() => { setIsModalOpen(false); setEditingTodo(null); }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}

      {isTaskModalOpen && editingTodo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:p-4">
          <div className="max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-auto rounded-2xl border border-theme-border bg-card p-4 shadow-2xl sm:max-h-[90vh] sm:p-6">
            <h2 className="text-2xl font-bold text-primary mb-6">待辦轉為排程任務</h2>
            <ScheduleTaskForm 
              initialData={{
                work_group_id: editingTodo.work_group_id || '',
                title: editingTodo.title,
                description: editingTodo.content || '',
                project_id: editingTodo.project_id || '',
                task_type: editingTodo.task_type || '維修',
              }}
              onSubmit={handleConvertToTask}
              onCancel={() => { setIsTaskModalOpen(false); setEditingTodo(null); }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}
    </div>
  );
}
