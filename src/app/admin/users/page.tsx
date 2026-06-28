"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { User, UserRole } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { Plus, Edit2, ShieldAlert } from 'lucide-react';

export default function AdminUsersPage() {
  const router = useRouter();
  const { currentUser, isLoading: contextLoading } = useUser();
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  
  const [formData, setFormData] = useState<Partial<User>>({
    name: '',
    short_name: '',
    email: '',
    role: 'VIEWER',
    category: 'OTHER',
    is_active: true,
    notes: ''
  });

  useEffect(() => {
    if (!contextLoading) {
      if (currentUser?.role !== 'ADMIN') {
        router.push('/');
      } else {
        loadUsers();
      }
    }
  }, [currentUser, contextLoading, router]);

  async function loadUsers() {
    setIsLoading(true);
    const data = await dbAdapter.getUsers();
    setUsers(data);
    setIsLoading(false);
  }

  if (contextLoading || currentUser?.role !== 'ADMIN') {
    return <div className="p-8 text-center text-slate-400">驗證權限中...</div>;
  }

  const handleOpenModal = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({
        name: user.name,
        short_name: user.short_name,
        email: user.email,
        role: user.role,
        category: user.category || 'OTHER',
        is_active: user.is_active,
        notes: user.notes || ''
      });
    } else {
      setEditingUser(null);
      setFormData({
        name: '',
        short_name: '',
        email: '',
        role: 'VIEWER',
        category: 'OTHER',
        is_active: true,
        notes: ''
      });
    }
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.short_name) {
      alert("姓名與簡稱必填");
      return;
    }
    
    try {
      if (editingUser) {
        await dbAdapter.updateUser(editingUser.id, formData);
      } else {
        await dbAdapter.createUser(formData as any);
      }
      setIsModalOpen(false);
      loadUsers();
      // Force reload layout or context if user edits themselves, but for now just load users table
    } catch (err: any) {
      alert("儲存失敗: " + err.message);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
      <div className="flex justify-between items-center bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldAlert className="text-emerald-400" />
            系統管理 - 人員管理
          </h1>
          <p className="text-slate-400 mt-1">管理系統人員清單及權限角色</p>
        </div>
        <button
          onClick={() => handleOpenModal()}
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg flex items-center gap-2 shadow transition"
        >
          <Plus size={18} />
          新增人員
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-slate-400">載入中...</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap">
            <thead className="bg-slate-900/50 text-slate-300 text-sm border-b border-slate-700">
              <tr>
                <th className="p-4 font-semibold">姓名</th>
                <th className="p-4 font-semibold">簡稱</th>
                <th className="p-4 font-semibold">分類</th>
                <th className="p-4 font-semibold">角色</th>
                <th className="p-4 font-semibold">狀態</th>
                <th className="p-4 font-semibold">Google Calendar Email</th>
                <th className="p-4 font-semibold">備註</th>
                <th className="p-4 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50 text-sm">
              {users.map(user => (
                <tr key={user.id} className="hover:bg-slate-700/30 transition-colors">
                  <td className="p-4 text-slate-200 font-medium">{user.name}</td>
                  <td className="p-4 text-slate-400">{user.short_name}</td>
                  <td className="p-4 text-slate-300">
                    {user.category === 'ENGINEERING' ? '工程' : user.category === 'OTHER' ? '其他' : '-'}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      user.role === 'ADMIN' ? 'bg-purple-500/20 text-purple-300' :
                      user.role === 'ENGINEER' ? 'bg-blue-500/20 text-blue-300' :
                      'bg-slate-500/20 text-slate-300'
                    }`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="p-4">
                    {user.is_active ? (
                      <span className="text-emerald-400 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400"></span> 啟用</span>
                    ) : (
                      <span className="text-slate-500 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500"></span> 停用</span>
                    )}
                  </td>
                  <td className="p-4 text-slate-400">{user.email}</td>
                  <td className="p-4 text-slate-400 max-w-[200px] truncate" title={user.notes || ''}>{user.notes || '-'}</td>
                  <td className="p-4 text-right">
                    <button
                      onClick={() => handleOpenModal(user)}
                      className="text-slate-400 hover:text-emerald-400 transition"
                      title="編輯"
                    >
                      <Edit2 size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-sm">
          <div className="bg-slate-800 rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-slate-700">
            <div className="flex justify-between items-center p-6 border-b border-slate-700 bg-slate-800/50">
              <h2 className="text-xl font-bold text-slate-100">
                {editingUser ? '編輯人員' : '新增人員'}
              </h2>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-6 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-300">姓名 <span className="text-red-400">*</span></label>
                  <input 
                    type="text" 
                    required
                    value={formData.name || ''} 
                    onChange={e => setFormData({...formData, name: e.target.value})}
                    className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                    placeholder="例如: 柚子"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-300">簡稱 <span className="text-red-400">*</span></label>
                  <input 
                    type="text" 
                    required
                    value={formData.short_name || ''} 
                    onChange={e => setFormData({...formData, short_name: e.target.value})}
                    className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                    placeholder="例如: 柚"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-300">人員分類 <span className="text-red-400">*</span></label>
                  <select 
                    value={formData.category} 
                    onChange={e => setFormData({...formData, category: e.target.value as 'ENGINEERING' | 'OTHER'})}
                    className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="ENGINEERING">工程</option>
                    <option value="OTHER">其他</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-300">角色 <span className="text-red-400">*</span></label>
                  <select 
                    value={formData.role} 
                    onChange={e => setFormData({...formData, role: e.target.value as UserRole})}
                    className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="ENGINEER">Engineer</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-300">狀態 <span className="text-red-400">*</span></label>
                  <select 
                    value={formData.is_active ? 'true' : 'false'} 
                    onChange={e => setFormData({...formData, is_active: e.target.value === 'true'})}
                    className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="true">啟用</option>
                    <option value="false">停用</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-300">Google Calendar Email</label>
                <input 
                  type="email" 
                  value={formData.email || ''} 
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  placeholder="name@example.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-300">備註</label>
                <textarea 
                  value={formData.notes || ''} 
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                  className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 text-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 resize-none h-24"
                  placeholder="其他備註資訊..."
                />
              </div>

              <div className="flex justify-end gap-3 mt-4">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg text-slate-300 hover:bg-slate-700 transition"
                >
                  取消
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow transition"
                >
                  {editingUser ? '儲存變更' : '建立人員'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
