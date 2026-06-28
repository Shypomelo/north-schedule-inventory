"use client";

import React, { useState } from 'react';
import { Project, User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { useUser } from './UserContext';

interface ProjectFormProps {
  initialData?: Partial<Project>;
  onSubmit: (data: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function ProjectForm({ initialData, onSubmit, onCancel, isSubmitting }: ProjectFormProps) {
  const [activeTab, setActiveTab] = useState(1);
  const [users, setUsers] = useState<User[]>([]);
  const { currentUser } = useUser();
  const isViewer = currentUser?.role === 'VIEWER';

  React.useEffect(() => {
    dbAdapter.getUsers().then(uData => {
      setUsers(uData.filter(u => u.is_active && u.category === 'ENGINEERING'));
    });
  }, []);

  const [formData, setFormData] = useState({
    name: initialData?.name || '',
    short_name: initialData?.short_name || '',
    address: initialData?.address || '',
    owner_name: initialData?.owner_name || '',
    contact_name: initialData?.contact_name || '',
    contact_phone: initialData?.contact_phone || '',
    notes: initialData?.notes || '',
    is_active: initialData?.is_active ?? true,
    
    // New fields
    capacity: initialData?.capacity || '',
    region: initialData?.region || '',
    project_type: initialData?.project_type || '',
    status: initialData?.status || '未設定',
    manager: initialData?.manager || '',
    owner_phone: initialData?.owner_phone || '',
    data_source: initialData?.data_source || '',
    warranty_status: initialData?.warranty_status || '',
    completion_date: initialData?.completion_date || '',
    warranty_years: initialData?.warranty_years || '',
    warranty_end_date: initialData?.warranty_end_date || '',
    has_maintenance_contract: initialData?.has_maintenance_contract || '',
    maintenance_start_date: initialData?.maintenance_start_date || '',
    maintenance_end_date: initialData?.maintenance_end_date || '',
    maintenance_notes: initialData?.maintenance_notes || '',
    inverter_brand: initialData?.inverter_brand || '',
    inverter_warranty: initialData?.inverter_warranty || '',
    monitoring_system: initialData?.monitoring_system || '',
    module_mounting_type: initialData?.module_mounting_type || '',
    
    // Inspection
    last_inspection_date: initialData?.last_inspection_date || '',
    inspection_cycle_months: initialData?.inspection_cycle_months || '',
    next_inspection_date: initialData?.next_inspection_date || '',
    inspection_reminder_days: initialData?.inspection_reminder_days || '',

  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return alert('案場名稱為必填');
    await onSubmit(formData as any); 
  };

  const InputField = ({ label, field, required = false, type = 'text', colSpan = 1 }: { label: string, field: keyof typeof formData, required?: boolean, type?: string, colSpan?: number }) => (
    <label className={`flex flex-col gap-1 ${colSpan === 2 ? 'md:col-span-2' : ''} ${colSpan === 3 ? 'md:col-span-3' : ''}`}>
      <span className="text-sm font-semibold text-slate-300">{label} {required && <span className="text-rose-500">*</span>}</span>
      <input 
        type={type} required={required}
        className="bg-slate-900 border border-slate-700 rounded p-2.5 focus:border-emerald-500 outline-none text-slate-100 placeholder:text-slate-500 transition-colors w-full"
        value={formData[field] as string} 
        onChange={e => setFormData({...formData, [field]: e.target.value})} 
      />
    </label>
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full w-full max-h-[85vh]">
      
      {/* Tabs Header */}
      <div className="flex gap-2 border-b border-slate-700/50 mb-6 overflow-x-auto shrink-0 hide-scrollbar pb-1">
        <button 
          type="button" 
          onClick={() => setActiveTab(1)} 
          className={`px-4 py-2.5 rounded-t-lg font-medium whitespace-nowrap transition-colors ${activeTab === 1 ? 'bg-slate-800 border-t-2 border-emerald-500 text-emerald-400 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]' : 'border-t-2 border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
        >
          基本資料
        </button>
        <button 
          type="button" 
          onClick={() => setActiveTab(2)} 
          className={`px-4 py-2.5 rounded-t-lg font-medium whitespace-nowrap transition-colors ${activeTab === 2 ? 'bg-slate-800 border-t-2 border-emerald-500 text-emerald-400 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]' : 'border-t-2 border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
        >
          聯絡資料
        </button>
        <button 
          type="button" 
          onClick={() => setActiveTab(3)} 
          className={`px-4 py-2.5 rounded-t-lg font-medium whitespace-nowrap transition-colors ${activeTab === 3 ? 'bg-slate-800 border-t-2 border-emerald-500 text-emerald-400 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]' : 'border-t-2 border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
        >
          保固 / 維運
        </button>
        <button 
          type="button" 
          onClick={() => setActiveTab(4)} 
          className={`px-4 py-2.5 rounded-t-lg font-medium whitespace-nowrap transition-colors ${activeTab === 4 ? 'bg-slate-800 border-t-2 border-emerald-500 text-emerald-400 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]' : 'border-t-2 border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
        >
          設備 / 備註
        </button>
      </div>

      {/* Tabs Content */}
      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar min-h-[300px]">
        
        {/* Tab 1: 基本資料 */}
        {activeTab === 1 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 animate-in fade-in duration-300">
            <InputField label="案場名稱" field="name" required colSpan={2} />
            <InputField label="案場簡稱" field="short_name" />
            <InputField label="容量 (kW)" field="capacity" />
            <InputField label="案場區域" field="region" />
            
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-300">案場狀態</span>
              <select 
                className="bg-slate-900 border border-slate-700 rounded p-2.5 focus:border-emerald-500 outline-none text-slate-100 transition-colors cursor-pointer appearance-none w-full"
                value={formData.status} 
                onChange={e => setFormData({...formData, status: e.target.value})}
              >
                <option value="未設定">未設定</option>
                <option value="進行中">進行中</option>
                <option value="完成">完成</option>
                <option value="結案">結案</option>
                <option value="其他">其他</option>
              </select>
            </label>

            <InputField label="地址" field="address" colSpan={3} />
            
            <label className="flex items-center gap-3 mt-2 md:col-span-3 bg-slate-800/40 p-3 rounded-lg border border-slate-700/50">
              <input 
                type="checkbox" 
                className="w-5 h-5 accent-emerald-500 cursor-pointer rounded border-slate-700"
                checked={formData.is_active} 
                onChange={e => setFormData({...formData, is_active: e.target.checked})} 
              />
              <span className="text-sm font-medium text-slate-300 select-none cursor-pointer">是否啟用此案場 (停用將不出現在選單)</span>
            </label>
          </div>
        )}

        {/* Tab 2: 聯絡資料 */}
        {activeTab === 2 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 animate-in fade-in duration-300">
            <InputField label="聯絡人" field="contact_name" />
            <InputField label="聯絡方式" field="contact_phone" />
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-300">負責人 (Manager)</span>
              <select 
                className="bg-slate-900 border border-slate-700 rounded p-2.5 focus:border-emerald-500 outline-none text-slate-100 transition-colors cursor-pointer appearance-none w-full"
                value={formData.manager} 
                onChange={e => setFormData({...formData, manager: e.target.value})}
              >
                <option value="">(無)</option>
                {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
              </select>
            </label>
            <InputField label="屋主 / 場地所有人" field="owner_name" />
            <InputField label="屋主電話" field="owner_phone" />
            <InputField label="資料來源" field="data_source" />
          </div>
        )}

        {/* Tab 3: 保固 / 維運 */}
        {activeTab === 3 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 animate-in fade-in duration-300">
            <InputField label="保固狀態" field="warranty_status" />
            <InputField label="完工日" field="completion_date" type="date" />
            <InputField label="工程保固年" field="warranty_years" type="number" />
            <InputField label="保固終止日" field="warranty_end_date" type="date" />
            <InputField label="維保合約有無" field="has_maintenance_contract" />
            <InputField label="監控系統" field="monitoring_system" />
            
            <div className="md:col-span-2 lg:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-5 pt-2 border-t border-slate-700/50 mt-2">
              <InputField label="維保起始日" field="maintenance_start_date" type="date" />
              <InputField label="維保終止日" field="maintenance_end_date" type="date" />
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-semibold text-slate-300">維保說明</span>
                <textarea 
                  className="bg-slate-900 border border-slate-700 rounded p-2.5 focus:border-emerald-500 outline-none min-h-[100px] text-slate-100 transition-colors w-full"
                  value={formData.maintenance_notes} 
                  onChange={e => setFormData({...formData, maintenance_notes: e.target.value})} 
                />
              </label>
            </div>
          </div>
        )}

        {/* Tab 4: 設備 / 備註 */}
        {activeTab === 4 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 animate-in fade-in duration-300">
            <InputField label="建置形式 / 案件型式" field="project_type" />
            <InputField label="模組固定方式" field="module_mounting_type" />
            <div className="hidden lg:block"></div> {/* Spacer */}
            
            <InputField label="逆變器廠牌" field="inverter_brand" />
            <InputField label="逆變器保固" field="inverter_warranty" />
            <div className="hidden lg:block"></div> {/* Spacer */}

            <label className="flex flex-col gap-1 md:col-span-2 lg:col-span-3">
              <span className="text-sm font-semibold text-slate-300">備註 (Notes)</span>
              <textarea 
                className="bg-slate-900 border border-slate-700 rounded p-2.5 focus:border-emerald-500 outline-none min-h-[100px] text-slate-100 transition-colors w-full"
                value={formData.notes} 
                onChange={e => setFormData({...formData, notes: e.target.value})} 
              />
            </label>

            <div className="md:col-span-2 lg:col-span-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 pt-4 border-t border-slate-700/50 mt-2 opacity-70">
              <div className="lg:col-span-4 text-emerald-500/80 font-medium text-sm">巡檢提醒設定 (預留功能)</div>
              <InputField label="上次巡檢日期" field="last_inspection_date" type="date" />
              <InputField label="巡檢週期 (月)" field="inspection_cycle_months" type="number" />
              <InputField label="下次巡檢日期" field="next_inspection_date" type="date" />
              <InputField label="提醒天數" field="inspection_reminder_days" type="number" />
            </div>
          </div>
        )}

      </div>

      {/* Footer / Actions */}
      <div className="flex justify-end gap-4 mt-6 pt-5 border-t border-slate-700 shrink-0">
        <button type="button" onClick={onCancel} disabled={isSubmitting} className="px-4 py-2 rounded text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          取消
        </button>
        <button type="submit" disabled={isSubmitting || isViewer} className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50 shadow-lg shadow-emerald-500/20">
          {isSubmitting ? '儲存中...' : (isViewer ? '檢視權限' : '儲存變更')}
        </button>
      </div>
    </form>
  );
}
