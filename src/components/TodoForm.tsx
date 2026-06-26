"use client";

import React, { useState, useEffect } from 'react';
import { Todo, Project } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { useUser } from './UserContext';

interface TodoFormProps {
  initialData?: Partial<Todo>;
  onSubmit: (data: Omit<Todo, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function TodoForm({ initialData, onSubmit, onCancel, isSubmitting }: TodoFormProps) {
  const { currentUser } = useUser();
  const [projects, setProjects] = useState<Project[]>([]);
  
  const [formData, setFormData] = useState<Omit<Todo, 'id' | 'created_at' | 'updated_at'>>({
    title: initialData?.title || '',
    content: initialData?.content || '',
    project_id: initialData?.project_id || null,
    task_type: initialData?.task_type || null,
    status: initialData?.status || '待安排',
    created_by: initialData?.created_by || currentUser?.id || null,
    converted_task_id: initialData?.converted_task_id || null,
  });

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    dbAdapter.getProjects().then(data => setProjects(data.filter(p => p.is_active)));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!formData.title) return setErrorMsg('標題為必填');
    await onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">待辦標題 *</span>
          <input 
            type="text" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none"
            value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} 
          />
        </label>
        
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">關聯案場</span>
          <select 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none"
            value={formData.project_id || ''} onChange={e => setFormData({...formData, project_id: e.target.value || null})} 
          >
            <option value="">(無)</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">任務類型</span>
          <select 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none"
            value={formData.task_type || ''} onChange={e => setFormData({...formData, task_type: e.target.value || null})} 
          >
            <option value="">(無)</option>
            {['現勘', '維修', '施工', '掛表', '送電', '清洗', '電檢', '確認', '內部', '其他'].map(t => (
               <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">狀態</span>
          <select 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none"
            value={formData.status} onChange={e => setFormData({...formData, status: e.target.value as any})} 
          >
            <option value="待安排">待安排</option>
            <option value="已排程">已排程</option>
            <option value="取消">取消</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">詳細內容</span>
          <textarea 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none min-h-[80px]"
            value={formData.content || ''} onChange={e => setFormData({...formData, content: e.target.value})} 
          />
        </label>
      </div>
      <div className="flex justify-between items-center mt-4 border-t border-slate-700 pt-4">
        <div className="text-red-400 text-sm font-semibold">{errorMsg || ''}</div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={isSubmitting} className="px-4 py-2 rounded text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            取消
          </button>
          <button type="submit" disabled={isSubmitting} className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50">
            {isSubmitting ? '儲存中...' : '儲存待辦'}
          </button>
        </div>
      </div>
    </form>
  );
}
