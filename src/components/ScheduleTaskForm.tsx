"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ScheduleTask, Project, User, TaskStatus } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { getProjectLocationLabel, getProjectSearchScore } from '@/lib/project-location';
import { useUser } from './UserContext';
import { addHours, format, parse } from 'date-fns';
import { useScheduleTaskTypes } from '@/hooks/useScheduleTaskTypes';

const PRIMARY_TIME_HOURS = [
  '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18',
];
const OTHER_TIME_HOURS = [
  '19', '20', '21', '22', '23', '00', '01', '02', '03', '04', '05', '06',
];
const TIME_HOURS = [...PRIMARY_TIME_HOURS, ...OTHER_TIME_HOURS];
const TIME_MINUTES = ['00', '30'];
const OTHER_HOUR_VALUE = '__OTHER__';

interface ScheduleTaskFormProps {
  initialData?: Partial<ScheduleTask>;
  initialMemberIds?: string[];
  onSubmit: (data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>, memberIds: string[]) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function ScheduleTaskForm({ initialData, initialMemberIds, onSubmit, onCancel, isSubmitting }: ScheduleTaskFormProps) {
  const { currentUser } = useUser();
  const isViewer = currentUser?.role === 'VIEWER';
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  
  let initialStatus = initialData?.status || '';
  if (['未開始', '進行中', '取消'].includes(initialStatus)) initialStatus = '';
  else if (initialStatus === '已完成') initialStatus = '完成';

  const [formData, setFormData] = useState<Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>>({
    task_type: initialData?.task_type || '',
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
  const isEditingExistingTask = Boolean(initialData?.id);
  const {
    activeTaskTypes,
    defaultTaskType,
    error: taskTypesError,
    isLoading: taskTypesLoading,
    shouldShowLegacyValue,
  } = useScheduleTaskTypes({
    currentValue: formData.task_type,
    preserveCurrentValue: isEditingExistingTask,
  });
  
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

      let currentAssignee = activeUsers.find(u => u.id === initialData?.main_assignee_id);
      
      setFormData(prev => {
        let assigneeId = prev.main_assignee_id;
        if (initialData?.id) {
           // Editing: if the current assignee is not engineering, clear it
           if (currentAssignee && currentAssignee.category !== 'ENGINEERING') {
             assigneeId = '';
           }
        }
        return { ...prev, main_assignee_id: assigneeId };
      });
    });
  }, [initialData?.project_id, initialData?.project_name, initialData?.id, initialData?.main_assignee_id]);

  useEffect(() => {
    setMemberIds(initialMemberIds || []);
  }, [initialData?.id, initialMemberIds]);

  useEffect(() => {
    if (taskTypesLoading || isEditingExistingTask) return;
    const currentIsActive = activeTaskTypes.some(taskType => taskType.name === formData.task_type);
    if (!currentIsActive && defaultTaskType) {
      setFormData(prev => ({ ...prev, task_type: defaultTaskType }));
    }
  }, [activeTaskTypes, defaultTaskType, formData.task_type, isEditingExistingTask, taskTypesLoading]);

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
    setFormData(prev => {
      if (!val) return { ...prev, start_time: null, end_time: null };
      
      const parsedTime = parse(val, 'HH:mm', new Date());
      const suggestedEndTime = format(addHours(parsedTime, 2), 'HH:mm');
      const endTime = suggestedEndTime > val
        ? suggestedEndTime
        : (prev.end_time && prev.end_time > val ? prev.end_time : null);

      if (prev.end_time && prev.end_time > val && prev.end_time !== prev.start_time) {
        return { ...prev, start_time: val, is_all_day: false };
      }

      return { ...prev, start_time: val, end_time: endTime, is_all_day: false };
    });
  };

  const splitTime = (time: string | null) => {
    const [hour = '', minute = ''] = (time || '').split(':');
    return { hour, minute };
  };

  const buildTimeValue = (hour: string, minute: string) => {
    if (!hour && !minute) return null;
    return `${hour || '00'}:${minute || '00'}`;
  };

  const handleTimePartChange = (
    field: 'start_time' | 'end_time',
    part: 'hour' | 'minute',
    value: string,
  ) => {
    const current = splitTime(formData[field]);
    const nextTime = buildTimeValue(
      part === 'hour' ? value : current.hour,
      part === 'minute' ? value : current.minute,
    );

    if (field === 'start_time') {
      handleStartTimeChange(nextTime || '');
      return;
    }

    setFormData(prev => ({ ...prev, end_time: nextTime }));
  };

  const handleHourPresetChange = (field: 'start_time' | 'end_time', value: string) => {
    if (value === OTHER_HOUR_VALUE) {
      const currentHour = splitTime(formData[field]).hour;
      handleTimePartChange(
        field,
        'hour',
        OTHER_TIME_HOURS.includes(currentHour) ? currentHour : OTHER_TIME_HOURS[0],
      );
      return;
    }

    handleTimePartChange(field, 'hour', value);
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
    
    const scored = projects.map(p => {
      return {
        project: p,
        score: getProjectSearchScore(p, projectNameInput, [p.notes]),
      };
    }).filter(item => item.score > 0);

    return scored.sort((a, b) => b.score - a.score).map(item => item.project).slice(0, 50);
  }, [projects, projectNameInput]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!formData.task_date) return setErrorMsg('任務日期為必填');
    if (!formData.main_assignee_id) return setErrorMsg('請選擇主要負責人');
    if (!formData.project_name?.trim()) return setErrorMsg('案場為必填');
    
    // Auto format check
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (formData.start_time) {
      if (!timeRegex.test(formData.start_time)) {
        return setErrorMsg('開始時間格式不正確，必須為合法時間 (00:00-23:59)');
      }
    }
    if (formData.end_time) {
      if (!timeRegex.test(formData.end_time)) {
        return setErrorMsg('結束時間格式不正確，必須為合法時間 (00:00-23:59)');
      }
    }
    if (formData.start_time && formData.end_time) {
      if (formData.start_time >= formData.end_time) {
        return setErrorMsg('結束時間必須晚於開始時間 (目前系統不支援跨日排程)');
      }
    }

    await onSubmit(formData as any, memberIds);
  };

  const mainAssigneeUsers = users.filter(u => u.category === 'ENGINEERING');
  const coworkerUsers = users;
  const startTimeParts = splitTime(formData.start_time);
  const endTimeParts = splitTime(formData.end_time);
  const timeSelectClassName = "bg-[var(--input-bg)] text-[var(--input-text)] border border-[var(--input-border)] rounded p-1.5 focus:border-[var(--accent)] outline-none font-mono text-center";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-[var(--modal-text)]">
      {/* 標題與暫定 */}
      <div className="flex justify-between items-center mb-1 pb-2 border-b border-[var(--border)]">
        <h2 className="text-lg font-bold text-[var(--modal-text)]">{initialData?.id ? '編輯任務' : '新增任務'}</h2>
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
          <span className="font-semibold text-[var(--modal-text)]">案場 (可快選既有案場或手動輸入新案場) *</span>
          <input 
            type="text"
            className="bg-[var(--input-bg)] text-[var(--input-text)] border border-[var(--input-border)] rounded p-1.5 focus:border-[var(--accent)] outline-none w-full placeholder:text-[var(--input-placeholder)]"
            placeholder="請輸入或選擇案場名稱..."
            value={projectNameInput}
            onChange={e => handleProjectSearch(e.target.value)}
            onFocus={() => setIsDropdownOpen(true)}
            onClick={() => setIsDropdownOpen(true)}
          />
          {isDropdownOpen && projectNameInput.trim() !== '' && filteredProjects.length === 0 && (
            <div className="absolute top-[100%] left-0 z-[100] w-full mt-1 bg-[var(--modal-bg)] border border-[var(--border)] rounded-md shadow-2xl p-2 text-sm text-[var(--modal-muted)]">
              找不到既有案場，將直接使用「<span className="text-[var(--accent)] font-bold">{projectNameInput}</span>」作為案場名稱。
            </div>
          )}
          {isDropdownOpen && filteredProjects.length > 0 && (
            <div className="absolute top-[100%] left-0 z-[100] w-full mt-1 max-h-64 overflow-y-auto bg-[var(--modal-bg)] border border-[var(--border)] rounded-md shadow-2xl custom-scrollbar">
              {filteredProjects.map(p => {
                const code = p.project_code || '無代碼';
                const cap = p.capacity ? `${p.capacity} kW` : '- kW';
                const location = getProjectLocationLabel(p) || p.address || '無區域';
                return (
                  <div 
                    key={p.id}
                    className="p-2.5 border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface-secondary)] cursor-pointer transition-colors"
                    onClick={() => selectProject(p)}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 text-sm">
                      <span className="font-medium text-[var(--accent)] whitespace-nowrap">{p.name}</span>
                      <span className="hidden sm:inline text-[var(--text-muted)]">｜</span>
                      <div className="flex items-center gap-2 text-[var(--modal-text)] text-xs sm:text-sm truncate">
                        <span className="whitespace-nowrap text-sky-300/80" title={p.address || ''}>{location}</span>
                        <span className="text-[var(--text-muted)]">｜</span>
                        <span className="whitespace-nowrap">{code}</span>
                        <span className="text-[var(--text-muted)]">｜</span>
                        <span className="whitespace-nowrap text-amber-400/80">{cap}</span>
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
          <span className="font-semibold text-[var(--modal-text)]">任務類型 *</span>
          <select 
            required
            disabled={taskTypesLoading || Boolean(taskTypesError)}
            className="bg-[var(--input-bg)] text-[var(--input-text)] border border-[var(--input-border)] rounded p-1.5 focus:border-[var(--accent)] outline-none"
            value={formData.task_type} onChange={e => setFormData({...formData, task_type: e.target.value})} 
          >
            {taskTypesLoading && <option value="">載入中...</option>}
            {taskTypesError && <option value="">{taskTypesError}</option>}
            {shouldShowLegacyValue && (
              <option value={formData.task_type}>{formData.task_type}（已停用）</option>
            )}
            {activeTaskTypes.map(taskType => (
              <option key={taskType.id} value={taskType.name}>{taskType.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-[var(--modal-text)]">任務備註</span>
          <input 
            type="text" 
            className="bg-[var(--input-bg)] text-[var(--input-text)] border border-[var(--input-border)] rounded p-1.5 focus:border-[var(--accent)] outline-none"
            value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} 
          />
        </label>

        {/* 第三列：任務日期 + 全天任務 */}
        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-[var(--modal-text)]">任務日期 *</span>
          <input 
            type="date" required 
            className="bg-[var(--input-bg)] text-[var(--input-text)] border border-[var(--input-border)] rounded p-1.5 focus:border-[var(--accent)] outline-none"
            value={formData.task_date} onChange={e => setFormData({...formData, task_date: e.target.value})} 
          />
        </label>

        <div className="flex items-center pt-5 mt-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="checkbox" 
              className="w-4 h-4 accent-[var(--accent)] cursor-pointer rounded border-[var(--input-border)]"
              checked={formData.is_all_day} 
              onChange={e => setFormData(prev => ({
                ...prev, is_all_day: e.target.checked, start_time: e.target.checked ? null : prev.start_time, end_time: e.target.checked ? null : prev.end_time
              }))} 
            />
            <span className="font-semibold text-[var(--modal-text)]">全天任務</span>
          </label>
        </div>

        {/* 第四列：開始時間 + 結束時間 */}
        {!formData.is_all_day && (
          <>
            <label className="flex flex-col gap-1 mt-1">
              <span className="font-semibold text-[var(--modal-text)]">開始時間</span>
              <div className="flex items-center gap-1 max-w-[240px]">
                <select
                  className={`${timeSelectClassName} w-[70px]`}
                  value={PRIMARY_TIME_HOURS.includes(startTimeParts.hour) ? startTimeParts.hour : startTimeParts.hour ? OTHER_HOUR_VALUE : ''}
                  onChange={e => handleHourPresetChange('start_time', e.target.value)}
                >
                  <option value="">時</option>
                  {PRIMARY_TIME_HOURS.map(hour => <option key={hour} value={hour}>{hour}</option>)}
                  <option value={OTHER_HOUR_VALUE}>其他</option>
                </select>
                {OTHER_TIME_HOURS.includes(startTimeParts.hour) && (
                  <select
                    className={`${timeSelectClassName} w-[70px]`}
                    value={startTimeParts.hour}
                    onChange={e => handleTimePartChange('start_time', 'hour', e.target.value)}
                  >
                    {OTHER_TIME_HOURS.map(hour => <option key={hour} value={hour}>{hour}</option>)}
                  </select>
                )}
                <span className="text-[var(--modal-muted)] font-mono">:</span>
                <select
                  className={`${timeSelectClassName} w-[70px]`}
                  value={TIME_MINUTES.includes(startTimeParts.minute) ? startTimeParts.minute : ''}
                  onChange={e => handleTimePartChange('start_time', 'minute', e.target.value)}
                >
                  <option value="">分</option>
                  {TIME_MINUTES.map(minute => <option key={minute} value={minute}>{minute}</option>)}
                </select>
              </div>
            </label>
            <label className="flex flex-col gap-1 mt-1">
              <span className="font-semibold text-[var(--modal-text)]">結束時間</span>
              <div className="flex items-center gap-1 max-w-[240px]">
                <select
                  className={`${timeSelectClassName} w-[70px]`}
                  value={PRIMARY_TIME_HOURS.includes(endTimeParts.hour) ? endTimeParts.hour : endTimeParts.hour ? OTHER_HOUR_VALUE : ''}
                  onChange={e => handleHourPresetChange('end_time', e.target.value)}
                >
                  <option value="">時</option>
                  {PRIMARY_TIME_HOURS.map(hour => <option key={hour} value={hour}>{hour}</option>)}
                  <option value={OTHER_HOUR_VALUE}>其他</option>
                </select>
                {OTHER_TIME_HOURS.includes(endTimeParts.hour) && (
                  <select
                    className={`${timeSelectClassName} w-[70px]`}
                    value={endTimeParts.hour}
                    onChange={e => handleTimePartChange('end_time', 'hour', e.target.value)}
                  >
                    {OTHER_TIME_HOURS.map(hour => <option key={hour} value={hour}>{hour}</option>)}
                  </select>
                )}
                <span className="text-[var(--modal-muted)] font-mono">:</span>
                <select
                  className={`${timeSelectClassName} w-[70px]`}
                  value={TIME_MINUTES.includes(endTimeParts.minute) ? endTimeParts.minute : ''}
                  onChange={e => handleTimePartChange('end_time', 'minute', e.target.value)}
                >
                  <option value="">分</option>
                  {TIME_MINUTES.map(minute => <option key={minute} value={minute}>{minute}</option>)}
                </select>
              </div>
            </label>
          </>
        )}
        {formData.is_all_day && <div className="md:col-span-2"></div>}

        {/* 第五列：主要負責人 + 任務狀態 */}
        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-[var(--modal-text)]">主要負責人 *</span>
          <select 
            required
            className="bg-[var(--input-bg)] text-[var(--input-text)] border border-[var(--input-border)] rounded p-1.5 focus:border-[var(--accent)] outline-none cursor-pointer appearance-none"
            value={formData.main_assignee_id || ''} onChange={e => setFormData({...formData, main_assignee_id: e.target.value})} 
          >
            <option value="">請選擇</option>
            {mainAssigneeUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 mt-1">
          <span className="font-semibold text-[var(--modal-text)]">任務狀態</span>
          <div className="flex bg-[var(--input-bg)] border border-[var(--input-border)] rounded overflow-hidden">
            {[
              { val: '', label: '空白' },
              { val: '改期', label: '改期' },
              { val: '完成', label: '完成' }
            ].map(st => (
              <label key={st.val} className={`flex-1 text-center py-1.5 cursor-pointer transition-colors border-r last:border-r-0 border-[var(--input-border)] ${formData.status === st.val ? 'bg-[var(--accent)] text-[var(--accent-text)] font-bold' : 'text-[var(--modal-muted)] hover:bg-[var(--surface-secondary)]'}`}>
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
          <span className="font-semibold text-[var(--modal-text)]">協同人員</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2 bg-[var(--input-bg)] p-2 rounded border border-[var(--input-border)]">
            {coworkerUsers.map(u => (
              <label key={u.id} className="flex items-center gap-1.5 cursor-pointer">
                <input 
                  type="checkbox" 
                  className="w-3.5 h-3.5 accent-[var(--accent)] cursor-pointer rounded border-[var(--input-border)]"
                  checked={memberIds.includes(u.id)}
                  onChange={e => {
                    if (e.target.checked) setMemberIds(prev => [...prev, u.id]);
                    else setMemberIds(prev => prev.filter(id => id !== u.id));
                  }} 
                />
                <span className="text-[var(--input-text)]">{u.name}</span>
              </label>
            ))}
            {coworkerUsers.length === 0 && <span className="text-[var(--modal-muted)] text-xs">無可選人員</span>}
          </div>
        </div>

      </div>

      <div className="flex justify-between items-center mt-3 pt-3 border-t border-[var(--border)]">
        <div className="text-[var(--danger)] text-sm font-semibold">{errorMsg || ''}</div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={isSubmitting} className="px-4 py-1.5 rounded text-sm text-[var(--modal-text)] hover:bg-[var(--surface-secondary)] disabled:opacity-50 transition-colors">
            取消 (Esc)
          </button>
          <button type="submit" disabled={isSubmitting || isViewer} className="px-5 py-1.5 rounded text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-text)] font-semibold disabled:opacity-50 shadow-lg transition-all">
            {isSubmitting ? '儲存中...' : (isViewer ? '檢視權限' : '儲存')}
          </button>
        </div>
      </div>
    </form>
  );
}
