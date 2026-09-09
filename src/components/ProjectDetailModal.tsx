"use client";

import React, { useState } from 'react';
import { Project } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { X, Building2, FileText, ListChecks } from 'lucide-react';
import { useUser } from './UserContext';
import { ProjectWorkflow } from './ProjectWorkflow';
import { ConstructionProgressSection, ConstructionWorkTypeControls } from './ConstructionProgressSection';
import { useConstructionProgress, type ConstructionMutationResult } from './useConstructionProgress';
import type { ProjectMilestone } from '@/lib/db/types';
import { ProjectDifficultyAssessments } from './ProjectDifficultyAssessments';
import { ProjectPositionAssignments } from './ProjectPositionAssignments';

interface Props {
  project: Project;
  initialMilestoneId?: string | null;
  onClose: () => void;
  onUpdate: () => Promise<void>;
  onConstructionUpdated: (result: ConstructionMutationResult) => void;
  onMilestoneUpdated: (milestone: ProjectMilestone) => void;
}

type TabType = 'workflow' | 'basic' | 'notes';

export function ProjectDetailModal({ project, initialMilestoneId, onClose, onUpdate, onConstructionUpdated, onMilestoneUpdated }: Props) {
  const { currentUser } = useUser();
  const [activeTab, setActiveTab] = useState<TabType>('workflow');
  const [editedProject, setEditedProject] = useState<Project>(project);
  
  const construction = useConstructionProgress(project.id, Boolean(currentUser && currentUser.role !== 'VIEWER'), onConstructionUpdated);
  const [saveStatus, setSaveStatus] = useState<'已儲存' | '儲存中' | '儲存失敗' | ''>('');

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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <div className="sm:col-span-2">
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
      <ProjectPositionAssignments
        projectId={project.id}
        responsibleMemberName={editedProject.manager}
        canEdit={Boolean(currentUser && currentUser.role !== 'VIEWER')}
        onEngineeringManagerChange={async manager => {
          setEditedProject(current => ({ ...current, manager }));
          await onUpdate();
        }}
      />
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
    <div className="flex h-full min-h-72 flex-col">
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-page/80 p-0 backdrop-blur-sm sm:p-4">
      <div className="relative flex h-[100dvh] max-h-[100dvh] w-full max-w-7xl flex-col overflow-hidden border border-theme-border bg-card shadow-2xl sm:h-[85vh] sm:max-h-[calc(100vh-2rem)] sm:rounded-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border bg-card/40 p-4 sm:p-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h2 className="min-w-0 break-words text-xl font-bold text-primary sm:text-2xl">{editedProject.name}</h2>
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
          <button onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-2 text-secondary transition-colors hover:bg-page hover:text-primary" aria-label="關閉專案詳細資料">
            <X size={24} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
          <div className="flex w-full shrink-0 gap-2 overflow-x-auto border-b border-theme-border bg-card/20 p-2 sm:w-48 sm:flex-col sm:space-y-2 sm:border-b-0 sm:border-r sm:p-4">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex min-h-11 min-w-max items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-all sm:w-full sm:gap-3 sm:px-4 sm:py-3
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

          <div className="min-w-0 flex-1 overflow-y-auto bg-page/30 p-3 sm:p-6">
            {activeTab === 'basic' && renderBasicInfo()}
            {activeTab === 'workflow' && <ProjectWorkflow projectId={project.id} projectName={editedProject.name} targetMilestoneId={initialMilestoneId} actor={currentUser ? { id: currentUser.id, name: currentUser.name } : null} canEdit={Boolean(currentUser && currentUser.role !== 'VIEWER')} canRefresh={currentUser?.role === 'ADMIN'} construction={<ConstructionProgressSection model={construction} />} onUpdate={onUpdate} onMilestoneUpdated={onMilestoneUpdated} />}
            {activeTab === 'notes' && renderNotes()}
          </div>
        </div>
      </div>
    </div>
  );
}
