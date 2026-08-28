"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { User, UserRole } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { Plus, Edit2, ShieldAlert } from 'lucide-react';

const OWNER_TEAM_MEMBER_ID = '65916798-f0ec-4d41-8b17-785c4189bd83';
const isOwnerUser = (user?: Pick<User, 'id'> | null) => user?.id === OWNER_TEAM_MEMBER_ID;

export default function AdminUsersPage() {
  const router = useRouter();
  const { currentUser, isLoading: contextLoading } = useUser();
  const isAdmin = currentUser?.role?.toLowerCase() === 'admin';
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
    notes: '',
    google_calendar_email: ''
  });

  useEffect(() => {
    if (!contextLoading) {
      if (!isAdmin) {
        router.push('/');
      } else {
        loadUsers();
      }
    }
  }, [isAdmin, contextLoading, router]);

  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    setIsLoading(true);
    setError(null);
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('讀取超時，請重試')), 10000)
      );
      
      const data = await Promise.race([
        dbAdapter.getUsers(),
        timeoutPromise
      ]) as User[];
      
      setUsers(data);
    } catch (err: any) {
      console.error('Fetch users failed:', err);
      setError(err.message || '無法載入人員資料');
    } finally {
      setIsLoading(false);
    }
  }

  if (contextLoading || !isAdmin) {
    return (
      <div className="flex flex-col w-full">
        <div className="p-8 text-center text-secondary">驗證權限中...</div>
      </div>
    );
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
        notes: user.notes || '',
        google_calendar_email: user.google_calendar_email || ''
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
        notes: '',
        google_calendar_email: ''
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
      const payload = editingUser && isOwnerUser(editingUser)
        ? { ...formData, role: 'ADMIN' as UserRole, is_active: true }
        : formData;

      if (editingUser) {
        await dbAdapter.updateUser(editingUser.id, payload);
      } else {
        await dbAdapter.createUser(payload as any);
      }
      setIsModalOpen(false);
      loadUsers();
      // Force reload layout or context if user edits themselves, but for now just load users table
    } catch (err: any) {
      console.error('Save user error:', err);
      alert(`儲存失敗：${err.message || '未知錯誤'}`);
    }
  };

  const editingOwner = isOwnerUser(editingUser);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
      <div className="flex justify-between items-center bg-card p-6 rounded-xl border border-theme-border shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <ShieldAlert className="text-accent" />
            系統管理 - 人員管理
          </h1>
          <p className="text-secondary mt-1">管理系統人員清單及權限角色</p>
        </div>
        <button
          onClick={() => handleOpenModal()}
          className="bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg shadow-accent/20 transition font-medium"
        >
          <Plus size={18} />
          新增人員
        </button>
      </div>

      <div className="bg-card border border-theme-border rounded-xl overflow-hidden shadow-sm">
        {error ? (
          <div className="p-12 text-center text-danger">
            <p className="font-bold mb-2">載入失敗</p>
            <p>{error}</p>
            <button onClick={() => loadUsers()} className="mt-4 px-4 py-2 bg-card hover:bg-page border border-theme-border text-primary rounded transition">重試</button>
          </div>
        ) : isLoading ? (
          <div className="p-12 text-center text-secondary">載入中...</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap">
            <thead className="bg-page text-secondary text-sm border-b border-theme-border">
              <tr>
                <th className="p-4 font-semibold">姓名</th>
                <th className="p-4 font-semibold">簡稱</th>
                <th className="p-4 font-semibold">分類</th>
                <th className="p-4 font-semibold">角色</th>
                <th className="p-4 font-semibold">狀態</th>
                <th className="p-4 font-semibold">登入 Email</th>
                <th className="p-4 font-semibold">Google Calendar Email</th>
                <th className="p-4 font-semibold">備註</th>
                <th className="p-4 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50 text-sm">
              {users.map(user => {
                const isOwner = isOwnerUser(user);

                return (
                <tr key={user.id} className="hover:bg-card/60 transition-colors">
                  <td className="p-4 text-primary font-medium">
                    <div className="flex items-center gap-2">
                      <span>{user.name}</span>
                      {isOwner && (
                        <span className="rounded bg-warning/15 border border-warning/30 px-2 py-0.5 text-xs font-medium text-warning">
                          系統擁有者
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4 text-secondary">{user.short_name}</td>
                  <td className="p-4 text-secondary">
                    {user.category === 'ENGINEERING' ? '工程' : user.category === 'MANAGEMENT' ? '管理' : user.category === 'OTHER' ? '其他' : '-'}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      user.role?.toLowerCase() === 'admin' ? 'bg-accent/20 text-accent font-semibold' :
                      user.role === 'ENGINEER' ? 'bg-page text-primary border border-theme-border' :
                      'bg-theme-border/30 text-secondary'
                    }`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="p-4">
                    {user.is_active ? (
                      <span className="text-success flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success"></span> 啟用</span>
                    ) : (
                      <span className="text-secondary/60 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-secondary/60"></span> 停用</span>
                    )}
                  </td>
                  <td className="p-4 text-secondary">{user.email}</td>
                  <td className="p-4 text-secondary">{user.google_calendar_email || '-'}</td>
                  <td className="p-4 text-secondary max-w-[200px] truncate" title={user.notes || ''}>{user.notes || '-'}</td>
                  <td className="p-4 text-right">
                    <button
                      onClick={() => handleOpenModal(user)}
                      className="text-secondary hover:text-accent transition p-1"
                      title="編輯"
                    >
                      <Edit2 size={18} />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-page/80 backdrop-blur-sm">
          <div className="bg-card rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-theme-border">
            <div className="flex justify-between items-center p-6 border-b border-theme-border bg-card/50">
              <h2 className="text-xl font-bold text-primary">
                {editingUser ? '編輯人員' : '新增人員'}
              </h2>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-secondary hover:text-primary transition"
              >
                ✕
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-6 flex flex-col gap-4">
              {editingOwner && (
                <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                  系統擁有者固定為 Admin 且不可停用。
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-secondary">姓名 <span className="text-danger">*</span></label>
                  <input 
                    type="text" 
                    required
                    value={formData.name || ''} 
                    onChange={e => setFormData({...formData, name: e.target.value})}
                    className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                    placeholder="例如: 柚子"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-secondary">簡稱 <span className="text-danger">*</span></label>
                  <input 
                    type="text" 
                    required
                    value={formData.short_name || ''} 
                    onChange={e => setFormData({...formData, short_name: e.target.value})}
                    className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                    placeholder="例如: 柚"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-secondary">人員分類 <span className="text-danger">*</span></label>
                  <select 
                    value={formData.category} 
                    onChange={e => setFormData({...formData, category: e.target.value as 'ENGINEERING' | 'MANAGEMENT' | 'OTHER'})}
                    className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  >
                    <option value="ENGINEERING">工程</option>
                    <option value="MANAGEMENT">管理</option>
                    <option value="OTHER">其他</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-secondary">角色 <span className="text-danger">*</span></label>
                  <select 
                    value={formData.role} 
                    onChange={e => setFormData({...formData, role: e.target.value as UserRole})}
                    disabled={editingOwner}
                    className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="ENGINEER">Engineer</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-secondary">狀態 <span className="text-danger">*</span></label>
                  <select 
                    value={formData.is_active ? 'true' : 'false'} 
                    onChange={e => setFormData({...formData, is_active: e.target.value === 'true'})}
                    disabled={editingOwner}
                    className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="true">啟用</option>
                    <option value="false">停用</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-secondary">登入 Email (Supabase Auth) <span className="text-danger">*</span></label>
                <input 
                  type="email" 
                  required
                  value={formData.email || ''} 
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  disabled={editingOwner}
                  className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="name@example.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-secondary">Google Calendar Email</label>
                <input 
                  type="email" 
                  value={formData.google_calendar_email || ''} 
                  onChange={e => setFormData({...formData, google_calendar_email: e.target.value})}
                  className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  placeholder="calendar@example.com (選填)"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-secondary">備註</label>
                <textarea 
                  value={formData.notes || ''} 
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                  className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent resize-none h-24"
                  placeholder="其他備註資訊..."
                />
              </div>

              <div className="flex justify-end gap-3 mt-4">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg text-secondary hover:text-primary hover:bg-page border border-theme-border transition"
                >
                  取消
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white font-medium shadow-lg shadow-accent/20 transition"
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
