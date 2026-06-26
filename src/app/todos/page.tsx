"use client";

import React, { useState, useEffect } from 'react';
import { Todo, Project } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { TodoForm } from '@/components/TodoForm';
import { ScheduleTaskForm } from '@/components/ScheduleTaskForm';
import { Plus, Edit2, CalendarPlus, Trash2 } from 'lucide-react';

export default function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

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
        <h1 className="text-3xl font-bold text-slate-100">待辦事項</h1>
        <button 
          onClick={() => { setEditingTodo(null); setIsModalOpen(true); }}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded shadow transition"
        >
          <Plus size={20} />
          新增待辦
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading ? (
          <div className="text-slate-400">載入中...</div>
        ) : todos.length === 0 ? (
          <div className="text-slate-500 bg-slate-800/30 border border-slate-700 p-8 text-center rounded-xl">目前沒有待辦事項</div>
        ) : (
          todos.map(todo => {
            const proj = projects.find(p => p.id === todo.project_id);
            return (
              <div key={todo.id} className={`bg-slate-800/50 border border-slate-700 p-4 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ${todo.status === '已排程' ? 'opacity-50' : 'hover:border-slate-500'}`}>
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="font-semibold text-lg text-slate-200">{todo.title}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${todo.status === '待安排' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-600/50 text-slate-400'}`}>
                      {todo.status}
                    </span>
                    {todo.task_type && <span className="text-xs bg-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded-full">{todo.task_type}</span>}
                  </div>
                  {proj && <div className="text-sm text-emerald-400 mb-2">📍 {proj.name}</div>}
                  {todo.content && <p className="text-slate-400 text-sm whitespace-pre-wrap">{todo.content}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {todo.status === '待安排' && (
                    <button 
                      onClick={() => { setEditingTodo(todo); setIsTaskModalOpen(true); }} 
                      className="flex items-center gap-1 text-sm bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 px-3 py-1.5 rounded transition"
                    >
                      <CalendarPlus size={16} />
                      排入排程
                    </button>
                  )}
                  <button onClick={() => { setEditingTodo(todo); setIsModalOpen(true); }} className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition" title="編輯">
                    <Edit2 size={16} />
                  </button>
                  <button onClick={() => handleDelete(todo.id)} className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-950/50 rounded transition" title="刪除">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-6 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-2xl font-bold text-slate-100 mb-6">{editingTodo ? '編輯待辦' : '新增待辦'}</h2>
            <TodoForm 
              initialData={editingTodo || undefined}
              onSubmit={handleCreateOrUpdate}
              onCancel={() => { setIsModalOpen(false); setEditingTodo(null); }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}

      {isTaskModalOpen && editingTodo && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-6 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-auto shadow-2xl">
            <h2 className="text-2xl font-bold text-slate-100 mb-6">待辦轉為排程任務</h2>
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
