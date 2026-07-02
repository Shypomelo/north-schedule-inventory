"use client";

import React, { useState, useEffect } from 'react';
import { Project, Contractor, User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { X, Building2, Wrench, Calendar, FileText, Plus } from 'lucide-react';
import { useUser } from './UserContext';

interface Props {
  project: Project;
  onClose: () => void;
  onUpdate: () => Promise<void>;
}

type TabType = 'basic' | 'contractors' | 'progress' | 'notes';

const CONTRACTOR_TYPES = [
  { key: 'racking', label: '支架' },
  { key: 'electrical', label: '機電' },
  { key: 'steel', label: '鋼構' },
  { key: 'roof_cover', label: '浪板' },
  { key: 'civil', label: '土木' },
  { key: 'other', label: '其他' }
] as const;

export function ProjectDetailModal({ project, onClose, onUpdate }: Props) {
  const { currentUser } = useUser();
  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editedProject, setEditedProject] = useState<Project>(project);
  
  const [users, setUsers] = useState<User[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [saveStatus, setSaveStatus] = useState<'已儲存' | '儲存中' | '儲存失敗' | ''>('');

  useEffect(() => {
    const fetchData = async () => {
      const allUsers = await dbAdapter.getUsers();
      const engineeringUsers = allUsers.filter(u => u.category === 'ENGINEERING' && u.is_active);
      setUsers(engineeringUsers);
      
      const allContractors = await dbAdapter.getContractors();
      setContractors(allContractors.filter(c => c.is_active));
    };
    fetchData();
  }, []);

  const handleSave = async (updates: Partial<Project>) => {
    if (currentUser?.role === 'VIEWER') return;
    try {
      setSaveStatus('儲存中');
      const updated = { ...editedProject, ...updates };
      setEditedProject(updated as Project);
      await dbAdapter.updateProject(project.id, updates);
      await onUpdate();
      setSaveStatus('已儲存');
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (e) {
      console.error(e);
      setSaveStatus('儲存失敗');
    }
  };

  const getContractorDetails = (id: string | null) => {
    if (!id) return null;
    return contractors.find(c => c.id === id);
  };

  const renderBasicInfo = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1">案場名稱</label>
          <input
            type="text"
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.name || ''}
            onChange={e => handleSave({ name: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1">案場代碼</label>
          <input
            type="text"
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.project_code || ''}
            onChange={e => handleSave({ project_code: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1">案場簡稱</label>
          <input
            type="text"
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.short_name || ''}
            onChange={e => handleSave({ short_name: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1">容量 (kW)</label>
          <input
            type="text"
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.capacity || ''}
            onChange={e => handleSave({ capacity: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-slate-400 mb-1">地址</label>
          <input
            type="text"
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.address || ''}
            onChange={e => handleSave({ address: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1">負責工程師</label>
          <select
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.manager || ''}
            onChange={e => handleSave({ manager: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          >
            <option value="">未指定</option>
            {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1">案場狀態</label>
          <select
            className="w-full bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50"
            value={editedProject.status || '開案'}
            onChange={e => handleSave({ status: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          >
            <option value="開案">開案</option>
            <option value="施工中">施工中</option>
            <option value="待驗收">待驗收</option>
            <option value="待掛表">待掛表</option>
            <option value="已結案">已結案</option>
            <option value="作廢">作廢</option>
          </select>
        </div>
      </div>
    </div>
  );

  const renderContractors = () => (
    <div className="space-y-6">
      {CONTRACTOR_TYPES.map(type => {
        const idField = `${type.key}_contractor_id` as keyof Project;
        const statusField = `${type.key}_status` as keyof Project;
        const contractorId = editedProject[idField] as string | null;
        const isDisabled = editedProject[statusField] === 'disabled';
        const contractor = getContractorDetails(contractorId);

        return (
          <div key={type.key} className={`p-4 rounded-xl border transition-colors ${isDisabled ? 'bg-slate-900/30 border-slate-800/50 opacity-50' : 'bg-slate-800/40 border-slate-700/50'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-200 flex items-center gap-2">
                <Wrench size={16} className="text-emerald-500" />
                {type.label}包商
              </h3>
              <button
                onClick={() => handleSave({ [statusField]: isDisabled ? null : 'disabled' })}
                disabled={currentUser?.role === 'VIEWER'}
                className={`px-3 py-1 rounded text-xs font-medium ${isDisabled ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'}`}
              >
                {isDisabled ? '啟用' : '停用'}
              </button>
            </div>
            
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">選擇包商</label>
                <select
                  className="w-full bg-slate-900/50 px-3 py-1.5 rounded border border-slate-700/50 text-sm text-slate-200 outline-none disabled:opacity-50"
                  value={contractorId || ''}
                  onChange={e => handleSave({ [idField]: e.target.value || null })}
                  disabled={isDisabled || currentUser?.role === 'VIEWER'}
                >
                  <option value="">未指定</option>
                  {contractors.filter(c => c.contractor_type === type.key || c.contractor_type === 'other').map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">聯絡人</label>
                <input
                  type="text"
                  readOnly
                  className="w-full bg-slate-900/30 px-3 py-1.5 rounded border border-slate-800/50 text-sm text-slate-400 outline-none"
                  value={contractor?.contact_person || '未指定'}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">電話</label>
                <input
                  type="text"
                  readOnly
                  className="w-full bg-slate-900/30 px-3 py-1.5 rounded border border-slate-800/50 text-sm text-slate-400 outline-none"
                  value={contractor?.phone || '未指定'}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderProgress = () => (
    <div className="space-y-4">
      {CONTRACTOR_TYPES.map(type => {
        const startField = `${type.key}_expected_start_date` as keyof Project;
        const endField = `${type.key}_completion_date` as keyof Project;
        const statusField = `${type.key}_status` as keyof Project;
        const isDisabled = editedProject[statusField] === 'disabled';

        if (isDisabled) return null;

        return (
          <div key={type.key} className="flex items-center gap-4 p-4 bg-slate-800/40 rounded-xl border border-slate-700/50">
            <div className="w-24 font-medium text-slate-300 flex items-center gap-2">
              <Calendar size={14} className="text-blue-400" />
              {type.label}
            </div>
            <div className="flex-1">
              <label className="block text-xs text-slate-500 mb-1">預計進場日</label>
              <input
                type="date"
                className="w-full bg-slate-900/50 px-3 py-1.5 rounded border border-slate-700/50 text-sm text-slate-200 outline-none"
                value={(editedProject[startField] as string) || ''}
                onChange={e => handleSave({ [startField]: e.target.value })}
                disabled={currentUser?.role === 'VIEWER'}
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-slate-500 mb-1">預計完工日</label>
              <input
                type="date"
                className="w-full bg-slate-900/50 px-3 py-1.5 rounded border border-slate-700/50 text-sm text-slate-200 outline-none"
                value={(editedProject[endField] as string) || ''}
                onChange={e => handleSave({ [endField]: e.target.value })}
                disabled={currentUser?.role === 'VIEWER'}
              />
            </div>
          </div>
        );
      })}
      
      {CONTRACTOR_TYPES.every(type => editedProject[`${type.key}_status` as keyof Project] === 'disabled') && (
        <div className="p-8 text-center text-slate-500 bg-slate-800/20 rounded-xl border border-slate-700/30 border-dashed">
          所有工種皆已停用
        </div>
      )}
    </div>
  );

  const renderNotes = () => (
    <div className="h-full flex flex-col">
      <label className="block text-sm font-medium text-slate-400 mb-2">案場備註</label>
      <textarea
        className="flex-1 w-full bg-slate-900/50 p-4 rounded-xl border border-slate-700/50 text-slate-200 outline-none focus:border-emerald-500/50 resize-none leading-relaxed"
        placeholder="輸入備註事項..."
        value={editedProject.notes || ''}
        onChange={e => handleSave({ notes: e.target.value })}
        disabled={currentUser?.role === 'VIEWER'}
      />
    </div>
  );

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'basic', label: '基本資料', icon: <Building2 size={18} /> },
    { id: 'contractors', label: '包商資料', icon: <Wrench size={18} /> },
    { id: 'progress', label: '施工進度', icon: <Calendar size={18} /> },
    { id: 'notes', label: '備註', icon: <FileText size={18} /> }
  ];

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/60 rounded-2xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden relative">
        <div className="p-6 border-b border-slate-700/60 bg-slate-800/40 flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold text-slate-100">{editedProject.name}</h2>
              {saveStatus && (
                <span className={`text-xs px-2 py-1 rounded-full ${saveStatus === '已儲存' ? 'bg-emerald-500/10 text-emerald-400' : saveStatus === '儲存失敗' ? 'bg-rose-500/10 text-rose-400' : 'bg-blue-500/10 text-blue-400'}`}>
                  {saveStatus}
                </span>
              )}
            </div>
            <div className="text-sm text-slate-400 mt-1 flex items-center gap-2">
              <span className="px-2 py-0.5 bg-slate-800 rounded text-xs">{editedProject.status}</span>
              <span>{editedProject.project_code || '無代碼'}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-700/50 rounded-full text-slate-400 transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-48 border-r border-slate-700/60 bg-slate-800/20 p-4 space-y-2 shrink-0">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-medium text-sm
                  ${activeTab === tab.id 
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 border border-transparent'
                  }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-slate-900/30">
            {activeTab === 'basic' && renderBasicInfo()}
            {activeTab === 'contractors' && renderContractors()}
            {activeTab === 'progress' && renderProgress()}
            {activeTab === 'notes' && renderNotes()}
          </div>
        </div>
      </div>
    </div>
  );
}
