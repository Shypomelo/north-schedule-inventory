"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { MemberPosition, Position, User, UserRole } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { Plus, Edit2, ShieldAlert } from 'lucide-react';
import { WorkGroup } from '@/lib/db/types';
import { MemberWorkGroup } from '@/lib/work-groups';
import { MemberWorkGroupEditor } from '@/components/MemberWorkGroupEditor';

const OWNER_TEAM_MEMBER_ID = '65916798-f0ec-4d41-8b17-785c4189bd83';
const isOwnerUser = (user?: Pick<User, 'id'> | null) => user?.id === OWNER_TEAM_MEMBER_ID;

export default function AdminUsersPage() {
  const router = useRouter();
  const { currentUser, isLoading: contextLoading } = useUser();
  const isAdmin = currentUser?.role?.toLowerCase() === 'admin';
  const [users, setUsers] = useState<User[]>([]);
  const [workGroups, setWorkGroups] = useState<WorkGroup[]>([]);
  const [memberships, setMemberships] = useState<MemberWorkGroup[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [memberPositions, setMemberPositions] = useState<MemberPosition[]>([]);
  const [selectedPositionIds, setSelectedPositionIds] = useState<string[]>([]);
  const [newPositionName, setNewPositionName] = useState('');
  const [positionSavingId, setPositionSavingId] = useState<string | null>(null);
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
      
      const [data, positionRows, memberPositionRows, groupRows, membershipRows] = await Promise.race([
        Promise.all([
          dbAdapter.getUsers(),
          dbAdapter.getPositions(true),
          dbAdapter.getMemberPositions(),
          dbAdapter.getWorkGroups(),
          dbAdapter.getMemberWorkGroups(),
        ]),
        timeoutPromise
      ]) as [User[], Position[], MemberPosition[], WorkGroup[], MemberWorkGroup[]];
      
      setUsers(data);
      setWorkGroups(groupRows);
      setMemberships(membershipRows);
      setPositions(positionRows);
      setMemberPositions(memberPositionRows);
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
      setSelectedPositionIds(memberPositions
        .filter(link => link.member_id === user.id)
        .map(link => link.position_id));
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
      setSelectedPositionIds([]);
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

      const savedUser = editingUser
        ? await dbAdapter.updateUser(editingUser.id, payload)
        : await dbAdapter.createUser(payload as any);
      await dbAdapter.setMemberPositions(savedUser.id, selectedPositionIds);
      setIsModalOpen(false);
      loadUsers();
      // Force reload layout or context if user edits themselves, but for now just load users table
    } catch (err: any) {
      console.error('Save user error:', err);
      alert(`儲存失敗：${err.message || '未知錯誤'}`);
    }
  };

  const editingOwner = isOwnerUser(editingUser);
  const getUserPositionNames = (userId: string) => {
    const positionIds = new Set(memberPositions
      .filter(link => link.member_id === userId)
      .map(link => link.position_id));
    return positions.filter(position => positionIds.has(position.id)).map(position => position.name);
  };

  const createPosition = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newPositionName.trim();
    if (!name) return;
    setPositionSavingId('new');
    try {
      const sortOrder = positions.reduce((max, position) => Math.max(max, position.sort_order), 0) + 10;
      await dbAdapter.createPosition({ name, sort_order: sortOrder });
      setNewPositionName('');
      await loadUsers();
    } catch (err: any) {
      alert(`新增職位失敗：${err.message || '未知錯誤'}`);
    } finally {
      setPositionSavingId(null);
    }
  };

  const updatePositionLocal = (id: string, updates: Partial<Position>) => {
    setPositions(current => current.map(position => position.id === id ? { ...position, ...updates } : position));
  };

  const savePosition = async (position: Position) => {
    setPositionSavingId(position.id);
    try {
      await dbAdapter.updatePosition(position.id, {
        name: position.name,
        sort_order: position.sort_order,
        is_active: position.is_active,
      });
      await loadUsers();
    } catch (err: any) {
      alert(`儲存職位失敗：${err.message || '未知錯誤'}`);
    } finally {
      setPositionSavingId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
      <div className="flex flex-col items-stretch justify-between gap-3 rounded-xl border border-theme-border bg-card p-4 shadow-sm sm:p-6 lg:flex-row lg:items-center">
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

      <div className="overflow-auto rounded-xl border border-theme-border bg-card shadow-sm">
        {error ? (
          <div className="p-12 text-center text-danger">
            <p className="font-bold mb-2">載入失敗</p>
            <p>{error}</p>
            <button onClick={() => loadUsers()} className="mt-4 px-4 py-2 bg-card hover:bg-page border border-theme-border text-primary rounded transition">重試</button>
          </div>
        ) : isLoading ? (
          <div className="p-12 text-center text-secondary">載入中...</div>
        ) : (
          <table className="min-w-[72rem] w-full text-left border-collapse whitespace-nowrap">
            <thead className="bg-page text-secondary text-sm border-b border-theme-border">
              <tr>
                <th className="p-4 font-semibold">姓名</th>
                <th className="p-4 font-semibold">簡稱</th>
                <th className="p-4 font-semibold">職位</th>
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
                const userPositionNames = getUserPositionNames(user.id);

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
                    {userPositionNames.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {userPositionNames.map(positionName => (
                          <span key={positionName} className="rounded-full border border-theme-border bg-page px-2 py-0.5 text-xs text-primary">
                            {positionName}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span>未設定</span>
                    )}
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

      {!isLoading && !error && <section className="min-w-0 space-y-3 rounded-xl border border-theme-border bg-card p-3 sm:p-6">
        <h2 className="text-lg font-bold">工作群組 / 預設工作空間</h2>
        <p className="text-sm text-secondary">與系統權限、既有分類、專案職位分開設定。未加入群組仍可查看兩邊排程。</p>
        {users.filter(user => user.is_active).map(member => <MemberWorkGroupEditor
          key={`${member.id}:${JSON.stringify(memberships.filter(row => row.member_id === member.id))}`}
          member={member} groups={workGroups} memberships={memberships.filter(row => row.member_id === member.id)}
          isAdmin={isAdmin} onSaved={loadUsers}
        />)}
      </section>}
      <section className="rounded-xl border border-theme-border bg-card p-6 shadow-sm">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-primary">職位管理</h2>
          <p className="mt-1 text-sm text-secondary">職位獨立於系統權限與人員分類，可新增、改名、排序或停用。</p>
        </div>
        <form onSubmit={createPosition} className="mb-4 flex gap-3">
          <input
            value={newPositionName}
            onChange={event => setNewPositionName(event.target.value)}
            placeholder="新增職位名稱"
            className="min-w-0 flex-1 rounded-lg border border-theme-border bg-page px-3 py-2 text-primary outline-none focus:border-accent"
          />
          <button type="submit" disabled={!newPositionName.trim() || positionSavingId !== null} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            新增職位
          </button>
        </form>
        <div className="space-y-2">
          {[...positions].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map(position => (
            <div key={position.id} className={`grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_7rem_6rem_auto] items-end gap-3 rounded-lg border border-theme-border p-3 ${position.is_active ? '' : 'opacity-60'}`}>
              <label className="text-xs text-secondary">名稱
                <input value={position.name} onChange={event => updatePositionLocal(position.id, { name: event.target.value })} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent" />
              </label>
              <label className="text-xs text-secondary">排序
                <input type="number" min={0} value={position.sort_order} onChange={event => updatePositionLocal(position.id, { sort_order: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-theme-border bg-page px-3 py-2 text-sm text-primary outline-none focus:border-accent" />
              </label>
              <label className="flex h-10 items-center gap-2 text-sm text-secondary">
                <input type="checkbox" checked={position.is_active} onChange={event => updatePositionLocal(position.id, { is_active: event.target.checked })} className="h-4 w-4 accent-accent" />啟用
              </label>
              <button type="button" disabled={!position.name.trim() || positionSavingId !== null} onClick={() => void savePosition(position)} className="h-10 rounded-lg border border-theme-border px-4 text-sm text-primary disabled:opacity-50">
                {positionSavingId === position.id ? '儲存中...' : '儲存'}
              </button>
            </div>
          ))}
        </div>
      </section>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 p-2 backdrop-blur-sm sm:p-4">
          <div className="max-h-[calc(100dvh-1rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-theme-border bg-card shadow-xl">
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-secondary">既有分類／相容設定 <span className="text-danger">*</span></label>
                  <select 
                    value={formData.category} 
                    onChange={e => setFormData({...formData, category: e.target.value as 'ENGINEERING' | 'MANAGEMENT' | 'OTHER'})}
                    className="bg-page border border-theme-border rounded-lg p-2.5 text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  >
                    <option value="ENGINEERING">工程</option>
                    <option value="MANAGEMENT">管理</option>
                    <option value="OTHER">其他</option>
                  </select>
                  <p className="text-xs text-secondary">供既有工程人員篩選功能使用；工作職位請在下方職位欄設定。</p>
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

              <fieldset className="rounded-lg border border-theme-border p-3">
                <legend className="px-1 text-sm font-medium text-secondary">職位（可複選）</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {positions.filter(position => position.is_active).map(position => (
                    <label key={position.id} className="flex items-center gap-2 rounded-lg bg-page px-3 py-2 text-sm text-primary">
                      <input
                        type="checkbox"
                        checked={selectedPositionIds.includes(position.id)}
                        onChange={event => setSelectedPositionIds(current => event.target.checked
                          ? Array.from(new Set([...current, position.id]))
                          : current.filter(id => id !== position.id))}
                        className="h-4 w-4 accent-accent"
                      />
                      {position.name}
                    </label>
                  ))}
                  {positions.every(position => !position.is_active) && (
                    <span className="col-span-2 text-sm text-secondary">目前沒有啟用中的職位。</span>
                  )}
                </div>
              </fieldset>

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
