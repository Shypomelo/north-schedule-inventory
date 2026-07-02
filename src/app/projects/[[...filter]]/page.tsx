"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Project, User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { ProjectForm } from '@/components/ProjectForm';
import { ProjectDetailModal } from '@/components/ProjectDetailModal';
import { GanttChart } from '@/components/GanttChart';
import { parseDateField } from '@/lib/utils/date-utils';
import { SmartDateInput } from '@/components/SmartDateInput';
import { DateDualInput } from '@/components/DateDualInput';
import { useUser } from '@/components/UserContext';
import { MapPin, Plus, Search, Filter, Maximize2 } from 'lucide-react';
import { useParams } from 'next/navigation';

export default function ProjectsPage() {
  const params = useParams();
  const { currentUser } = useUser();
  const filterKey = Array.isArray(params.filter) ? params.filter[0] : params.filter || 'all';

  const [projects, setProjects] = useState<Project[]>([]);
  
  const [users, setUsers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Custom Filters
  const [filterCity, setFilterCity] = useState('');
  const [filterWarrantyStatus, setFilterWarrantyStatus] = useState('');
  const [filterInverterBrand, setFilterInverterBrand] = useState('');

  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  
  // For Active Projects
  const [isActiveFormOpen, setIsActiveFormOpen] = useState(false);
  const [viewingProject, setViewingProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<'report' | 'gantt'>('report');
  const contractors: any[] = [];
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, project: Project } | null>(null);

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'已儲存' | '儲存中' | '儲存失敗' | ''>('');

  // For debounce inline editing
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleBackup = async () => {
    try {
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(filteredProjects),
      });
      const data = await response.json();
      if (data.success) {
        alert(`備份成功！已存至：${data.filePath}`);
      } else {
        alert(`備份失敗：${data.error}`);
      }
    } catch (e) {
      console.error(e);
      alert('備份失敗，發生錯誤');
    }
  };

  const fetchProjects = async () => {
    setIsLoading(true);
    const data = await dbAdapter.getProjects();
    
    const usersData = await dbAdapter.getUsers();
    setProjects(data);
    
    setUsers(usersData.filter(u => u.is_active && u.category === 'ENGINEERING'));
    setIsLoading(false);
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const filterUser = users.find(u => u.id === filterKey);
  const isActiveView = filterKey === 'active' || !!filterUser;

  const getPageTitle = () => {
    if (filterKey === 'active') return '進行中案場';
    if (filterUser) return `${filterUser.name}案場`;
    return '所有案場';
  };

  const getCity = (address: string | null) => {
    if (!address) return null;
    const match = address.match(/(..[市縣])/);
    if (match) {
      if (match[1] === '桃園縣') return '桃園市';
      if (match[1] === '台北縣' || match[1] === '信北市') return '新北市';
      return match[1];
    }
    const taipeiDistricts = ['中正區', '大同區', '中山區', '松山區', '大安區', '萬華區', '信義區', '士林區', '北投區', '內湖區', '南港區', '文山區'];
    for (const dist of taipeiDistricts) {
      if (address.includes(dist)) return '台北市';
    }
    return '其他';
  };

  const cities = useMemo(() => {
    const allCities = projects.map(p => getCity(p.address)).filter(Boolean) as string[];
    return Array.from(new Set(allCities)).sort();
  }, [projects]);
  
  const warrantyStatuses = useMemo(() => {
    const statuses = projects.map(p => p.warranty_status?.split('(')[0].trim()).filter(Boolean) as string[];
    return Array.from(new Set(statuses)).sort();
  }, [projects]);

  const inverterBrands = useMemo(() => Array.from(new Set(projects.map(p => p.inverter_brand).filter(Boolean))) as string[], [projects]);


  const filteredBaseProjects = useMemo(() => {
    return projects.filter(p => {
      if (p.status !== '已結案' && p.status !== '作廢') return false;
      if (filterCity && getCity(p.address) !== filterCity) return false;
      if (filterWarrantyStatus && p.warranty_status?.split('(')[0].trim() !== filterWarrantyStatus) return false;
      if (filterInverterBrand && p.inverter_brand !== filterInverterBrand) return false;

      if (searchTerm) {
        const lowerTerm = searchTerm.toLowerCase();
        const matchSearch = 
          (p.name && p.name.toLowerCase().includes(lowerTerm)) || 
          (p.contact_name && p.contact_name.toLowerCase().includes(lowerTerm)) ||
          (p.contact_phone && p.contact_phone.toLowerCase().includes(lowerTerm)) ||
          (p.address && p.address.toLowerCase().includes(lowerTerm)) ||
          (p.notes && p.notes.toLowerCase().includes(lowerTerm));
        if (!matchSearch) return false;
      }
      return true;
    });
  }, [projects, searchTerm, filterCity, filterWarrantyStatus, filterInverterBrand]);

  const filteredProjects = useMemo(() => {
    return projects.filter(p => {
      if (p.status === '已結案' || p.status === '作廢') return false;
      if (filterUser && p.manager !== filterUser.name) return false;

      if (searchTerm) {
        const lowerTerm = searchTerm.toLowerCase();
        const matchSearch = 
          (p.name && p.name.toLowerCase().includes(lowerTerm)) || 
          (p.project_code && p.project_code.toLowerCase().includes(lowerTerm)) ||
          (p.notes && p.notes.toLowerCase().includes(lowerTerm));
        if (!matchSearch) return false;
      }
      return true;
    });
  }, [projects, searchTerm, filterUser]);

  const activeCategories = useMemo(() => {
    const cats = {
      section1: [] as Project[], // 目前施工中案件
      section2: [] as Project[], // 下兩周預計進場之案件
      section3: [] as Project[], // 其他負責案件
      section4: [] as Project[], // 前兩周掛表案件
    };

    filteredProjects.forEach(p => {
      const baseDateStr = p.report_base_date || new Date().toISOString().split('T')[0];
      const baseDate = new Date(baseDateStr);
      const baseTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();

      const meterDate = parseDateField(p.meter_status || "", baseDateStr);
      const bracketDate = parseDateField(p.bracket_status || "", baseDateStr);
      const powerDate = parseDateField(p.power_status || "", baseDateStr);

      const isDateBeforeOrEqualBase = (d: Date | null) => d && d.getTime() <= baseTime;
      const isDateWithin14Days = (d: Date | null) => d && d.getTime() > baseTime && d.getTime() <= baseTime + 14 * 24 * 60 * 60 * 1000;
      const hasCompletedText = (text: string | null) => text?.includes('已完工') || text?.includes('已完成');

      if (isDateBeforeOrEqualBase(meterDate)) {
        cats.section4.push(p); // 1. 掛表日期在基準日前
      } else if (
        isDateBeforeOrEqualBase(bracketDate) || 
        isDateBeforeOrEqualBase(powerDate) ||
        hasCompletedText(p.bracket_status || "") ||
        hasCompletedText(p.power_status || "")
      ) {
        cats.section1.push(p); // 2. 支架或電力在基準日前，或包含已完工/已完成
      } else if (isDateWithin14Days(bracketDate) || isDateWithin14Days(powerDate)) {
        cats.section2.push(p); // 3. 支架或電力在未來14天內
      } else {
        cats.section3.push(p); // 4. 其他
      }
    });

    return cats;
  }, [filteredProjects]);

  const handleCreateOrUpdateBase = async (data: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => {
    setIsSubmitting(true);
    try {
      if (editingProject) {
        await dbAdapter.updateProject(editingProject.id, data);
      } else {
        await dbAdapter.createProject(data);
      }
      setIsFormModalOpen(false);
      setEditingProject(null);
      await fetchProjects();
    } catch (e) {
      console.error(e);
      alert('儲存失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateActive = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    const formData = new FormData(e.currentTarget);
    try {
      const newActive = {
        project_code: formData.get('project_code') as string || '',
        name: formData.get('name') as string || '',
        short_name: formData.get('name') as string || '',
        capacity: formData.get('capacity') as string || '',
        manager: formData.get('manager') as string || '',
        bracket_status: formData.get('bracket_status') as string || '',
        power_status: formData.get('power_status') as string || '',
        inspection_status: formData.get('inspection_status') as string || '',
        meter_status: formData.get('meter_status') as string || '',
        roof_status: formData.get('roof_status') as string || '',
        start_date: formData.get('start_date') as string || '',
        notes: formData.get('notes') as string || '',
        status: '進行中',
        report_section: '其他負責案件'
      } as any;
      
      const newRecord = {
        ...newActive,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      await dbAdapter.createProject(newActive);

      setIsActiveFormOpen(false);
      await fetchProjects();
    } catch (e) {
      console.error(e);
      alert('儲存失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteProject = async (project: Project) => {
    if (!confirm(`確定要刪除案場「${project.name}」嗎？這將會把它從進行中案場永久移除。`)) {
      return;
    }
    setIsSubmitting(true);
    try {
      const adapter = dbAdapter as any;
      const dbActive = await adapter.getProjects();
      const newDbActive = dbActive.filter((p: any) => p.id !== project.id);
      if (typeof window !== 'undefined') {
        localStorage.setItem('schedule-inventory-mock-db-v6', JSON.stringify({
          ...(JSON.parse(localStorage.getItem('schedule-inventory-mock-db-v6') || '{}')),
          active_projects: newDbActive
        }));
      }
      await fetchProjects();
    } catch (e) {
      console.error(e);
      alert('刪除失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  
  const handleArchiveProject = async (project: Project) => {
    if (!confirm(`確定要作廢「${project.name}」嗎？`)) return;
    try {
      await dbAdapter.updateProject(project.id, { status: '作廢' });
      await fetchProjects();
    } catch (e) {
      alert('操作失敗');
    }
  };

  const handleCompleteProject = async (project: Project) => {
    if (!confirm(`確定要結案「${project.name}」嗎？這將會把它移出進行中案場，並更新至所有案場中。`)) {
      return;
    }
    setIsSubmitting(true);
    try {
      await dbAdapter.updateProject(project.id, {
        status: '已結案'
      });
      await fetchProjects();
    } catch (e) {
      console.error(e);
      alert('結案失敗');
    } finally {
      setIsSubmitting(false);
    }
  };


  const handleProjectDatesChange = async (id: string, updates: Partial<Project>) => {
    try {
      setSaveStatus('儲存中');
      setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates } as Project : p));
      
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await dbAdapter.updateProject(id, updates);
          setSaveStatus('已儲存');
          setTimeout(() => setSaveStatus(''), 2000);
        } catch (error) {
          console.error("Failed to update project dates", error);
          setSaveStatus('儲存失敗');
        }
      }, 1000);
    } catch (e) {
      console.error(e);
      setSaveStatus('儲存失敗');
    }
  };

  const handleProjectInlineChange = async (id: string, field: string, value: string) => {
    try {
      setSaveStatus('儲存中');
      const updatedProjects = projects.map(p => p.id === id ? { ...p, [field]: value } as Project : p);
      setProjects(updatedProjects);
      
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await dbAdapter.updateProject(id, { [field]: value });
          setSaveStatus('已儲存');
          setTimeout(() => setSaveStatus(''), 2000); // clear after 2 seconds
        } catch (error) {
          console.error("Failed to update project inline", error);
          setSaveStatus('儲存失敗');
        }
      }, 1000);
    } catch (e) {
      console.error(e);
      setSaveStatus('儲存失敗');
    }
  };

  const openGoogleMaps = (e: React.MouseEvent, address: string) => {
    e.stopPropagation();
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    window.open(url, '_blank');
  };

  const renderActiveTable = (title: string, projectsList: Project[]) => {
    const isSec1 = title === '1. 目前施工中案件';
    const isSec2 = title === '2. 下兩周預計進場之案件';
    const isSec3 = title === '3. 其他負責案件';
    const isSec4 = title === '4. 前兩周掛表案件';

    const showBracket = isSec1 || isSec2 || isSec3;
    const showPower = isSec1 || isSec2 || isSec3;
    const showInspection = isSec1 || isSec2 || isSec3;
    const showMeter = isSec1 || isSec2 || isSec3;
    const showRoof = isSec1 || isSec3;
    const showStartDate = isSec1;

    return (
      <div className="mb-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <h2 className="text-xl font-bold text-slate-200 mb-4 px-2 border-l-4 border-emerald-500">{title} <span className="text-slate-500 text-sm font-normal ml-2">({projectsList.length})</span></h2>
        <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden shadow-xl backdrop-blur-sm">
          <table className="w-full text-left border-collapse min-w-[1500px]">
            <thead className="bg-slate-900/80 text-slate-300 text-sm border-b border-slate-700/60">
                <tr>
                  <th className="p-3 font-semibold whitespace-nowrap w-[60px] text-center"></th>
                  <th className="p-3 font-semibold whitespace-nowrap min-w-[100px]">編號</th>
                  <th className="p-3 font-semibold min-w-[200px]">案場名稱</th>
                  <th className="p-3 font-semibold whitespace-nowrap w-[80px]">KW</th>
                  <th className="p-3 font-semibold whitespace-nowrap min-w-[100px]">人員</th>
                  {showBracket && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">支架</th>}
                  {showPower && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">電力</th>}
                  {showInspection && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">驗收</th>}
                  {showMeter && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">掛表</th>}
                  {showRoof && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">新設頂蓋</th>}
                  {showStartDate && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">開工日期</th>}
                  <th className="p-3 font-semibold min-w-[250px]">備註</th>
                  {isSec4 && <th className="p-3 font-semibold min-w-[80px]">操作</th>}
                </tr>
              </thead>
            <tbody className="divide-y divide-slate-700/40 text-sm">
              {projectsList.length === 0 ? (
                <tr>
                  <td colSpan={100} className="p-8 text-center text-slate-500 italic">此區塊目前無資料</td>
                </tr>
              ) : projectsList.map(project => (
                <tr 
                  key={project.id} 
                  className="hover:bg-slate-700/40 transition-colors group cursor-context-menu"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (currentUser?.role === 'VIEWER') return;
                    setContextMenu({ x: e.clientX, y: e.clientY, project });
                  }}
                >
                  <td className="p-3 text-center">
                    <button 
                      onClick={() => setViewingProject(project)}
                      className="p-1.5 rounded-md bg-slate-800 text-emerald-500 hover:bg-emerald-500 hover:text-white transition-colors"
                      title="開啟詳細資料"
                    >
                      <Maximize2 size={16} />
                    </button>
                  </td>
                  <td className="p-3 text-slate-400 select-all">{project.project_code || project.id.slice(0, 8)}</td>
                  <td className="p-3 text-emerald-400 font-medium select-all truncate max-w-[250px]" title={project.name}>{project.name}</td>
                  <td className="p-3 text-slate-300">{project.capacity || '-'}</td>
                  
                  {/* Editable Fields */}
                  <td className="p-1">
                    <select
                      disabled={currentUser?.role === 'VIEWER'}
                      value={project.manager || ''} 
                      onChange={(e) => handleProjectInlineChange(project.id, 'manager', e.target.value)}
                      className={`w-full bg-slate-900/50 px-2 py-1.5 rounded border border-slate-700/50 transition-colors outline-none text-slate-200 appearance-none ${currentUser?.role === 'VIEWER' ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-900 focus:bg-slate-900 focus:border-emerald-500/50 cursor-pointer'}`}
                    >
                      <option value="">未指定</option>
                      {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                    </select>
                  </td>
                  {showBracket && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.racking_expected_start_date || null}
                      completionDate={project.racking_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { racking_expected_start_date: exp, racking_completion_date: comp })}
                    />
                  </td>}
                  {showPower && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.electrical_expected_start_date || null}
                      completionDate={project.electrical_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { electrical_expected_start_date: exp, electrical_completion_date: comp })}
                    />
                  </td>}
                  {showInspection && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.inspection_expected_date || null}
                      completionDate={project.inspection_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { inspection_expected_date: exp, inspection_completion_date: comp })}
                    />
                  </td>}
                  {showMeter && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.meter_expected_date || null}
                      completionDate={project.meter_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { meter_expected_date: exp, meter_completion_date: comp })}
                    />
                  </td>}
                  {showRoof && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.roof_cover_expected_start_date || null}
                      completionDate={project.roof_cover_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { roof_cover_expected_start_date: exp, roof_cover_completion_date: comp })}
                    />
                  </td>}
                  {showStartDate && <td className="p-1">
                    <SmartDateInput 
                      disabled={currentUser?.role === 'VIEWER'}
                      value={project.start_date || ''}
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      onChange={(val) => handleProjectInlineChange(project.id, 'start_date', val)}
                      placeholder="YYYY-MM-DD"
                    />
                  </td>}
                  <td className="p-1">
                    <input 
                      disabled={currentUser?.role === 'VIEWER'}
                      type="text" value={project.notes || ''} 
                      onChange={(e) => handleProjectInlineChange(project.id, 'notes', e.target.value)}
                      className={`w-full bg-slate-900/50 px-2 py-1.5 rounded border border-slate-700/50 transition-colors outline-none text-slate-400 placeholder:text-slate-600 ${currentUser?.role === 'VIEWER' ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-900 focus:bg-slate-900 focus:border-emerald-500/50'}`}
                      placeholder="點擊輸入備註..."
                    />
                  </td>
                  {isSec4 && (
                    <td className="p-1 text-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCompleteProject(project); }}
                        disabled={currentUser?.role === 'VIEWER'}
                        className="bg-emerald-600/80 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-xs font-semibold shadow transition-colors w-full disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        結案
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="p-8 min-w-[1600px] mx-auto flex flex-col h-full">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-slate-100">{getPageTitle()} <span className="text-lg text-slate-500 font-normal ml-2">({isActiveView ? filteredProjects.length : filteredBaseProjects.length})</span></h1>
        
        <div className="flex items-center gap-4">
          {isActiveView && saveStatus && (
            <span className={`text-sm ${saveStatus === '已儲存' ? 'text-emerald-400' : saveStatus === '儲存失敗' ? 'text-rose-400' : 'text-slate-400'}`}>
              {saveStatus}
            </span>
          )}
          {isActiveView && (
            <button
              onClick={handleBackup}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2.5 rounded-lg shadow-lg transition transform hover:-translate-y-0.5 border border-slate-600"
            >
              建立備份
            </button>
          )}
          {isActiveView ? (
            <button 
              onClick={() => setIsActiveFormOpen(true)}
              disabled={currentUser?.role === 'VIEWER'}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-lg shadow-lg shadow-emerald-600/20 transition transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
            >
              <Plus size={20} />
              新增進行中案場
            </button>
          ) : (
            <button 
              onClick={() => { setEditingProject(null); setIsFormModalOpen(true); }}
              disabled={currentUser?.role === 'VIEWER'}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-lg shadow-lg shadow-emerald-600/20 transition transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
            >
              <Plus size={20} />
              新增所有案場
            </button>
          )}
        </div>
      </div>

      <div className="bg-slate-800/60 border border-slate-700/60 p-4 rounded-xl mb-6 flex flex-col md:flex-row gap-4 backdrop-blur-sm shrink-0">
        <div className="flex-1 flex items-center gap-3 bg-slate-900/50 rounded-lg px-3 border border-slate-700/50">
          <Search className="text-slate-400" size={20} />
          <input 
            type="text" 
            placeholder="搜尋案場名稱、代碼、備註..." 
            className="bg-transparent border-none outline-none text-slate-200 w-full placeholder:text-slate-500 py-2.5"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        
        {!isActiveView && (
          <div className="flex gap-3 overflow-x-auto">
            <div className="flex items-center gap-2 bg-slate-900/50 rounded-lg px-3 py-1 border border-slate-700/50 min-w-max">
              <Filter size={16} className="text-slate-400" />
              <select 
                className="bg-transparent text-slate-200 outline-none text-sm appearance-none py-1.5 cursor-pointer"
                value={filterCity} onChange={e => setFilterCity(e.target.value)}
              >
                <option value="">全部縣市</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 bg-slate-900/50 rounded-lg px-3 py-1 border border-slate-700/50 min-w-max">
              <Filter size={16} className="text-slate-400" />
              <select 
                className="bg-transparent text-slate-200 outline-none text-sm appearance-none py-1.5 cursor-pointer"
                value={filterWarrantyStatus} onChange={e => setFilterWarrantyStatus(e.target.value)}
              >
                <option value="">所有保固狀態</option>
                {warrantyStatuses.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 bg-slate-900/50 rounded-lg px-3 py-1 border border-slate-700/50 min-w-max">
              <Filter size={16} className="text-slate-400" />
              <select 
                className="bg-transparent text-slate-200 outline-none text-sm appearance-none py-1.5 cursor-pointer"
                value={filterInverterBrand} onChange={e => setFilterInverterBrand(e.target.value)}
              >
                <option value="">所有逆變器廠牌</option>
                {inverterBrands.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400">載入中...</div>
        ) : isActiveView ? (
          
          <div className="pb-8 flex flex-col h-full">
            <div className="flex gap-4 mb-6 border-b border-slate-700/50 pb-2 shrink-0">
              <button 
                onClick={() => setActiveTab('report')}
                className={`px-4 py-2 font-medium transition-colors border-b-2 -mb-[10px] ${activeTab === 'report' ? 'text-emerald-400 border-emerald-500' : 'text-slate-400 border-transparent hover:text-slate-300'}`}
              >
                週回報表
              </button>
              <button 
                onClick={() => setActiveTab('gantt')}
                className={`px-4 py-2 font-medium transition-colors border-b-2 -mb-[10px] ${activeTab === 'gantt' ? 'text-emerald-400 border-emerald-500' : 'text-slate-400 border-transparent hover:text-slate-300'}`}
              >
                包商排工 (甘特圖)
              </button>
            </div>

            {activeTab === 'report' ? (
              <>
                {renderActiveTable("1. 目前施工中案件", activeCategories.section1)}
                {renderActiveTable("2. 下兩周預計進場之案件", activeCategories.section2)}
                {renderActiveTable("3. 其他負責案件", activeCategories.section3)}
                {renderActiveTable("4. 前兩周掛表案件", activeCategories.section4)}
              </>
            ) : (
              <div className="flex-1 overflow-hidden min-h-[500px]">
                <GanttChart projects={filteredProjects} contractors={contractors} />
              </div>
            )}
          </div>

        ) : filteredBaseProjects.length === 0 ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 gap-2">
             <Search size={32} className="opacity-20" />
             <p>找不到相符的案場</p>
           </div>
        ) : (
          <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden shadow-xl backdrop-blur-sm">
            <table className="w-full text-left border-collapse min-w-[1400px]">
              <thead className="bg-slate-900/80 text-slate-300 text-sm sticky top-0 z-10 border-b border-slate-700/60 backdrop-blur-md">
                  <tr>
                    <th className="p-4 font-semibold whitespace-nowrap w-[100px]">狀態</th>
                    <th className="p-4 font-semibold whitespace-nowrap w-[120px]">保固狀態</th>
                    <th className="p-4 font-semibold min-w-[200px]">案場名稱</th>
                    <th className="p-4 font-semibold whitespace-nowrap w-[120px]">聯絡人</th>
                    <th className="p-4 font-semibold whitespace-nowrap w-[150px]">聯絡方式</th>
                    <th className="p-4 font-semibold min-w-[300px]">地址</th>
                    <th className="p-4 font-semibold min-w-[300px]">備註</th>
                  </tr>
                </thead>
              <tbody className="divide-y divide-slate-700/40 text-sm">
                {filteredBaseProjects.map(project => {
                  const shortWarranty = project.warranty_status ? project.warranty_status.split('(')[0].trim() : '-';
                  
                  return (
                    <tr 
                      key={project.id} 
                      className="hover:bg-slate-700/40 transition-colors cursor-pointer group"
                      onClick={() => { setEditingProject(project); setIsFormModalOpen(true); }}
                    >
                      <td className="p-4">
                        {project.status || '-'}
                      </td>
                      <td className="p-4">
                        <span className="px-2 py-1 bg-indigo-500/10 text-indigo-400 rounded-md text-xs font-medium border border-indigo-500/20 whitespace-nowrap">
                          {shortWarranty}
                        </span>
                      </td>
                      <td className="p-4 text-slate-100 font-medium group-hover:text-emerald-400 transition-colors">
                        <div className="flex items-center gap-2 truncate max-w-[250px]" title={project.name}>
                          {!project.is_active && <span className="w-2 h-2 rounded-full bg-slate-500 shrink-0" title="已停用"></span>}
                          <span className="truncate">{project.name}</span>
                        </div>
                      </td>
                      <td className="p-4 text-slate-300">{project.contact_name || '-'}</td>
                      <td className="p-4 text-slate-300">{project.contact_phone || '-'}</td>
                      <td className="p-4">
                        {project.address ? (
                          <button onClick={(e) => openGoogleMaps(e, project.address!)} className="text-slate-400 hover:text-indigo-400 flex items-start gap-1 transition-colors text-left w-full" title={project.address}>
                            <MapPin size={14} className="mt-0.5 flex-shrink-0" /> 
                            <span className="truncate">{project.address}</span>
                          </button>
                        ) : <span className="text-slate-500">-</span>}
                      </td>
                      <td className="p-4 text-slate-400">
                        <div className="truncate max-w-[300px]" title={project.notes || ''}>{project.notes || '-'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewingProject && (
        <ProjectDetailModal 
          project={viewingProject as any} 
          onClose={() => setViewingProject(null)} 
          onUpdate={async () => {
            await fetchProjects();
            const adapter = dbAdapter as any;
            const updatedProjects = await adapter.getProjects();
            const updated = updatedProjects.find((p: Project) => p.id === viewingProject.id);
            if (updated) setViewingProject(updated);
          }}
        />
      )}

      {isActiveFormOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-800 border border-slate-700/60 p-6 rounded-2xl w-full max-w-2xl my-8 shadow-2xl relative">
            <h2 className="text-2xl font-bold text-slate-100 mb-6">新增進行中案場</h2>
            <form onSubmit={handleCreateActive} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">案場代碼</span>
                  <input name="project_code" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">案場名稱 *</span>
                  <input name="name" type="text" required className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">容量 KW</span>
                  <input name="capacity" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">人員</span>
                  <select name="manager" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100 cursor-pointer">
                    <option value="">未指定</option>
                    {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">支架</span>
                  <input name="bracket_status" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">電力</span>
                  <input name="power_status" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">驗收</span>
                  <input name="inspection_status" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">掛表</span>
                  <input name="meter_status" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">新設頂蓋</span>
                  <input name="roof_status" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-slate-300">開工日期</span>
                  <input name="start_date" type="text" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100" />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-slate-300">備註</span>
                <textarea name="notes" className="p-2 bg-slate-900 border border-slate-700 rounded text-slate-100 min-h-[80px]"></textarea>
              </label>
              <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-slate-700">
                <button type="button" onClick={() => setIsActiveFormOpen(false)} className="px-4 py-2 bg-slate-700 text-slate-200 rounded hover:bg-slate-600 transition">取消</button>
                <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-500 transition">{isSubmitting ? '儲存中...' : '儲存'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isFormModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-800 border border-slate-700/60 p-6 rounded-2xl w-full max-w-4xl my-8 shadow-2xl relative">
            <h2 className="text-2xl font-bold text-slate-100 mb-6">{editingProject ? '編輯所有案場主檔' : '新增所有案場'}</h2>
            <ProjectForm 
              initialData={editingProject || undefined}
              onSubmit={handleCreateOrUpdateBase}
              onCancel={() => { setIsFormModalOpen(false); setEditingProject(null); }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}
    </div>
      {contextMenu && (
        <div 
          className="fixed z-[100] w-48 bg-slate-800 border border-slate-700/60 rounded-xl shadow-2xl py-2"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={() => { setViewingProject(contextMenu.project); setContextMenu(null); }}
          >
            詳細資料
          </button>
          
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-emerald-400 text-sm border-t border-slate-700/50 mt-1 pt-2"
            onClick={() => { handleCompleteProject(contextMenu.project); setContextMenu(null); }}
          >
            結案
          </button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-rose-400 text-sm"
            onClick={() => { handleArchiveProject(contextMenu.project); setContextMenu(null); }}
          >
            作廢 / 停用
          </button>
        </div>
      )}
    </>
  );
}
