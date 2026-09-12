"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Project, User, Contractor, WorkflowSnapshotResult, MemberPosition, Position, ProjectPositionAssignment } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { ProjectForm } from '@/components/ProjectForm';
import { ProjectDetailModal } from '@/components/ProjectDetailModal';
import { GanttChart } from '@/components/GanttChart';
import { parseDateField } from '@/lib/utils/date-utils';
import { SmartDateInput } from '@/components/SmartDateInput';
import { DateDualInput } from '@/components/DateDualInput';
import { WorkflowMilestoneQuickEditor } from '@/components/WorkflowMilestoneQuickEditor';
import { useUser } from '@/components/UserContext';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import { parseTaiwanProjectLocation, projectMatchesSearchQuery } from '@/lib/project-location';
import { isActiveProject } from '@/lib/project-selectors';
import { buildWorkflowActivityLog, getWorkflowMilestoneProjectPatch } from '@/lib/project-workflow';
import { logWorkflowActivitySafely } from '@/lib/workflow-activity';
import { supabase } from '@/lib/db/supabaseClient';
import { getConstructionOuterDisplay, getConstructionProjectPatch, getConstructionToday, validateActualCompletionDate } from '@/lib/construction-progress';
import { ACTIVE_PROJECT_SECTION_COLUMNS, getActiveProjectColumns } from '@/lib/active-project-columns';
import { MapPin, Plus, Search, Filter, Maximize2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { selectActiveProjectsForEngineeringMember, selectEngineeringMembers } from '@/lib/personnel-workspace';
import { parseProjectsRoute } from '@/lib/project-routes';

const getCity = (address: string | null) => {
  if (!address) return null;
  return parseTaiwanProjectLocation(address)?.city || '其他';
};

const getProjectConstructionDisplay = (
  plannedStartDate: string | null | undefined,
  endDate: string | null | undefined,
  isCompleted: boolean | undefined,
) => getConstructionOuterDisplay({
  planned_start_date: plannedStartDate ?? null,
  planned_end_date: isCompleted ? null : endDate ?? null,
  is_completed: isCompleted === true,
  actual_completed_date: isCompleted ? endDate ?? null : null,
}, getConstructionToday());

const logWorkflowInitialization = (
  project: Project,
  result: WorkflowSnapshotResult,
  actor: User | null,
) => {
  if (result.result !== 'created') return;
  void logWorkflowActivitySafely(buildWorkflowActivityLog({
    action: 'WORKFLOW_INITIALIZED',
    targetType: 'PROJECT_WORKFLOW',
    targetId: result.workflow_instance_id,
    targetLabel: '專案流程',
    projectId: project.id,
    projectName: project.name,
    actorUserId: actor?.id ?? 'system',
    actorName: actor?.name ?? 'System',
    before: null,
    after: { milestones_created: result.milestones_created },
  }));
};

export default function ProjectsPage() {
  const params = useParams();
  const { currentUser } = useUser();
  const projectsRoute = parseProjectsRoute(params.filter);
  const memberId = projectsRoute.kind === 'member' ? projectsRoute.memberId : null;

  const [projects, setProjects] = useState<Project[]>([]);
  
  const [users, setUsers] = useState<User[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [projectAssignments, setProjectAssignments] = useState<ProjectPositionAssignment[]>([]);
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

  const patchProjectState = (projectId: string, updates: Partial<Project>) => {
    setProjects(current => current.map(project => (
      project.id === projectId ? { ...project, ...updates } : project
    )));
    setViewingProject(current => (
      current?.id === projectId ? { ...current, ...updates } : current
    ));
  };
  const [activeTab, setActiveTab] = useState<'report' | 'gantt'>('report');
  const [contractors, setContractors] = useState<Contractor[]>([]);
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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        alert('Please sign in before creating a backup.');
        return;
      }

      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
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

  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('讀取超時，請重試')), 10000)
      );

      const [data, usersData, contractorsData, positionRows, memberPositionRows, assignmentRows] = await Promise.race([
        Promise.all([
          dbAdapter.getProjects(),
          dbAdapter.getUsers().catch(e => { console.error(e); return []; }),
          dbAdapter.getContractors(),
          dbAdapter.getPositions(),
          dbAdapter.getMemberPositions(),
          dbAdapter.getProjectPositionAssignments(),
        ]),
        timeoutPromise
      ]) as [Project[], User[], Contractor[], Position[], MemberPosition[], ProjectPositionAssignment[]];

      setProjects(data);
      setUsers(selectEngineeringMembers(usersData, positionRows, memberPositionRows));
      setPositions(positionRows);
      setProjectAssignments(assignmentRows);
      setContractors(contractorsData.filter(c => c.is_active));
    } catch (err: any) {
      console.error('Fetch projects failed:', err);
      setError(getDatabaseErrorMessage(err, '無法載入案場資料'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const filterUser = memberId ? users.find(user => user.id === memberId) : undefined;
  const isActiveView = projectsRoute.kind === 'active' || projectsRoute.kind === 'member';

  const getPageTitle = () => {
    if (projectsRoute.kind === 'active') return '進行中案場';
    if (filterUser) return `${filterUser.name}案場`;
    if (projectsRoute.kind === 'member') return '個人案場';
    return '所有案場';
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
        if (!projectMatchesSearchQuery(p, searchTerm, [p.contact_name, p.contact_phone, p.notes])) {
          return false;
        }
      }
      return true;
    });
  }, [projects, searchTerm, filterCity, filterWarrantyStatus, filterInverterBrand]);

  const filteredProjects = useMemo(() => {
    if (memberId) {
      return selectActiveProjectsForEngineeringMember(projects, memberId, positions, projectAssignments)
        .filter(project => !searchTerm || projectMatchesSearchQuery(project, searchTerm, [project.notes]));
    }
    return projects.filter(p => {
      if (!isActiveProject(p)) return false;

      if (searchTerm) {
        if (!projectMatchesSearchQuery(p, searchTerm, [p.notes])) return false;
      }
      return true;
    });
  }, [projects, searchTerm, memberId, positions, projectAssignments]);

  const activeCategories = useMemo(() => {
    const cats = {
      section1: [] as Project[], // 目前施工中案件
      section2: [] as Project[], // 下兩周預計進場之案件
      section3: [] as Project[], // 其他負責案件
      section4: [] as Project[], // 前兩周掛表案件
    };

    const globalBaseDateStr = new Date().toISOString().split('T')[0];
    const globalBaseDate = new Date(globalBaseDateStr);
    const globalBaseTime = new Date(globalBaseDate.getFullYear(), globalBaseDate.getMonth(), globalBaseDate.getDate()).getTime();

    filteredProjects.forEach(p => {
      // 強制使用全域的「今日」作為分類判斷的基準日，避免各案場自帶的舊基準日導致「下兩周」的定義錯亂
      const baseDateStr = globalBaseDateStr;
      const baseTime = globalBaseTime;

      // 掛表日期判斷：優先看新的 DateDualInput 產生的 expected_date，若無則看舊的 status
      let meterDate: Date | null = null;
      if (p.meter_expected_date) {
        meterDate = parseDateField(p.meter_expected_date, baseDateStr) || new Date(p.meter_expected_date);
      } else {
        meterDate = parseDateField(p.meter_status || "", baseDateStr);
      }
      
      const isDateBeforeOrEqualBase = (d: Date | null) => d && d.getTime() <= baseTime;
      const expectedDates: Date[] = [];
      const contractorTypes = ['racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other'];
      
      contractorTypes.forEach(type => {
        const expectedStr = p[`${type}_expected_start_date` as keyof Project] as string | null;
        if (expectedStr) {
          const parsed = parseDateField(expectedStr, baseDateStr);
          if (parsed) expectedDates.push(parsed);
          else expectedDates.push(new Date(expectedStr)); // fallback
        }
      });
      if (!p.racking_expected_start_date) {
        const d = parseDateField(p.bracket_status || "", baseDateStr);
        if (d) expectedDates.push(d);
      }
      if (!p.electrical_expected_start_date) {
        const d = parseDateField(p.power_status || "", baseDateStr);
        if (d) expectedDates.push(d);
      }

      const hasDateWithin14Days = expectedDates.some(d => d && d.getTime() >= baseTime && d.getTime() <= baseTime + 14 * 24 * 60 * 60 * 1000);
      const hasDateBeforeBase = expectedDates.some(d => d && d.getTime() < baseTime);
      const isLegacyCompleted = (text: string | null) => text?.includes('已完工') || text?.includes('已完成');
      const isLegacyDone = isLegacyCompleted(p.bracket_status || "") || isLegacyCompleted(p.power_status || "");

      if (isDateBeforeOrEqualBase(meterDate)) {
        cats.section4.push(p); // 1. 掛表日期在基準日前
      } else if (hasDateBeforeBase || isLegacyDone) {
        cats.section1.push(p); // 2. 任何工種進場日在基準日前 (代表已實際進場施工中)，或包含已完工/已完成
      } else if (hasDateWithin14Days) {
        cats.section2.push(p); // 3. 只要有任何工種預計在兩周內進場，且沒有任何工種已經進場
      } else {
        cats.section3.push(p); // 4. 其他 (超過兩周才要進場的案件)
      }
    });

    return cats;
  }, [filteredProjects]);

  const handleCreateOrUpdateBase = async (data: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => {
    setIsSubmitting(true);
    try {
      let workflowInitializationFailed = false;
      if (editingProject) {
        await dbAdapter.updateProject(editingProject.id, data);
      } else {
        const createdProject = await dbAdapter.createProject(data);
        try {
          const workflowResult = await dbAdapter.initializeProjectWorkflow(createdProject.id);
          logWorkflowInitialization(createdProject, workflowResult, currentUser);
        } catch (workflowError) {
          console.error('Project created but workflow initialization failed:', workflowError);
          workflowInitializationFailed = true;
        }
      }
      setIsFormModalOpen(false);
      setEditingProject(null);
      await fetchProjects();
      if (workflowInitializationFailed) {
        alert('案場已建立，但專案流程初始化失敗，可進案場重新建立流程。');
      }
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
      
      const createdProject = await dbAdapter.createProject(newActive);
      let workflowInitializationFailed = false;
      try {
        const workflowResult = await dbAdapter.initializeProjectWorkflow(createdProject.id);
        logWorkflowInitialization(createdProject, workflowResult, currentUser);
      } catch (workflowError) {
        console.error('Project created but workflow initialization failed:', workflowError);
        workflowInitializationFailed = true;
      }

      setIsActiveFormOpen(false);
      await fetchProjects();
      if (workflowInitializationFailed) {
        alert('案場已建立，但專案流程初始化失敗，可進案場重新建立流程。');
      }
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

  const handleConstructionDatesChange = (
    project: Project,
    type: 'racking' | 'electrical' | 'roof_cover',
    expectedStart: string | null,
    endDate: string | null,
  ) => {
    const isCompleted = Boolean(project[`${type}_is_completed` as keyof Project]);
    const today = getConstructionToday();
    const normalizedEndDate = isCompleted ? endDate || today : endDate;
    const validationError = isCompleted
      ? validateActualCompletionDate(normalizedEndDate, today)
      : null;
    if (validationError) {
      alert(validationError);
      return;
    }
    void handleProjectDatesChange(project.id, {
      [`${type}_expected_start_date`]: expectedStart,
      [`${type}_completion_date`]: normalizedEndDate,
      [`${type}_is_completed`]: isCompleted,
    } as Partial<Project>);
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
          setTimeout(() => setSaveStatus(''), 2000);
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
    const usesSharedActiveGeometry = isSec1 || isSec2 || isSec3;
    const columns = usesSharedActiveGeometry ? ACTIVE_PROJECT_SECTION_COLUMNS : getActiveProjectColumns({
      showBracket,
      showPower,
      showInspection,
      showMeter,
      showRoof,
      showStartDate,
      showComplete: isSec4,
    });
    const tableWidth = columns.reduce((total, column) => total + column.width, 0);

    return (
      <div className="mb-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <h2 className="text-xl font-bold text-primary mb-4 px-2 border-l-4 border-accent">{title} <span className="text-secondary text-sm font-normal ml-2">({projectsList.length})</span></h2>
        <div className="bg-card/40 border border-theme-border rounded-xl overflow-auto shadow-xl backdrop-blur-sm">
          <table data-column-geometry={usesSharedActiveGeometry ? 'active-projects-v1' : 'completed-projects-v1'} className="w-full table-fixed border-collapse text-left" style={{ minWidth: tableWidth }}>
            <colgroup>
              {columns.map(column => <col key={column.key} style={{ width: column.width }} />)}
            </colgroup>
            <thead className="bg-[var(--surface-secondary)] text-secondary text-sm border-b border-theme-border">
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
                  {usesSharedActiveGeometry && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">新設頂蓋</th>}
                  {usesSharedActiveGeometry && <th className="p-3 font-semibold whitespace-nowrap min-w-[120px]">開工日期</th>}
                  <th className="p-3 font-semibold min-w-[250px]">備註</th>
                  {isSec4 && <th className="p-3 font-semibold min-w-[80px]">操作</th>}
                </tr>
              </thead>
            <tbody className="divide-y divide-theme-border/40 text-sm">
              {projectsList.length === 0 ? (
                <tr>
                  <td colSpan={100} className="p-8 text-center text-secondary/70 italic">此區塊目前無資料</td>
                </tr>
              ) : projectsList.map(project => (
                <tr 
                  key={project.id} 
                  className="hover:bg-[var(--surface-secondary)] transition-colors group cursor-context-menu"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (currentUser?.role === 'VIEWER') return;
                    setContextMenu({ x: e.clientX, y: e.clientY, project });
                  }}
                >
                  <td className="p-3 text-center">
                    <button 
                      onClick={() => setViewingProject(project)}
                      className="p-1.5 rounded-md bg-card border border-theme-border text-accent hover:bg-accent hover:text-white transition-colors"
                      title="開啟詳細資料"
                    >
                      <Maximize2 size={16} />
                    </button>
                  </td>
                  <td className="p-3 text-secondary select-all">{project.project_code || project.id.slice(0, 8)}</td>
                  <td className="p-3 text-accent font-medium select-all truncate max-w-[250px]" title={project.name}>{project.name}</td>
                  <td className="p-3 text-secondary">{project.capacity || '-'}</td>
                  
                  {/* 工程負責人統一由 Project Detail 的「專案分工」維護。 */}
                  <td className="p-3 text-secondary">{project.manager || '未指派'}</td>
                  {showBracket && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.racking_expected_start_date || null}
                      completionDate={project.racking_completion_date || null}
                      completionIsActual={project.racking_is_completed}
                      summaryText={getProjectConstructionDisplay(project.racking_expected_start_date, project.racking_completion_date, project.racking_is_completed).label}
                      onChange={(exp, comp) => handleConstructionDatesChange(project, 'racking', exp, comp)}
                    />
                  </td>}
                  {showPower && <td className="p-1">
                    <DateDualInput 
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.electrical_expected_start_date || null}
                      completionDate={project.electrical_completion_date || null}
                      completionIsActual={project.electrical_is_completed}
                      summaryText={getProjectConstructionDisplay(project.electrical_expected_start_date, project.electrical_completion_date, project.electrical_is_completed).label}
                      onChange={(exp, comp) => handleConstructionDatesChange(project, 'electrical', exp, comp)}
                    />
                  </td>}
                  {showInspection && <td className="p-1">
                    <WorkflowMilestoneQuickEditor
                      projectId={project.id}
                      milestoneId={project.inspection_milestone_id ?? null}
                      milestoneKey="INTERNAL_ACCEPTANCE"
                      kind="ACCEPTANCE"
                      status={project.inspection_status ?? null}
                      plannedDate={project.inspection_expected_date ?? null}
                      actualDate={project.inspection_completion_date ?? null}
                      disabled={currentUser?.role === 'VIEWER'}
                      onUpdated={milestone => patchProjectState(project.id, getWorkflowMilestoneProjectPatch(milestone))}
                    />
                  </td>}
                  {showMeter && <td className="p-1">
                    <WorkflowMilestoneQuickEditor
                      projectId={project.id}
                      milestoneId={project.meter_milestone_id ?? null}
                      milestoneKey="METER_INSTALLATION"
                      kind="METER"
                      status={project.meter_status ?? null}
                      plannedDate={project.meter_expected_date ?? null}
                      actualDate={project.meter_completion_date ?? null}
                      disabled={currentUser?.role === 'VIEWER'}
                      onUpdated={milestone => patchProjectState(project.id, getWorkflowMilestoneProjectPatch(milestone))}
                    />
                  </td>}
                  {usesSharedActiveGeometry && <td className="p-1">
                    {showRoof && <DateDualInput
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.roof_cover_expected_start_date || null}
                      completionDate={project.roof_cover_completion_date || null}
                      completionIsActual={project.roof_cover_is_completed}
                      summaryText={getProjectConstructionDisplay(project.roof_cover_expected_start_date, project.roof_cover_completion_date, project.roof_cover_is_completed).label}
                      onChange={(exp, comp) => handleConstructionDatesChange(project, 'roof_cover', exp, comp)}
                    />}
                  </td>}
                  {usesSharedActiveGeometry && <td className="p-1">
                    {showStartDate && <SmartDateInput
                      disabled={currentUser?.role === 'VIEWER'}
                      value={project.start_date || ''}
                      baseDate={project.report_base_date || new Date().toISOString().split('T')[0]}
                      onChange={(val) => handleProjectInlineChange(project.id, 'start_date', val)}
                      placeholder="YYYY-MM-DD"
                    />}
                  </td>}
                  <td className="p-1">
                    <input 
                      disabled={currentUser?.role === 'VIEWER'}
                      type="text" value={project.notes || ''} 
                      onChange={(e) => handleProjectInlineChange(project.id, 'notes', e.target.value)}
                      className={`w-full bg-page/50 px-2 py-1.5 rounded border border-theme-border/50 transition-colors outline-none text-secondary placeholder:text-secondary/50 ${currentUser?.role === 'VIEWER' ? 'opacity-50 cursor-not-allowed' : 'hover:bg-page focus:bg-page focus:border-accent'}`}
                      placeholder="點擊輸入備註..."
                    />
                  </td>
                  {isSec4 && (
                    <td className="p-1 text-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCompleteProject(project); }}
                        disabled={currentUser?.role === 'VIEWER'}
                        className="bg-accent/80 hover:bg-accent text-white px-3 py-1.5 rounded text-xs font-semibold shadow transition-colors w-full disabled:opacity-50 disabled:cursor-not-allowed"
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
      <div className="mx-auto flex h-full min-w-0 flex-col p-3 sm:p-5 lg:p-8 xl:min-w-[1600px]">
      <div className="mb-4 flex flex-col items-stretch justify-between gap-3 sm:mb-6 lg:flex-row lg:items-center">
        <h1 className="break-words text-2xl font-bold text-primary sm:text-3xl">{getPageTitle()} <span className="ml-1 text-base font-normal text-secondary/70 sm:ml-2 sm:text-lg">({isActiveView ? filteredProjects.length : filteredBaseProjects.length})</span></h1>
        
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          {isActiveView && saveStatus && (
            <span className={`text-sm ${saveStatus === '已儲存' ? 'text-success' : saveStatus === '儲存失敗' ? 'text-danger' : 'text-accent'}`}>
              {saveStatus}
            </span>
          )}
          {isActiveView && (
            <button
              onClick={handleBackup}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-theme-border bg-card px-4 py-2.5 font-medium text-secondary shadow transition hover:bg-page hover:text-primary sm:flex-none"
            >
              建立備份
            </button>
          )}
          {isActiveView ? (
            <button 
              onClick={() => setIsActiveFormOpen(true)}
              disabled={currentUser?.role === 'VIEWER'}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-white shadow-lg shadow-accent/20 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              <Plus size={20} />
              新增進行中案場
            </button>
          ) : (
            <button 
              onClick={() => { setEditingProject(null); setIsFormModalOpen(true); }}
              disabled={currentUser?.role === 'VIEWER'}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-white shadow-lg shadow-accent/20 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              <Plus size={20} />
              新增所有案場
            </button>
          )}
        </div>
      </div>

      {!isActiveView && (
        <div className="bg-card/60 border border-theme-border p-4 rounded-xl mb-6 flex flex-col md:flex-row gap-4 backdrop-blur-sm shrink-0">
          <div className="flex-1 flex items-center gap-3 bg-page/50 rounded-lg px-3 border border-theme-border/50">
            <Search className="text-secondary" size={20} />
            <input 
              type="text" 
              placeholder="搜尋名稱、代碼、縣市、行政區或地址..."
              className="bg-transparent border-none outline-none text-primary w-full placeholder:text-secondary/50 py-2.5"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          
          <div className="flex gap-3 overflow-x-auto">
            <div className="flex items-center gap-2 bg-page/50 rounded-lg px-3 py-1 border border-theme-border/50 min-w-max">
              <Filter size={16} className="text-secondary" />
              <select 
                className="bg-transparent text-primary outline-none text-sm appearance-none py-1.5 cursor-pointer"
                value={filterCity} onChange={e => setFilterCity(e.target.value)}
              >
                <option value="">全部縣市</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 bg-page/50 rounded-lg px-3 py-1 border border-theme-border/50 min-w-max">
              <Filter size={16} className="text-secondary" />
              <select 
                className="bg-transparent text-primary outline-none text-sm appearance-none py-1.5 cursor-pointer"
                value={filterWarrantyStatus} onChange={e => setFilterWarrantyStatus(e.target.value)}
              >
                <option value="">所有保固狀態</option>
                {warrantyStatuses.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 bg-page/50 rounded-lg px-3 py-1 border border-theme-border/50 min-w-max">
              <Filter size={16} className="text-secondary" />
              <select 
                className="bg-transparent text-primary outline-none text-sm appearance-none py-1.5 cursor-pointer"
                value={filterInverterBrand} onChange={e => setFilterInverterBrand(e.target.value)}
              >
                <option value="">所有逆變器廠牌</option>
                {inverterBrands.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto relative">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-danger">
            <p className="mb-2 text-xl font-bold">載入失敗</p>
            <p>{error}</p>
            <button onClick={() => fetchProjects()} className="mt-4 px-4 py-2 bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary rounded-lg transition">重試</button>
          </div>
        ) : isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-secondary">載入中...</div>
        ) : isActiveView ? (
          
          <div className="pb-8 flex flex-col h-full">
            <div className="mb-6 flex shrink-0 gap-4 overflow-x-auto border-b border-theme-border/50 pb-2">
              <button 
                onClick={() => setActiveTab('report')}
                className={`px-4 py-2 font-medium transition-colors border-b-2 -mb-[10px] ${activeTab === 'report' ? 'text-accent border-accent' : 'text-secondary border-transparent hover:text-primary'}`}
              >
                週回報表
              </button>
              <button 
                onClick={() => setActiveTab('gantt')}
                className={`px-4 py-2 font-medium transition-colors border-b-2 -mb-[10px] ${activeTab === 'gantt' ? 'text-accent border-accent' : 'text-secondary border-transparent hover:text-primary'}`}
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
              <div className="min-h-[500px] flex-1 overflow-auto">
                <GanttChart 
                  projects={filteredProjects} 
                  contractors={contractors} 
                  onProjectClick={(p) => setViewingProject(p)}
                />
              </div>
            )}
          </div>

        ) : filteredBaseProjects.length === 0 ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-secondary/70 gap-2">
             <Search size={32} className="opacity-20" />
             <p>找不到相符的案場</p>
           </div>
        ) : (
          <div className="bg-card/40 border border-theme-border rounded-xl overflow-auto shadow-xl backdrop-blur-sm">
            <table className="w-full text-left border-collapse min-w-[1400px]">
              <thead className="bg-[var(--surface-secondary)] text-secondary text-sm sticky top-0 z-10 border-b border-theme-border backdrop-blur-md">
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
              <tbody className="divide-y divide-theme-border/40 text-sm">
                {filteredBaseProjects.map(project => {
                  const shortWarranty = project.warranty_status ? project.warranty_status.split('(')[0].trim() : '-';
                  
                  return (
                    <tr 
                      key={project.id} 
                      className="hover:bg-[var(--surface-secondary)] transition-colors cursor-pointer group"
                      onClick={() => { setEditingProject(project); setIsFormModalOpen(true); }}
                    >
                      <td className="p-4 text-primary">
                        {project.status || '-'}
                      </td>
                      <td className="p-4">
                        <span className="px-2 py-1 bg-accent/10 text-accent rounded-md text-xs font-medium border border-accent/20 whitespace-nowrap">
                          {shortWarranty}
                        </span>
                      </td>
                      <td className="p-4 text-primary font-medium group-hover:text-accent transition-colors">
                        <div className="flex items-center gap-2 truncate max-w-[250px]" title={project.name}>
                          {!project.is_active && <span className="w-2 h-2 rounded-full bg-secondary/60 shrink-0" title="已停用"></span>}
                          <span className="truncate">{project.name}</span>
                        </div>
                      </td>
                      <td className="p-4 text-secondary">{project.contact_name || '-'}</td>
                      <td className="p-4 text-secondary">{project.contact_phone || '-'}</td>
                      <td className="p-4">
                        {project.address ? (
                          <button onClick={(e) => openGoogleMaps(e, project.address!)} className="text-secondary hover:text-accent flex items-start gap-1 transition-colors text-left w-full" title={project.address}>
                            <MapPin size={14} className="mt-0.5 flex-shrink-0" /> 
                            <span className="truncate">{project.address}</span>
                          </button>
                        ) : <span className="text-secondary/70">-</span>}
                      </td>
                      <td className="p-4 text-secondary">
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
          key={viewingProject.id}
          project={viewingProject as any} 
          onClose={() => setViewingProject(null)} 
          onUpdate={async () => {
            await fetchProjects();
            const adapter = dbAdapter as any;
            const updatedProjects = await adapter.getProjects();
            const updated = updatedProjects.find((p: Project) => p.id === viewingProject.id);
            if (updated) setViewingProject(updated);
          }}
          onConstructionUpdated={result => patchProjectState(
            result.row.project_id,
            getConstructionProjectPatch(result.row, result.type === 'remove'),
          )}
          onMilestoneUpdated={milestone => patchProjectState(
            milestone.project_id,
            getWorkflowMilestoneProjectPatch(milestone),
          )}
        />
      )}

      {isActiveFormOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-page/80 p-2 backdrop-blur-sm sm:p-4">
          <div className="relative my-2 max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-theme-border bg-card p-4 shadow-2xl sm:my-8 sm:max-h-[calc(100dvh-2rem)] sm:p-6">
            <h2 className="mb-6 text-xl font-bold text-primary sm:text-2xl">新增進行中案場</h2>
            <form onSubmit={handleCreateActive} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">案場代碼</span>
                  <input name="project_code" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">案場名稱 *</span>
                  <input name="name" type="text" required className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">容量 KW</span>
                  <input name="capacity" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">支架</span>
                  <input name="bracket_status" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">電力</span>
                  <input name="power_status" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">驗收</span>
                  <input name="inspection_status" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">掛表</span>
                  <input name="meter_status" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">新設頂蓋</span>
                  <input name="roof_status" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-secondary">開工日期</span>
                  <input name="start_date" type="text" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent" />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-secondary">備註</span>
                <textarea name="notes" className="p-2 bg-page border border-theme-border rounded text-primary outline-none focus:border-accent min-h-[80px]"></textarea>
              </label>
              <div className="mt-4 flex flex-wrap justify-end gap-3 border-t border-theme-border pt-4">
                <button type="button" onClick={() => setIsActiveFormOpen(false)} className="px-4 py-2 bg-card border border-theme-border text-secondary hover:text-primary rounded-lg transition font-medium">取消</button>
                <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover transition font-medium disabled:opacity-50">{isSubmitting ? '儲存中...' : '儲存'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isFormModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-page/80 p-2 backdrop-blur-sm sm:p-4">
          <div className="relative my-2 max-h-[calc(100dvh-1rem)] w-full max-w-4xl overflow-y-auto rounded-2xl border border-theme-border bg-card p-4 shadow-2xl sm:my-8 sm:max-h-[calc(100dvh-2rem)] sm:p-6">
            <h2 className="mb-6 text-xl font-bold text-primary sm:text-2xl">{editingProject ? '編輯所有案場主檔' : '新增所有案場'}</h2>
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
          className="fixed z-[100] w-48 bg-card border border-theme-border rounded-xl shadow-2xl py-2"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-page text-primary text-sm"
            onClick={() => { setViewingProject(contextMenu.project); setContextMenu(null); }}
          >
            詳細資料
          </button>
          
          <button 
            className="w-full text-left px-4 py-2 hover:bg-page text-accent text-sm border-t border-theme-border/50 mt-1 pt-2"
            onClick={() => { handleCompleteProject(contextMenu.project); setContextMenu(null); }}
          >
            結案
          </button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-page text-danger text-sm"
            onClick={() => { handleArchiveProject(contextMenu.project); setContextMenu(null); }}
          >
            作廢 / 停用
          </button>
        </div>
      )}
    </>
  );
}
