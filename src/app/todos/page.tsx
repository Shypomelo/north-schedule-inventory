"use client";

import React, { useState, useEffect } from 'react';
import { Todo, Project } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { TodoForm } from '@/components/TodoForm';
import { ScheduleTaskForm } from '@/components/ScheduleTaskForm';
import { Plus, Edit2, CalendarPlus, Trash2, Undo2 } from 'lucide-react';
import { useUser } from '@/components/UserContext';

export default function TodosPage() {
  const { currentUser, allUsers } = useUser();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [rejectingTodo, setRejectingTodo] = useState<Todo | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [rejectionError, setRejectionError] = useState<string | null>(null);

  const fetchData = async () => {
    setIsLoading(true);
    const [tData, pData] = await Promise.all([dbAdapter.getTodos(), dbAdapter.getProjects()]);
    setTodos(tData);
    setProjects(pData);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreateOrUpdate = async (data: Omit<Todo, 'id' | 'created_at' | 'updated_at'>) => {
    setIsSubmitting(true);
    try {
      if (editingTodo) {
        if (editingTodo.status === '已退件' && !data.assigned_to) {
          throw new Error('重新指派時必須選擇被指派人');
        }

        await dbAdapter.updateTodo(editingTodo.id, {
          ...data,
          status: editingTodo.status === '已退件' ? '待安排' : data.status,
          created_by: editingTodo.created_by,
          assigned_by: editingTodo.assigned_by || (data.assigned_to ? currentUser?.id || null : null),
          converted_task_id: editingTodo.status === '已退件' ? null : data.converted_task_id,
        });
      } else {
        await dbAdapter.createTodo({
          ...data,
          created_by: currentUser?.id || null,
          assigned_by: data.assigned_to ? currentUser?.id || null : null,
        });
      }
      setIsModalOpen(false);
      setEditingTodo(null);
      await fetchData();
    } catch (e: any) {
      console.error(e);
      alert(e?.message || '儲存失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    const reason = rejectionReason.trim();
    if (!rejectingTodo || !currentUser) return;
    if (!reason) {
      setRejectionError('退件原因不可空白');
      return;
    }

    setIsSubmitting(true);
    setRejectionError(null);
    try {
      await dbAdapter.rejectTodo(rejectingTodo.id, reason, currentUser.id);
      setRejectingTodo(null);
      setRejectionReason('');
      await fetchData();
    } catch (e: any) {
      console.error(e);
      setRejectionError(e?.message || '退件失敗');
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
      const newTask = await dbAdapter.createScheduleTask(taskData, memberIds);
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
    <div className="p-8 max-w-4xl mx-auto flex flex-col h-full">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-primary">待辦事項</h1>
        <button 
          onClick={() => { setEditingTodo(null); setIsModalOpen(true); }}
          disabled={currentUser?.role === 'VIEWER'}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} />
          新增待辦
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading ? (
          <div className="text-secondary">載入中...</div>
        ) : todos.length === 0 ? (
          <div className="text-secondary bg-card/30 border border-theme-border p-8 text-center rounded-xl">目前沒有待辦事項</div>
        ) : (
          todos.map(todo => {
            const proj = projects.find(p => p.id === todo.project_id);
            const assignee = allUsers.find(user => user.id === todo.assigned_to);
            const rejecter = allUsers.find(user => user.id === todo.rejected_by);
            const canReject = todo.status === '待安排' && todo.assigned_to === currentUser?.id;
            return (
              <div key={todo.id} className={`bg-card/50 border border-theme-border p-4 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ${todo.status === '已排程' ? 'opacity-50' : 'hover:border-accent/50'}`}>
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="font-semibold text-lg text-primary">{todo.title}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      todo.status === '已退件'
                        ? 'bg-danger/20 text-danger font-semibold'
                        : todo.status === '待安排'
                          ? 'bg-warning/20 text-warning'
                          : 'bg-secondary/20 text-secondary'
                    }`}>
                      {todo.status}
                    </span>
                    {todo.task_type && <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full">{todo.task_type}</span>}
                  </div>
                  {proj && <div className="text-sm text-accent mb-2">📍 {proj.name}</div>}
                  {assignee && <div className="text-sm text-secondary mb-1">指派給：{assignee.name}</div>}
                  {todo.content && <p className="text-secondary text-sm whitespace-pre-wrap">{todo.content}</p>}
                  {todo.status === '已退件' && (
                    <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-primary">
                      <div className="font-semibold text-danger">退件原因</div>
                      <div className="mt-1 whitespace-pre-wrap">{todo.rejection_reason}</div>
                      <div className="mt-2 text-xs text-secondary">
                        {rejecter?.name || '被指派人'}
                        {todo.rejected_at ? `・${new Date(todo.rejected_at).toLocaleString('zh-TW')}` : ''}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canReject && (
                    <button
                      onClick={() => {
                        setRejectingTodo(todo);
                        setRejectionReason('');
                        setRejectionError(null);
                      }}
                      disabled={isSubmitting || currentUser?.role === 'VIEWER'}
                      className="flex items-center gap-1 text-sm bg-danger/10 text-danger hover:bg-danger/20 px-3 py-1.5 rounded transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Undo2 size={16} />
                      退件
                    </button>
                  )}
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
                  <button onClick={() => { setEditingTodo(todo); setIsModalOpen(true); }} disabled={currentUser?.role === 'VIEWER'} className="p-2 text-secondary hover:text-primary hover:bg-page rounded transition disabled:opacity-50 disabled:cursor-not-allowed" title="編輯">
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

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-theme-border p-6 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-2xl font-bold text-primary mb-6">{editingTodo ? '編輯待辦' : '新增待辦'}</h2>
            <TodoForm 
              initialData={editingTodo || undefined}
              onSubmit={handleCreateOrUpdate}
              onCancel={() => { setIsModalOpen(false); setEditingTodo(null); }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}

      {rejectingTodo && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-theme-border p-6 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-2xl font-bold text-primary">退件</h2>
            <p className="mt-2 text-sm text-secondary">{rejectingTodo.title}</p>
            <label className="mt-5 flex flex-col gap-2">
              <span className="text-sm font-semibold text-primary">退件原因 *</span>
              <textarea
                autoFocus
                required
                value={rejectionReason}
                onChange={event => setRejectionReason(event.target.value)}
                className="min-h-[120px] bg-[var(--input-bg)] border border-[var(--input-border)] rounded p-3 focus:border-danger outline-none text-primary"
                placeholder="請填寫退件原因"
              />
            </label>
            {rejectionError && <div className="mt-2 text-sm font-semibold text-danger">{rejectionError}</div>}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setRejectingTodo(null)}
                disabled={isSubmitting}
                className="px-4 py-2 rounded text-secondary hover:bg-page disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={isSubmitting || !rejectionReason.trim()}
                className="px-4 py-2 rounded bg-danger text-white font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? '送出中...' : '確認退件'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isTaskModalOpen && editingTodo && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-theme-border p-6 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-auto shadow-2xl">
            <h2 className="text-2xl font-bold text-primary mb-6">待辦轉為排程任務</h2>
            <ScheduleTaskForm 
              initialData={{
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
