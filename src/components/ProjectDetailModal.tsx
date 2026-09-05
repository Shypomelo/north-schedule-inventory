"use client";

import React, { useState, useEffect } from 'react';
import { Project, User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { X, Building2, FileText, ListChecks } from 'lucide-react';
import { useUser } from './UserContext';
import { ProjectWorkflow } from './ProjectWorkflow';
import { ConstructionProgressSection, ConstructionWorkTypeControls } from './ConstructionProgressSection';
import { useConstructionProgress, type ConstructionMutationResult } from './useConstructionProgress';
import type { ProjectMilestone } from '@/lib/db/types';
import { ProjectDifficultyAssessments } from './ProjectDifficultyAssessments';

interface Props {
  project: Project;
  onClose: () => void;
  onUpdate: () => Promise<void>;
  onConstructionUpdated: (result: ConstructionMutationResult) => void;
  onMilestoneUpdated: (milestone: ProjectMilestone) => void;
}

type TabType = 'workflow' | 'basic' | 'notes';

export function ProjectDetailModal({ project, onClose, onUpdate, onConstructionUpdated, onMilestoneUpdated }: Props) {
  const { currentUser } = useUser();
  const [activeTab, setActiveTab] = useState<TabType>('workflow');
  const [editedProject, setEditedProject] = useState<Project>(project);
  
  const [users, setUsers] = useState<User[]>([]);
  const construction = useConstructionProgress(project.id, Boolean(currentUser && currentUser.role !== 'VIEWER'), onConstructionUpdated);
  const [saveStatus, setSaveStatus] = useState<'已儲存' | '儲存中' | '儲存失敗' | ''>('');

  useEffect(() => {
    const fetchData = async () => {
      const allUsers = await dbAdapter.getUsers();
      const engineeringUsers = allUsers.filter(u => u.category === 'ENGINEERING' && u.is_active);
      setUsers(engineeringUsers);
    };
    fetchData();
  }, [project.id]);

  const handleSave = async (updates: Partial<Project>) => {
    if (!currentUser || currentUser.role === 'VIEWER') return;
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

  const renderBasicInfo = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">案場名稱</label>
          <input
            type="text"
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent"
            value={editedProject.name || ''}
            onChange={e => handleSave({ name: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">案場代碼</label>
          <input
            type="text"
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent"
            value={editedProject.project_code || ''}
            onChange={e => handleSave({ project_code: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">案場簡稱</label>
          <input
            type="text"
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent"
            value={editedProject.short_name || ''}
            onChange={e => handleSave({ short_name: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">容量 (kW)</label>
          <input
            type="text"
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent"
            value={editedProject.capacity || ''}
            onChange={e => handleSave({ capacity: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-secondary mb-1">地址</label>
          <input
            type="text"
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent"
            value={editedProject.address || ''}
            onChange={e => handleSave({ address: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">負責工程師</label>
          <select
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent cursor-pointer"
            value={editedProject.manager || ''}
            onChange={e => handleSave({ manager: e.target.value })}
            disabled={currentUser?.role === 'VIEWER'}
          >
            <option value="">未指定</option>
            {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">案場狀態</label>
          <select
            className="w-full bg-page px-3 py-2 rounded-lg border border-theme-border text-primary outline-none focus:border-accent cursor-pointer"
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
      <div className="border-t border-theme-border pt-4">
        <p className="mb-3 text-sm text-secondary">參與工種（其他工項請至施工區逐筆新增）</p>
        <ConstructionWorkTypeControls model={construction} />
      </div>
      <ProjectDifficultyAssessments
        projectId={project.id}
        actor={currentUser ? { id: currentUser.id, name: currentUser.name } : null}
        canEdit={Boolean(currentUser && currentUser.role !== 'VIEWER')}
      />
    </div>
  );

  const renderNotes = () => (
    <div className="h-full flex flex-col">
      <label className="block text-sm font-medium text-secondary mb-2">案場備註</label>
      <textarea
        className="flex-1 w-full bg-page p-4 rounded-xl border border-theme-border text-primary outline-none focus:border-accent resize-none leading-relaxed"
        placeholder="輸入備註事項..."
        value={editedProject.notes || ''}
        onChange={e => handleSave({ notes: e.target.value })}
        disabled={currentUser?.role === 'VIEWER'}
      />
    </div>
  );

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'workflow', label: '專案流程', icon: <ListChecks size={18} /> },
    { id: 'basic', label: '基本資料', icon: <Building2 size={18} /> },
    { id: 'notes', label: '備註', icon: <FileText size={18} /> }
  ];

  return (
    <div className="fixed inset-0 bg-page/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-card border border-theme-border rounded-2xl w-full max-w-7xl h-[85vh] max-h-[calc(100vh-2rem)] flex flex-col shadow-2xl overflow-hidden relative">
        <div className="p-6 border-b border-theme-border bg-card/40 flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold text-primary">{editedProject.name}</h2>
              {saveStatus && (
                <span className={`text-xs px-2 py-1 rounded-full ${saveStatus === '已儲存' ? 'bg-success/10 text-success' : saveStatus === '儲存失敗' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'}`}>
                  {saveStatus}
                </span>
              )}
            </div>
            <div className="text-sm text-secondary mt-1 flex items-center gap-2">
              <span className="px-2 py-0.5 bg-page border border-theme-border rounded text-xs text-primary">{editedProject.status}</span>
              <span>{editedProject.project_code || '無代碼'}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-page rounded-full text-secondary hover:text-primary transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-48 border-r border-theme-border bg-card/20 p-4 space-y-2 shrink-0">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-medium text-sm
                  ${activeTab === tab.id
                    ? 'bg-accent/10 text-accent border border-accent/20'
                    : 'text-secondary hover:bg-page hover:text-primary border border-transparent'
                  }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-6 bg-page/30">
            {activeTab === 'basic' && renderBasicInfo()}
            {activeTab === 'workflow' && <ProjectWorkflow projectId={project.id} projectName={editedProject.name} actor={currentUser ? { id: currentUser.id, name: currentUser.name } : null} canEdit={Boolean(currentUser && currentUser.role !== 'VIEWER')} construction={<ConstructionProgressSection model={construction} />} onUpdate={onUpdate} onMilestoneUpdated={onMilestoneUpdated} />}
            {activeTab === 'notes' && renderNotes()}
          </div>
        </div>
      </div>
    </div>
  );
}
