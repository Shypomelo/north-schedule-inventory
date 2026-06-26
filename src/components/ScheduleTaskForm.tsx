"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ScheduleTask, Project, User, TaskStatus } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { useUser } from './UserContext';
import { addHours, format, parse } from 'date-fns';

interface ScheduleTaskFormProps {
  initialData?: Partial<ScheduleTask>;
  initialMemberIds?: string[];
  onSubmit: (data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>, memberIds: string[]) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function ScheduleTaskForm({ initialData, initialMemberIds, onSubmit, onCancel, isSubmitting }: ScheduleTaskFormProps) {
  const { currentUser } = useUser();
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  
  let initialStatus = initialData?.status || '';
  if (['未開始', '進行中', '取消'].includes(initialStatus)) initialStatus = '';
  else if (initialStatus === '已完成') initialStatus = '完成';

  const [formData, setFormData] = useState<Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>>({
    task_type: initialData?.task_type || '維修',
    title: initialData?.title || '',
    project_id: initialData?.project_id || null,
    project_name: initialData?.project_name || '',
    address: initialData?.address || null,
    task_date: initialData?.task_date || format(new Date(), 'yyyy-MM-dd'),
    start_time: initialData?.start_time || null,
    end_time: initialData?.end_time || null,
    is_all_day: initialData?.is_all_day || false,
    is_tentative: initialData?.is_tentative || false,
    status: initialStatus as TaskStatus,
    main_assignee_id: initialData?.main_assignee_id || null,
    description: initialData?.description || null,
    google_calendar_id: initialData?.google_calendar_id || null,
    google_event_id: initialData?.google_event_id || null,
    google_sync_status: initialData?.google_sync_status || 'pending',
    google_sync_error: initialData?.google_sync_error || null,
    last_synced_at: initialData?.last_synced_at || null,
    created_by: initialData?.created_by || currentUser?.id || null,
    source_todo_id: initialData?.source_todo_id || null,
  });

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>(initialMemberIds || []);
  const [projectNameInput, setProjectNameInput] = useState(initialData?.project_name || '');
  
  // Custom dropdown state
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([dbAdapter.getProjects(), dbAdapter.getUsers()]).then(([pData, uData]) => {
      setProjects(pData.filter(p => p.is_active));
      const activeUsers = uData.filter(u => u.is_active);
      setUsers(activeUsers);
      
      if (initialData?.project_id && !initialData?.project_name) {
        const p = pData.find(x => x.id === initialData.project_id);
        if (p) {
          setProjectNameInput(p.name);
          setFormData(prev => ({ ...prev, project_name: p.name }));
        }
      }

      // Initialize main_assignee_id properly
      const yuzu = activeUsers.find(u => u.name === '柚子');
      const allowedMainNames = ['柚子', '維揚', '育丞'];
      let currentAssignee = activeUsers.find(u => u.id === initialData?.main_assignee_id);
      
      setFormData(prev => {
        let assigneeId = prev.main_assignee_id;
        if (!initialData?.id) {
           // New task default to Yuzu
           assigneeId = yuzu ? yuzu.id : null;
        } else {
           // Editing: if the current assignee is not in the allowed list (e.g. Admin User), clear it
           if (currentAssignee && !allowedMainNames.includes(currentAssignee.name)) {
             assigneeId = '';
           }
        }
        return { ...prev, main_assignee_id: assigneeId };
      });
    });
  }, [initialData?.project_id, initialData?.project_name, initialData?.id, initialData?.main_assignee_id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isDropdownOpen) setIsDropdownOpen(false);
        else onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, isDropdownOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleStartTimeChange = (val: string) => {
    // Basic auto-colon insertion
    let formatted = val.replace(/[^\d:]/g, '');
    if (formatted.length === 2 && !formatted.includes(':') && val.length > (formData.start_time?.length || 0)) {
      formatted += ':';
    }
    
    setFormData(prev => {
      if (!formatted) return { ...prev, start_time: null, end_time: null };
      
      if (formatted.length === 5) {
        try {
          const parsedTime = parse(formatted, 'HH:mm', new Date());
          const newEndTime = format(addHours(parsedTime, 2), 'HH:mm');
          return { ...prev, start_time: formatted, end_time: newEndTime, is_all_day: false };
        } catch (e) {
          // ignore parsing error
        }
      }
      return { ...prev, start_time: formatted };
    });
  };

  const handleProjectSearch = (val: string) => {
    setProjectNameInput(val);
    setIsDropdownOpen(true);
    // When manually typing, update project_name but clear project_id because it's not a verified selection yet.
    setFormData(prev => ({ ...prev, project_name: val, project_id: null, address: null }));
  };

  const selectProject = (p: Project) => {
    setProjectNameInput(p.name);
    setFormData(prev => ({ ...prev, project_name: p.name, project_id: p.id, address: p.address }));
    setIsDropdownOpen(false);
  };

  const filteredProjects = useMemo(() => {
    if (!projectNameInput.trim()) return projects.slice(0, 50); // Show max 50 default
    
    const term = projectNameInput.toLowerCase();
    
    const scored = projects.map(p => {
      let score = 0;
      if (p.name?.toLowerCase().includes(term)) score += 100;
      if (p.short_name?.toLowerCase().includes(term)) score += 80;
      const code = (p as any).project_code || (p as any).code;
      if (code?.toLowerCase().includes(term)) score += 60;
      if (p.address?.toLowerCase().includes(term) || p.region?.toLowerCase().includes(term)) score += 40;
      if (p.notes?.toLowerCase().includes(term)) score += 20;

      return { project: p, score };
    }).filter(item => item.score > 0);

    return scored.sort((a, b) => b.score - a.score).map(item => item.project).slice(0, 50);
  }, [projects, projectNameInput]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!formData.task_date) return setErrorMsg('任務日期為必填');
    if (!formData.main_assignee_id) return setErrorMsg('主要負責人為必填');
    if (!formData.project_name?.trim()) return setErrorMsg('案場為必填');
    
    // Auto format check
    if (formData.start_time && formData.start_time.length !== 5) {
      return setErrorMsg('開始時間格式不正確，請輸入如 09:00');
    }
    if (formData.end_time && formData.end_time.length !== 5) {
      return setErrorMsg('結束時間格式不正確，請輸入如 11:00');
    }

    await onSubmit(formData as any, memberIds);
  };

  const mainAssigneeUsers = users.filter(u => ['柚子', '維揚', '育丞'].includes(u.name));
  const coworkerUsers = users.filter(u => ['柚子', '維揚', '育丞', '慈芸', '志偉'].includes(u.name));

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {/* 標題與暫定 */}
      <div className="flex justify-between items-center mb-1 pb-2 border-b border-slate-700">
        <h2 className="text-lg font-bold text-slate-100">{initialData?.id ? '編輯任務' : '新增任務'}</h2>
        <label className="flex items-center gap-2 cursor-pointer">
          <input 
            type="checkbox" 
            className="w-4 h-4 accent-amber-500 cursor-pointer"
            checked={formData.is_tentative} onChange={e => setFormData({...formData, is_tentative: e.target.checked})} 
          />
          <span className="text-sm font-semibold text-amber-400">暫定任務</span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        
        {/* 第一列：案場 */}
        <div className="flex flex-col gap-1 md:col-span-2 relative" ref={wrapperRef}>
          <span className="font-semibold text-slate-300">案場 (可快選既有案場或手動輸入新案場) *</span>
          <input 
            type="text"
            className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none w-full placeholder:text-slate-500"
            placeholder="請輸入或選擇案場名稱..."
            value={projectNameInput}
            onChange={e => handleProjectSearch(e.target.value)}
            onFocus={() => setIsDropdownOpen(true)}
            onClick={() => setIsDropdownOpen(true)}
          />
          {isDropdownOpen && projectNameInput.trim() !== '' && filteredProjects.length === 0 && (
            <div className="absolute top-[100%] left-0 z-[100] w-full mt-1 bg-slate-800 border border-slate-600 rounded-md shadow-2xl p-2 text-sm text-slate-400">
              找不到既有案場，將直接使用「<span className="text-emerald-400 font-bold">{projectNameInput}</span>」作為案場名稱。
            </div>
          )}
          {isDropdownOpen && filteredProjects.length > 0 && (
            <div className="absolute top-[100%] left-0 z-[100] w-full mt-1 max-h-64 overflow-y-auto bg-slate-800 border border-slate-600 rounded-md shadow-2xl custom-scrollbar">
              {filteredProjects.map(p => {
                const code = (p as any).project_code || (p as any).code || '無代碼';
                const cap = p.capacity ? `${p.capacity} kW` : '- kW';
                return (
                  <div 
                    key={p.id}
                    className="p-2.5 border-b border-slate-700/50 last:border-b-0 hover:bg-slate-700 cursor-pointer transition-colors"
                    onClick={() => selectProject(p)}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 text-sm">
                      <span className="font-medium text-emerald-400 whitespace-nowrap">{p.name}</span>
                      <span className="hidden sm:inline text-slate-500">｜</span>
                      <div className="flex items-center gap-2 text-slate-300 text-xs sm:text-sm truncate">
                        <span className="whitespace-nowrap">{code}</span>
                        <span className="text-slate-500">｜</span>
                        <span className="whitespace-nowrap text-amber-400/80">{cap}</span>
                        <span className="text-slate-500">｜</span>
                        <span className="truncate flex-1 text-slate-400" title={p.address || ''}>{p.address || '無地址'}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 第二列：任務類型 + 任務標題 */}
        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-slate-300">任務類型 *</span>
          <select 
            required
            className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none"
            value={formData.task_type} onChange={e => setFormData({...formData, task_type: e.target.value})} 
          >
            {['現勘', '維修', '施工', '掛表', '送電', '清洗', '電檢', '確認', '內部', '其他'].map(t => (
               <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-slate-300">任務備註</span>
          <input 
            type="text" 
            className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none"
            value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} 
          />
        </label>

        {/* 第三列：任務日期 + 全天任務 */}
        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-slate-300">任務日期 *</span>
          <input 
            type="date" required 
            className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none"
            value={formData.task_date} onChange={e => setFormData({...formData, task_date: e.target.value})} 
          />
        </label>

        <div className="flex items-center pt-5 mt-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="checkbox" 
              className="w-4 h-4 accent-emerald-500 cursor-pointer rounded border-slate-700"
              checked={formData.is_all_day} 
              onChange={e => setFormData(prev => ({
                ...prev, is_all_day: e.target.checked, start_time: e.target.checked ? null : prev.start_time, end_time: e.target.checked ? null : prev.end_time
              }))} 
            />
            <span className="font-semibold text-slate-300">全天任務</span>
          </label>
        </div>

        {/* 第四列：開始時間 + 結束時間 */}
        {!formData.is_all_day && (
          <>
            <label className="flex flex-col gap-1 mt-1">
              <span className="font-semibold text-slate-300">開始時間</span>
              <input 
                type="text" 
                maxLength={5}
                placeholder="09:00"
                className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none placeholder:text-slate-600 font-mono tracking-widest text-center max-w-[120px]"
                value={formData.start_time || ''} onChange={e => handleStartTimeChange(e.target.value)} 
              />
            </label>
            <label className="flex flex-col gap-1 mt-1">
              <span className="font-semibold text-slate-300">結束時間</span>
              <input 
                type="text" 
                maxLength={5}
                placeholder="11:00"
                className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none placeholder:text-slate-600 font-mono tracking-widest text-center max-w-[120px]"
                value={formData.end_time || ''} onChange={e => {
                  let v = e.target.value.replace(/[^\d:]/g, '');
                  if (v.length === 2 && !v.includes(':') && v.length > (formData.end_time?.length || 0)) v += ':';
                  setFormData({...formData, end_time: v || null});
                }} 
              />
            </label>
          </>
        )}
        {formData.is_all_day && <div className="md:col-span-2"></div>}

        {/* 第五列：主要負責人 + 任務狀態 */}
        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-slate-300">主要負責人 *</span>
          <select 
            required
            className="bg-slate-900 border border-slate-700 rounded p-1.5 focus:border-emerald-500 outline-none cursor-pointer appearance-none"
            value={formData.main_assignee_id || ''} onChange={e => setFormData({...formData, main_assignee_id: e.target.value})} 
          >
            <option value="">(請選擇)</option>
            {mainAssigneeUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-slate-300">任務狀態</span>
          <div className="flex bg-slate-900 border border-slate-700 rounded overflow-hidden">
            {[
              { val: '', label: '空白' },
              { val: '改期', label: '改期' },
              { val: '完成', label: '完成' }
            ].map(st => (
              <label key={st.val} className={`flex-1 text-center py-1.5 cursor-pointer transition-colors border-r last:border-r-0 border-slate-700 ${formData.status === st.val ? 'bg-indigo-600 text-white font-bold' : 'text-slate-400 hover:bg-slate-800'}`}>
                <input 
                  type="radio" name="taskStatus" className="hidden"
                  checked={formData.status === st.val} onChange={() => setFormData({...formData, status: st.val as TaskStatus})}
                />
                {st.label}
              </label>
            ))}
          </div>
        </label>

        {/* 第六列：協同人員 (橫向勾選) */}
        <div className="flex flex-col gap-1 md:col-span-2 mt-2">
          <span className="font-semibold text-slate-300">協同人員</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2 bg-slate-900/50 p-2 rounded border border-slate-700">
            {coworkerUsers.map(u => (
              <label key={u.id} className="flex items-center gap-1.5 cursor-pointer">
                <input 
                  type="checkbox" 
                  className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer rounded border-slate-700"
                  checked={memberIds.includes(u.id)}
                  onChange={e => {
                    if (e.target.checked) setMemberIds(prev => [...prev, u.id]);
                    else setMemberIds(prev => prev.filter(id => id !== u.id));
                  }} 
                />
                <span className="text-slate-200">{u.name}</span>
              </label>
            ))}
            {coworkerUsers.length === 0 && <span className="text-slate-500 text-xs">無可選人員</span>}
          </div>
        </div>

      </div>

      <div className="flex justify-between items-center mt-3 pt-3 border-t border-slate-700">
        <div className="text-red-400 text-sm font-semibold">{errorMsg || ''}</div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={isSubmitting} className="px-4 py-1.5 rounded text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50 transition-colors">
            取消 (Esc)
          </button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50 shadow-lg shadow-emerald-500/20 transition-all">
            {isSubmitting ? '儲存中...' : '儲存'}
          </button>
        </div>
      </div>
    </form>
  );
}
