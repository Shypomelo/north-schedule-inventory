"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, format } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { ArrowUpRight, BriefcaseBusiness, CalendarDays, CheckCircle2, Circle, LayoutDashboard, ListTodo, Loader2, MapPin, Package, Users, Wrench } from 'lucide-react';
import { ProjectDetailModal } from '@/components/ProjectDetailModal';
import { ScheduleTaskDetail } from '@/components/ScheduleTaskDetail';
import { ScheduleTaskFormDialog } from '@/components/ScheduleTaskFormDialog';
import { useUser } from '@/components/UserContext';
import { TodoTextEditDialog } from '@/components/TodoTextEditDialog';
import { TodoInlineText } from '@/components/TodoInlineText';
import { TodoContextMenu } from '@/components/TodoContextMenu';
import { TodoRow } from '@/components/TodoRow';
import { TodoQuickComposer } from '@/components/TodoQuickComposer';
import { useDashboardView } from '@/components/DashboardViewContext';
import { DesignWorkbench } from '@/components/DesignWorkbench';
import { ProjectOverviewCards } from '@/components/ProjectOverviewCards';
import { workbenchAdapter } from '@/lib/db/workbench-adapter';
import type { ProjectMilestone } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import type { ActivityLog, MemberProjectResponsibility, Project, ProjectMaterial, ProjectMaterialBatch, ScheduleTask, ScheduleTaskMember, Todo, User, WorkGroup } from '@/lib/db/types';
import { buildDashboardProjectCards } from '@/lib/engineering-dashboard';
import {
  buildReceiptScheduleTask,
  formatMaterialReceiptSummary,
  formatRecentReceiptDateTime,
  isMaterialBatchScheduleDuplicate,
  MATERIAL_REMINDER_HORIZON_DAYS,
  selectEngineeringProjectIds,
  selectRecentReceiptGroups,
  type RecentReceiptGroup,
} from '@/lib/material-reminders';
import { presentBusinessDate } from '@/lib/date-presentation';
import {
  formatScheduleTaskTime,
  getDefaultMaintenanceDateRange,
  isScheduleTaskCompleted,
  type MaintenanceScheduleFilter,
  selectMaintenanceScheduleTasks,
  selectScheduleTasksByWorkGroup,
  selectTodayMemberSchedule,
} from '@/lib/schedule-selectors';
import { getScheduleTaskPresentation } from '@/lib/schedule-presentation';
import { isActiveProject, selectActiveProjects } from '@/lib/project-selectors';
import { selectActiveTeamTodos } from '@/lib/todo-selectors';
import { useScheduleWeather } from '@/hooks/useScheduleWeather';
import { canDeleteTodo } from '@/lib/todo-text-actions';
import { canCreateTodo, createCanonicalPrivateTodo } from '@/lib/todo-create';
import { selectTodoPool, type WorkItem } from '@/lib/workbench';
import {
  completeScheduleTaskWithActivity,
  confirmScheduleTaskDeletion,
  createScheduleTaskWithActivity,
  deleteScheduleTaskWithActivity,
  updateScheduleTaskWithActivity,
} from '@/lib/schedule-task-actions';
import type { MemberWorkGroup } from '@/lib/work-groups';

type MobileDashboardPage = 'schedule' | 'projects' | 'receipts' | 'todos';
type MobileTodoPage = 'private' | 'team';
type EngineeringDashboardView = 'overview' | 'maintenance';

const MAINTENANCE_TABS: { key: MaintenanceScheduleFilter; label: string }[] = [
  { key: 'week', label: '本週' },
  { key: 'incomplete', label: '未完成' },
  { key: 'completed', label: '已完成' },
];

export default function DashboardPage() {
  const {selected,loading,error}=useDashboardView();
  if(loading)return <p className="p-5">載入工作視角…</p>;
  if(error||!selected)return <p role="alert" className="p-5">{error||'未指派啟用工作視角'}</p>;
  return selected.key==='DESIGN'?<DesignWorkbench/>:<EngineeringDashboardPage key={selected.key} projectManagement={selected.key==='PROJECT_MANAGEMENT'}/>;
}

function EngineeringDashboardPage({projectManagement=false}:{projectManagement?:boolean}) {
  const todoGroupKey=projectManagement?'PROJECT':'ENGINEERING';
  const [overviewMilestones,setOverviewMilestones]=useState<ProjectMilestone[]>([]);
  const { currentUser, allUsers } = useUser();
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [taskMembers, setTaskMembers] = useState<ScheduleTaskMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workGroups, setWorkGroups] = useState<WorkGroup[]>([]);
  const [groupMemberships, setGroupMemberships] = useState<MemberWorkGroup[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [responsibilities, setResponsibilities] = useState<MemberProjectResponsibility[]>([]);
  const [receiptBatches, setReceiptBatches] = useState<ProjectMaterialBatch[]>([]);
  const [receiptMaterials, setReceiptMaterials] = useState<ProjectMaterial[]>([]);
  const [privateTodos, setPrivateTodos] = useState<Todo[]>([]);
  const [teamTodos, setTeamTodos] = useState<Todo[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [privateTitle, setPrivateTitle] = useState('');
  const [teamTitle, setTeamTitle] = useState('');
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [hideCompletedPrivate, setHideCompletedPrivate] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<{ project: Project; milestoneId: string | null; initialTab?: 'materials' } | null>(null);
  const [selectedTask, setSelectedTask] = useState<ScheduleTask | null>(null);
  const [editingTask, setEditingTask] = useState<ScheduleTask | null>(null);
  const [editingTaskMemberIds, setEditingTaskMemberIds] = useState<string[]>([]);
  const [taskActionPending, setTaskActionPending] = useState(false);
  const [mobilePage, setMobilePage] = useState<MobileDashboardPage>('schedule');
  const [mobileTodoPage, setMobileTodoPage] = useState<MobileTodoPage>('private');
  const [dashboardView, setDashboardView] = useState<EngineeringDashboardView>('overview');
  const [maintenanceFilter, setMaintenanceFilter] = useState<MaintenanceScheduleFilter>('week');
  const [maintenanceDateRange, setMaintenanceDateRange] = useState(() => getDefaultMaintenanceDateRange());
  const today = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);
  const canMutateTodos = canCreateTodo(currentUser);

  const loadDashboard = useCallback(async () => {
    if (!currentUser) return;
    setError(null);
    try {
      const groups = await dbAdapter.getWorkGroups();
      const engineeringGroup = groups.find(group => group.is_active && group.key === todoGroupKey);
      if (!engineeringGroup) throw new Error('找不到工程工作群組');
      const [taskRows, memberRows, projectRows, responsibilityRows, privateRows, teamRows, workGroupRows, activityRows, workItemRows, membershipRows] = await Promise.all([
        dbAdapter.getScheduleTasks(),
        dbAdapter.getScheduleTaskMembers(),
        dbAdapter.getProjects(),
        dbAdapter.getMemberProjectResponsibilities(currentUser.id),
        dbAdapter.getPrivateTodos(),
        dbAdapter.getTodos(engineeringGroup.id),
        Promise.resolve(groups),
        dbAdapter.getActivityLogs(),
        workbenchAdapter.getItems(currentUser.id),
        dbAdapter.getMemberWorkGroups(),
      ]);
      setTasks(taskRows);
      setTaskMembers(memberRows);
      const activeProjectRows = selectActiveProjects(projectRows);
      setProjects(activeProjectRows);
      if(projectManagement)setOverviewMilestones(await workbenchAdapter.getMilestones(activeProjectRows.map(project=>project.id)));
      const activeResponsibilities = responsibilityRows.filter(row => isActiveProject(row.project));
      setResponsibilities(activeResponsibilities);
      if (projectManagement) {
        setReceiptBatches([]);
        setReceiptMaterials([]);
      } else {
        const engineeringProjectIds = selectEngineeringProjectIds(activeResponsibilities, currentUser.id);
        const batches = await dbAdapter.listProjectMaterialBatchesForReminder(
          engineeringProjectIds,
          addDays(new Date(), MATERIAL_REMINDER_HORIZON_DAYS).toISOString(),
        );
        const reminderMaterials = await dbAdapter.listProjectMaterialsByBatchIds(
          batches.map(batch => batch.id),
        );
        setReceiptMaterials(reminderMaterials);
        setReceiptBatches(batches);
      }
      setPrivateTodos(privateRows);
      setTeamTodos(teamRows);
      setWorkGroups(workGroupRows.filter(group => group.is_active));
      setGroupMemberships(membershipRows);
      setActivityLogs(activityRows);
      setWorkItems(workItemRows);
    } catch (loadError) {
      console.error('Dashboard load failed:', loadError);
      setError(loadError instanceof Error ? loadError.message : '工程儀表載入失敗');
    } finally {
      setIsLoading(false);
    }
  }, [currentUser,projectManagement,todoGroupKey]);

  useEffect(() => {
    if (currentUser) void loadDashboard();
  }, [currentUser, loadDashboard]);

  const todayTasks = useMemo(() => currentUser ? selectTodayMemberSchedule({
    tasks,
    members: taskMembers,
    memberId: currentUser.id,
    today,
  }) : [], [currentUser, taskMembers, tasks, today]);
  const dashboardWorkGroup = workGroups.find(group => group.key === todoGroupKey);
  const dashboardTasks = useMemo(() => selectScheduleTasksByWorkGroup(
    tasks,
    dashboardWorkGroup?.id,
    { members: taskMembers, users: allUsers, memberships: groupMemberships, groups: workGroups },
  ), [allUsers, dashboardWorkGroup?.id, groupMemberships, taskMembers, tasks, workGroups]);
  const maintenanceTasks = useMemo(() => selectMaintenanceScheduleTasks(
    dashboardTasks,
    maintenanceFilter,
    maintenanceDateRange,
  ), [dashboardTasks, maintenanceDateRange, maintenanceFilter]);
  const getTaskWeatherDisplay = useScheduleWeather(todayTasks, projects);
  const projectCards = useMemo(
    () => buildDashboardProjectCards(responsibilities, today),
    [responsibilities, today],
  );
  const recentReceiptGroups = useMemo(() => currentUser ? selectRecentReceiptGroups({
    memberId: currentUser.id,
    responsibilities,
    projects,
    batches: receiptBatches,
    materials: receiptMaterials,
    scheduleTasks: tasks,
    now: new Date(),
  }) : [], [currentUser, projects, receiptBatches, receiptMaterials, responsibilities, tasks]);
  const visiblePrivateTodos = selectTodoPool(privateTodos, workItems)
    .filter(todo => !hideCompletedPrivate || todo.status !== '已完成');
  const visibleTeamTodos = selectTodoPool(selectActiveTeamTodos(
    teamTodos,
    workGroups.find(group => group.key === todoGroupKey)?.id ?? null,
  ), workItems);

  const createPrivateTodo = async (event: FormEvent) => {
    event.preventDefault();
    const title = privateTitle.trim();
    if (!title || !currentUser || !canMutateTodos) return;
    setSavingKey('private-new');
    try {
      await createCanonicalPrivateTodo(title, currentUser);
      setPrivateTitle('');
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '私人待辦新增失敗');
    } finally {
      setSavingKey(null);
    }
  };

  const createTeamTodo = async (event: FormEvent) => {
    event.preventDefault();
    const title = teamTitle.trim();
    if (!title || !currentUser || !canMutateTodos) return;
    setSavingKey('team-new');
    try {
      await dbAdapter.createTodo({
        work_group_id: workGroups.find(group => group.is_active && group.key === todoGroupKey)?.id || null,
        title,
        content: null,
        project_id: null,
        task_type: null,
        status: '待安排',
        scope: 'TEAM',
        created_by: currentUser.id,
        assigned_to: null,
        assigned_by: null,
        converted_task_id: null,
        rejected_by: null,
        rejected_at: null,
        rejection_reason: null,
      });
      setTeamTitle('');
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '團隊待辦新增失敗');
    } finally {
      setSavingKey(null);
    }
  };

  const completePrivateTodo = async (todo: Todo) => {
    setSavingKey(todo.id);
    try {
      await dbAdapter.updatePrivateTodo(todo.id, { status: '已完成' });
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '私人待辦更新失敗');
    } finally {
      setSavingKey(null);
    }
  };

  const completeTeamTodo = async (todo: Todo) => {
    setSavingKey(todo.id);
    try {
      await dbAdapter.updateTodo(todo.id, { status: '已完成' });
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '團隊待辦更新失敗');
    } finally {
      setSavingKey(null);
    }
  };

  const deleteTodo = async (todo: Todo) => {
    if (!canDeleteTodo(todo, currentUser) || !window.confirm(`確定要刪除「${todo.title}」嗎？`)) return;
    setSavingKey(todo.id);
    try {
      if (todo.scope === 'PRIVATE') await dbAdapter.deletePrivateTodo(todo.id);
      else await dbAdapter.deleteTodo(todo.id);
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '待辦刪除失敗');
    } finally { setSavingKey(null); }
  };

  const scheduleActor = { id: currentUser?.id, name: currentUser?.name };

  const completeSelectedTask = async () => {
    if (!selectedTask || !canMutateTodos) return;
    setTaskActionPending(true);
    try {
      await completeScheduleTaskWithActivity(selectedTask, scheduleActor, {
        projects,
        users: allUsers,
        memberIds: taskMembers.filter(member => member.task_id === selectedTask.id).map(member => member.user_id),
      });
      setSelectedTask(null);
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '排程完成失敗');
    } finally {
      setTaskActionPending(false);
    }
  };

  const openSelectedTaskForReschedule = () => {
    if (!selectedTask || !canMutateTodos) return;
    setEditingTask(selectedTask);
    setEditingTaskMemberIds(taskMembers.filter(member => member.task_id === selectedTask.id).map(member => member.user_id));
    setSelectedTask(null);
  };

  const updateSelectedTask = async (
    data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>,
    memberIds: string[],
  ) => {
    if (!editingTask || !canMutateTodos) return;
    setTaskActionPending(true);
    try {
      await updateScheduleTaskWithActivity({
        task: editingTask,
        data,
        memberIds,
        previousMemberIds: editingTaskMemberIds,
        actor: scheduleActor,
        auditContext: { projects, users: allUsers },
      });
      setEditingTask(null);
      setEditingTaskMemberIds([]);
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '排程改期失敗');
      throw mutationError;
    } finally {
      setTaskActionPending(false);
    }
  };

  const deleteSelectedTask = async () => {
    if (!selectedTask || !canMutateTodos || !confirmScheduleTaskDeletion()) return;
    setTaskActionPending(true);
    try {
      await deleteScheduleTaskWithActivity(selectedTask, scheduleActor, {
        projects,
        users: allUsers,
        memberIds: taskMembers.filter(member => member.task_id === selectedTask.id).map(member => member.user_id),
      });
      setSelectedTask(null);
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '排程刪除失敗');
    } finally {
      setTaskActionPending(false);
    }
  };

  const addReceiptToSchedule = async (group: RecentReceiptGroup) => {
    if (!currentUser || !canMutateTodos || group.scheduleTaskId) return;
    const engineeringGroup = workGroups.find(workGroup => workGroup.is_active && workGroup.key === 'ENGINEERING');
    if (!engineeringGroup) {
      setError('找不到工程排程群組');
      return;
    }
    const key = `receipt:${group.batch.id}`;
    setSavingKey(key);
    setError(null);
    try {
      const task = await createScheduleTaskWithActivity({
        data: buildReceiptScheduleTask({
          group,
          workGroupId: engineeringGroup.id,
          owner: currentUser,
          creator: currentUser,
        }),
        memberIds: [],
        actor: { id: currentUser.id, name: currentUser.name },
        auditContext: { projects, users: allUsers },
      });
      setTasks(current => [...current, task]);
      await loadDashboard();
    } catch (scheduleError) {
      if (isMaterialBatchScheduleDuplicate(scheduleError)) {
        await loadDashboard();
        setError('此叫料批次已加入排程。');
      } else {
        setError(scheduleError instanceof Error ? scheduleError.message : '收料排程建立失敗');
      }
    } finally {
      setSavingKey(null);
    }
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center gap-3 text-secondary"><Loader2 className="animate-spin" size={20} />載入工程儀表…</div>;
  }

  return (
    <div className="min-h-full bg-page px-4 py-5 text-primary md:px-6 md:py-7 xl:px-8 min-[1100px]:h-[100dvh] min-[1100px]:overflow-hidden">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-accent">Engineering overview</p>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{projectManagement?'專案管理儀表':'工程儀表'}</h1>
        </div>
        <div className="text-right">
          <div className="font-semibold">{format(new Date(), 'M月d日 EEEE', { locale: zhTW })}</div>
          <div className="mt-0.5 text-sm text-secondary">{currentUser?.name}</div>
        </div>
      </header>

      {!projectManagement ? (
        <nav className="mb-4 flex w-fit rounded-xl border border-theme-border bg-card p-1" aria-label="工程儀表功能" role="tablist">
          <button type="button" role="tab" aria-selected={dashboardView === 'overview'} onClick={() => setDashboardView('overview')} className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold transition ${dashboardView === 'overview' ? 'bg-accent text-white shadow-sm' : 'text-secondary hover:text-primary'}`}>
            <LayoutDashboard size={16} />儀表總覽
          </button>
          <button type="button" role="tab" aria-selected={dashboardView === 'maintenance'} onClick={() => setDashboardView('maintenance')} className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold transition ${dashboardView === 'maintenance' ? 'bg-accent text-white shadow-sm' : 'text-secondary hover:text-primary'}`}>
            <Wrench size={16} />維修清單
          </button>
        </nav>
      ) : null}

      {error ? <div className="mb-5 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}

      {dashboardView === 'maintenance' && !projectManagement ? (
        <MaintenanceList
          tasks={maintenanceTasks}
          projects={projects}
          users={allUsers}
          members={taskMembers}
          workGroups={workGroups}
          filter={maintenanceFilter}
          dateRange={maintenanceDateRange}
          onDateRangeChange={setMaintenanceDateRange}
          onResetDateRange={() => setMaintenanceDateRange(getDefaultMaintenanceDateRange())}
          onFilterChange={setMaintenanceFilter}
          onOpenTask={setSelectedTask}
        />
      ) : <>
        <nav className={`mb-4 grid ${projectManagement ? 'grid-cols-3' : 'grid-cols-4'} rounded-xl border border-theme-border bg-card p-1 md:hidden`} aria-label="工程儀表頁面" role="tablist">
        <MobileTab active={mobilePage === 'schedule'} onClick={() => setMobilePage('schedule')}>今日排程</MobileTab>
        <MobileTab active={mobilePage === 'projects'} onClick={() => setMobilePage('projects')}>{projectManagement?'案件進度':'專案進度'}</MobileTab>
        {!projectManagement ? <MobileTab active={mobilePage === 'receipts'} onClick={() => setMobilePage('receipts')}>近期收料</MobileTab> : null}
        <MobileTab active={mobilePage === 'todos'} onClick={() => setMobilePage('todos')}>TO DO</MobileTab>
        </nav>

      <div className={`grid min-w-0 items-start gap-4 md:grid-cols-2 min-[1100px]:min-h-0 min-[1100px]:items-stretch ${projectManagement ? 'min-[1100px]:h-[calc(100%-5rem)] min-[1100px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)_minmax(0,0.9fr)]' : 'min-[1100px]:h-[calc(100%-8.5rem)] min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)_minmax(0,0.88fr)_minmax(0,0.93fr)]'}`}>
        <DashboardSection icon={<CalendarDays size={18} />} title="今日排程" count={todayTasks.length} actionHref="/schedule" actionLabel="查看排程" className={`${mobilePage === 'schedule' ? 'block' : 'hidden'} md:block min-[1100px]:sticky min-[1100px]:top-6`}>
          {todayTasks.length === 0 ? <EmptyState text="今天暫時沒有排程" /> : (
            <div className="space-y-2.5">
              {todayTasks.map(task => {
                const display = getScheduleTaskPresentation(task, projects, allUsers, taskMembers, workGroups);
                const weather = getTaskWeatherDisplay(task);
                const isDone = task.status === '完成' || task.status === '已完成';
                const timeLabel = formatScheduleTaskTime(task);
                const heading = display.projectName || display.cardDetail;
                const detail = display.projectName ? display.cardDetail : '';
                return (
                  <article
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看排程：${heading}`}
                    onClick={() => setSelectedTask(task)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedTask(task);
                      }
                    }}
                    className={`cursor-pointer rounded-xl border-l-4 bg-[var(--surface-secondary)] px-3.5 py-3 transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent/60 ${isDone ? 'border-[var(--text-muted)] opacity-55' : task.is_tentative ? 'border-warning' : 'border-accent'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{heading}</div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-2">
                          {detail && <span className="truncate text-sm font-medium text-accent">{detail}</span>}
                          <span className="shrink-0 rounded-full border border-theme-border px-1.5 py-0.5 text-[10px] font-semibold text-secondary">{display.workGroupName}</span>
                        </div>
                      </div>
                      {timeLabel && <span className="shrink-0 rounded-full bg-page px-2 py-1 text-xs font-semibold text-secondary">{timeLabel}</span>}
                    </div>
                    {(display.assigneeDisplay || display.collaboratorDisplay || weather) && <div className="mt-2 min-w-0 text-xs leading-5 text-secondary">
                      {display.assigneeDisplay && <div className="truncate">{display.assigneeDisplay}</div>}
                      {(display.collaboratorDisplay || weather) && <div className="flex min-w-0 items-center justify-between gap-2">
                        {display.collaboratorDisplay && <span className="min-w-0 truncate">{display.collaboratorDisplay}</span>}
                        {weather && <span className="shrink-0 whitespace-nowrap" aria-label={`天氣：${weather.label}`}>
                          {weather.icon} {weather.label}
                        </span>}
                      </div>}
                    </div>}
                    <div className={`mt-2 flex items-center gap-2 border-t border-theme-border/60 pt-2 ${display.mapUrl ? 'justify-between' : 'justify-end'}`}>
                      {display.mapUrl ? <a
                        href={display.mapUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                        className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-bold text-accent hover:bg-page"
                      >
                        <MapPin size={14} /> MAP
                      </a> : null}
                      <span className="text-[11px] font-medium text-secondary">點擊查看完整資訊</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </DashboardSection>

        {projectManagement ? (
          <DashboardSection icon={<BriefcaseBusiness size={18}/>} title="案件進度" count={projects.length} className={`${mobilePage==='projects'?'block':'hidden'} md:block`}>
            <ProjectOverviewCards projects={projects} milestones={overviewMilestones} today={today} onOpen={(project,milestoneId)=>setSelectedProject({project,milestoneId})}/>
          </DashboardSection>
        ) : (
            <DashboardSection icon={<BriefcaseBusiness size={18} />} title="專案進度" count={projectCards.length} className={`${mobilePage === 'projects' ? 'block' : 'hidden'} min-w-0 md:block`}>
              {projectCards.length === 0 ? <EmptyState text="目前沒有指派中的專案" /> : (
                <div className="space-y-2.5">
                  {projectCards.map(card => {
                    const fullProject = projects.find(project => project.id === card.project.id) ?? card.project;
                    const milestoneTarget = [...card.progress]
                      .filter(group => group.current)
                      .sort((a, b) => (a.current?.planned_date || '9999').localeCompare(b.current?.planned_date || '9999'))[0]
                      ?.current?.id ?? null;
                    return (
                      <button type="button" key={card.project.id} onClick={() => setSelectedProject({ project: fullProject, milestoneId: milestoneTarget })} className="group w-full min-w-0 rounded-xl border border-theme-border bg-[var(--surface-secondary)] p-2.5 text-left transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg">
                        <div className="flex min-w-0 items-start gap-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="overflow-hidden text-sm font-bold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">{card.project.name}</div>
                            {card.project.project_code ? <div className="mt-0.5 text-xs text-secondary">{card.project.project_code}</div> : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {card.isOverdue ? <span className="rounded-full bg-danger/10 px-2 py-1 text-[11px] font-bold text-danger">逾期</span> : null}
                            <ArrowUpRight className="text-secondary transition group-hover:text-accent" size={18} />
                          </div>
                        </div>
                        <div className="mt-1.5 divide-y divide-theme-border/70">
                          {card.progress.map(group => (
                            <div key={group.positionId} className="space-y-0.5 py-1.5 first:pt-0 last:pb-0">
                              <div className="flex min-w-0 items-baseline gap-1 text-xs">
                                <span className="shrink-0 font-bold text-secondary">{group.positionName}｜</span>
                                {group.state === 'COMPLETED' ? (
                                  <span className="min-w-0 truncate font-semibold text-success">✓ {group.current?.label} 已完成</span>
                                ) : (
                                  <><span className="shrink-0 text-secondary">前項：</span><span className="min-w-0 truncate text-primary/70">{group.previous?.label || '—'}</span>{group.previous?.status === 'COMPLETED' ? <span className="shrink-0 font-semibold text-success">✓ 已完成</span> : null}</>
                                )}
                              </div>
                              {group.state !== 'COMPLETED' ? <div className="flex min-w-0 items-baseline gap-1 text-xs"><span className="shrink-0 font-bold text-accent">{group.state === 'CURRENT' ? '目前' : '即將'}：</span><span className="min-w-0 truncate font-semibold">{group.current?.label}</span></div> : null}
                              <div className="text-[11px] leading-4 text-secondary">{presentBusinessDate({planned:group.current?.planned_date,actual:group.current?.actual_date,completed:group.current?.status==='COMPLETED',today}).label}</div>
                            </div>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </DashboardSection>
        )}
        {!projectManagement ? (
          <DashboardSection icon={<Package size={18} />} title="近期收料" count={recentReceiptGroups.length} className={`${mobilePage === 'receipts' ? 'block' : 'hidden'} md:block`}>
            <RecentReceiptList
              groups={recentReceiptGroups}
              savingKey={savingKey}
              canMutate={canMutateTodos}
              onOpen={group => setSelectedProject({ project: group.project, milestoneId: null, initialTab: 'materials' })}
              onAddToSchedule={group => void addReceiptToSchedule(group)}
            />
          </DashboardSection>
        ) : null}
        <div className={`${mobilePage === 'todos' ? 'block' : 'hidden'} min-w-0 space-y-3 md:col-span-2 md:block min-[1100px]:col-span-1 min-[1100px]:h-full min-[1100px]:min-h-0 min-[1100px]:overflow-y-auto`}>
          <nav className="grid grid-cols-2 rounded-xl border border-theme-border bg-card p-1" aria-label="TO DO 類型" role="tablist">
            <MobileTab active={mobileTodoPage === 'private'} onClick={() => setMobileTodoPage('private')}>我的</MobileTab>
            <MobileTab active={mobileTodoPage === 'team'} onClick={() => setMobileTodoPage('team')}>團隊</MobileTab>
          </nav>
          {mobileTodoPage === 'private' ? <DashboardSection icon={<ListTodo size={18} />} title="TO DO" count={visiblePrivateTodos.length} headerAccessory={<HideCompletedToggle checked={hideCompletedPrivate} onChange={setHideCompletedPrivate} />}>
            <TodoQuickComposer value={privateTitle} onChange={setPrivateTitle} onSubmit={createPrivateTodo} placeholder="新增私人記事…" disabled={!canMutateTodos} isSaving={savingKey === 'private-new'} />
            <TodoList actor={currentUser} todos={visiblePrivateTodos} emptyText={hideCompletedPrivate ? '沒有未完成的私人記事' : '目前沒有私人記事'} savingKey={savingKey} onComplete={completePrivateTodo} onEdit={setEditingTodo} onDelete={deleteTodo} onSaved={loadDashboard} disabled={!canMutateTodos} />
          </DashboardSection> : null}

          {mobileTodoPage === 'team' ? <DashboardSection icon={<Users size={18} />} title="TO DO" count={visibleTeamTodos.length} actionHref="/schedule" actionLabel="週排程待辦">
            <TodoQuickComposer value={teamTitle} onChange={setTeamTitle} onSubmit={createTeamTodo} placeholder="新增團隊待辦…" disabled={!canMutateTodos} isSaving={savingKey === 'team-new'} />
            <TodoList
              actor={currentUser}
              todos={visibleTeamTodos}
              onEdit={setEditingTodo}
              onDelete={deleteTodo}
              onSaved={loadDashboard}
              emptyText="目前沒有待安排的團隊待辦"
              savingKey={savingKey}
              onComplete={completeTeamTodo}
              disabled={!canMutateTodos}
              secondary={todo => {
                const assignee = allUsers.find(user => user.id === todo.assigned_to);
                const project = projects.find(row => row.id === todo.project_id);
                return [project?.name, assignee ? `指派給 ${assignee.name}` : null].filter(Boolean).join(' · ');
              }}
            />
          </DashboardSection> : null}
        </div>
        </div>
      </>}

      {editingTodo && <TodoTextEditDialog todo={editingTodo} onClose={() => setEditingTodo(null)} onSaved={loadDashboard} />}
      {selectedProject ? (
        <ProjectDetailModal
          key={`${selectedProject.project.id}:${selectedProject.milestoneId || ''}`}
          project={selectedProject.project}
          initialMilestoneId={selectedProject.milestoneId}
          initialTab={selectedProject.initialTab}
          onClose={() => setSelectedProject(null)}
          onUpdate={loadDashboard}
          onConstructionUpdated={() => { void loadDashboard(); }}
          onMilestoneUpdated={() => { void loadDashboard(); }}
        />
      ) : null}

      {selectedTask ? (
        <ScheduleTaskDetail
          task={selectedTask}
          projects={projects}
          users={allUsers}
          members={taskMembers}
          workGroups={workGroups}
          activityLogs={activityLogs}
          weather={getTaskWeatherDisplay(selectedTask)}
          canMutate={canMutateTodos}
          actionPending={taskActionPending}
          onComplete={() => void completeSelectedTask()}
          onReschedule={openSelectedTaskForReschedule}
          onDelete={() => void deleteSelectedTask()}
          onClose={() => setSelectedTask(null)}
        />
      ) : null}

      {editingTask ? (
        <ScheduleTaskFormDialog
          initialData={editingTask}
          initialMemberIds={editingTaskMemberIds}
          onSubmit={updateSelectedTask}
          onCancel={() => { setEditingTask(null); setEditingTaskMemberIds([]); }}
          isSubmitting={taskActionPending}
        />
      ) : null}
    </div>
  );
}

function RecentReceiptList({
  groups,
  savingKey,
  canMutate,
  onOpen,
  onAddToSchedule,
}: {
  groups: RecentReceiptGroup[];
  savingKey: string | null;
  canMutate: boolean;
  onOpen: (group: RecentReceiptGroup) => void;
  onAddToSchedule: (group: RecentReceiptGroup) => void;
}) {
  if (groups.length === 0) return <EmptyState text="未來 14 天沒有需要提醒的收料" />;
  return (
    <div className="space-y-2">
      {groups.map(group => {
        const isSaving = savingKey === `receipt:${group.batch.id}`;
        const scheduled = Boolean(group.scheduleTaskId);
        return (
          <article key={group.batch.id} className={`rounded-xl border-l-4 bg-[var(--surface-secondary)] px-3 py-2.5 ${group.status === 'OVERDUE' ? 'border-danger' : 'border-accent'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${group.status === 'OVERDUE' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'}`}>
                    {group.status === 'OVERDUE' ? `逾期 ${group.overdueDays} 天` : '即將到貨'}
                  </span>
                  {group.isPartial ? <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-bold text-warning">部分到貨</span> : null}
                </div>
                <div className="mt-1 font-bold">{formatRecentReceiptDateTime(group.expectedDeliveryAt)}</div>
                <div className="mt-0.5 break-words text-sm font-semibold">{group.project.name}｜{group.batch.batch_name}｜{group.materials.length} 項</div>
              </div>
            </div>
            <div className="mt-1.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-secondary">
              <span className="min-w-0 truncate">{group.materials.slice(0, 2).map(formatMaterialReceiptSummary).join(' · ')}</span>
              {group.materials.length > 2 ? <span className="shrink-0 font-semibold text-primary/70">+{group.materials.length - 2}</span> : null}
            </div>
            <div className="mt-1.5 flex justify-end gap-2 border-t border-theme-border/60 pt-1.5">
              <button type="button" onClick={() => onOpen(group)} className="min-h-10 rounded-lg px-3 text-xs font-bold text-secondary transition hover:bg-page hover:text-primary">查看</button>
              <button
                type="button"
                onClick={() => onAddToSchedule(group)}
                disabled={!canMutate || scheduled || isSaving}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-bold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="animate-spin" size={14} /> : null}
                {scheduled ? '已加入排程' : isSaving ? '加入中…' : '加入排程'}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function MaintenanceList({
  tasks,
  projects,
  users,
  members,
  workGroups,
  filter,
  dateRange,
  onFilterChange,
  onDateRangeChange,
  onResetDateRange,
  onOpenTask,
}: {
  tasks: ScheduleTask[];
  projects: Project[];
  users: User[];
  members: ScheduleTaskMember[];
  workGroups: WorkGroup[];
  filter: MaintenanceScheduleFilter;
  dateRange: { start: string; end: string };
  onFilterChange: (filter: MaintenanceScheduleFilter) => void;
  onDateRangeChange: (range: { start: string; end: string }) => void;
  onResetDateRange: () => void;
  onOpenTask: (task: ScheduleTask) => void;
}) {
  return (
    <section className="rounded-2xl border border-theme-border bg-card/70 p-4 shadow-sm backdrop-blur-sm md:p-5 min-[1100px]:h-[calc(100%-8.5rem)] min-[1100px]:overflow-y-auto" role="tabpanel" aria-label="維修清單">
      <div className="flex flex-col gap-3 border-b border-theme-border pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent"><Wrench size={18} /></span>
            <div>
              <h2 className="text-lg font-bold">維修清單</h2>
              <p className="text-xs text-secondary">沿用工程排程資料，點選項目可開啟既有排程明細。</p>
            </div>
            <span className="rounded-full bg-page px-2 py-0.5 text-xs font-semibold text-secondary">{tasks.length}</span>
          </div>
        </div>
        <nav className="grid grid-cols-3 rounded-lg border border-theme-border bg-page p-1" aria-label="維修清單篩選" role="tablist">
          {MAINTENANCE_TABS.map(tab => (
            <button key={tab.key} type="button" role="tab" aria-selected={filter === tab.key} onClick={() => onFilterChange(tab.key)} className={`min-h-9 rounded-md px-4 text-sm font-bold transition ${filter === tab.key ? 'bg-accent text-white shadow-sm' : 'text-secondary hover:text-primary'}`}>
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-theme-border bg-page/45 p-3">
        <label className="text-xs font-medium text-secondary">起始日期
          <input type="date" value={dateRange.start} max={dateRange.end} onChange={event => onDateRangeChange({ ...dateRange, start: event.target.value })} className="mt-1 block h-9 rounded-lg border border-theme-border bg-card px-2 text-sm text-primary" />
        </label>
        <label className="text-xs font-medium text-secondary">結束日期
          <input type="date" value={dateRange.end} min={dateRange.start} onChange={event => onDateRangeChange({ ...dateRange, end: event.target.value })} className="mt-1 block h-9 rounded-lg border border-theme-border bg-card px-2 text-sm text-primary" />
        </label>
        <button type="button" onClick={onResetDateRange} className="h-9 rounded-lg border border-theme-border bg-card px-3 text-xs font-bold text-secondary transition hover:border-accent/50 hover:text-primary">預設兩週</button>
        <span className="pb-2 text-xs font-medium text-secondary">{dateRange.start.replaceAll('-', '/')}－{dateRange.end.replaceAll('-', '/')}</span>
      </div>

      {tasks.length === 0 ? <div className="mt-3"><EmptyState text={`目前沒有${MAINTENANCE_TABS.find(tab => tab.key === filter)?.label || ''}維修排程`} /></div> : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-theme-border">
          <div className="min-w-[64rem]">
            <div className="grid grid-cols-[9rem_minmax(10rem,1.1fr)_minmax(15rem,1.8fr)_9rem_minmax(10rem,1fr)_7rem] gap-3 bg-page px-4 py-2 text-xs font-bold text-secondary" aria-hidden="true">
              <span>日期／時間</span><span>案場</span><span>維修內容</span><span>主要負責人</span><span>協同</span><span>狀態</span>
            </div>
            <div className="divide-y divide-theme-border/70">
              {tasks.map(task => {
                const display = getScheduleTaskPresentation(task, projects, users, members, workGroups);
                const completed = isScheduleTaskCompleted(task);
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onOpenTask(task)}
                    className="grid w-full grid-cols-[9rem_minmax(10rem,1.1fr)_minmax(15rem,1.8fr)_9rem_minmax(10rem,1fr)_7rem] gap-3 px-4 py-3 text-left text-sm transition hover:bg-page/80 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/60"
                    aria-label={`查看維修排程：${display.projectName} ${task.title || ''}`}
                  >
                    <span><span className="block font-semibold">{task.task_date}</span><span className="text-xs text-secondary">{formatScheduleTaskTime(task)}</span></span>
                    <span className="truncate font-semibold">{display.projectName}</span>
                    <span className="truncate">{task.title?.trim() || task.description?.trim() || '—'}</span>
                    <span className="truncate">{display.mainAssigneeName || '未指定'}</span>
                    <span className="truncate text-secondary">{display.collaboratorNames.join('、') || '無'}</span>
                    <span className={`w-fit rounded-full px-2 py-1 text-xs font-bold ${completed ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'}`}>{completed ? '已完成' : (task.status || '未開始')}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DashboardSection({ icon, title, count, children, actionHref, actionLabel, headerAccessory, className = '' }: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  headerAccessory?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-theme-border bg-card/70 p-4 shadow-sm backdrop-blur-sm md:p-5 min-[1100px]:h-full min-[1100px]:min-h-0 min-[1100px]:overflow-y-auto ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">{icon}</span>
          <h2 className="font-bold">{title}</h2>
          <span className="rounded-full bg-page px-2 py-0.5 text-xs font-semibold text-secondary">{count}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerAccessory}
          {actionHref ? <a href={actionHref} className="text-xs font-semibold text-secondary transition hover:text-accent">{actionLabel} →</a> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-theme-border px-4 py-8 text-center text-sm text-secondary">{text}</div>;
}

function MobileTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`min-h-11 rounded-lg px-2 text-sm font-bold transition ${active ? 'bg-accent text-white shadow-sm' : 'text-secondary'}`}>
      {children}
    </button>
  );
}

function HideCompletedToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-theme-border bg-page/60 px-2 text-[11px] font-medium text-secondary transition hover:border-accent/40">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
      <span className="hidden sm:inline">隱藏已完成</span>
      <span className="sm:hidden">隱藏完成</span>
    </label>
  );
}

function TodoList({ actor, todos, emptyText, savingKey, onComplete, onEdit, onDelete, onSaved, disabled, secondary }: {
  actor: User | null;
  onSaved: () => Promise<void>;
  todos: Todo[];
  emptyText: string;
  savingKey: string | null;
  onComplete: (todo: Todo) => Promise<void>;
  onEdit: (todo: Todo) => void;
  onDelete: (todo: Todo) => Promise<void>;
  disabled?: boolean;
  secondary?: (todo: Todo) => string;
}) {
  const [menu, setMenu] = useState<{ todo: Todo; x: number; y: number } | null>(null);
  if (todos.length === 0) return <p className="py-4 text-center text-sm text-secondary">{emptyText}</p>;
  return (
    <div className="divide-y divide-theme-border/70">
      {todos.map(todo => {
        const detail = secondary?.(todo);
        const isCompleted = todo.status === '已完成';
        return (
          <TodoRow
            key={todo.id}
            todo={todo}
            menuDisabled={disabled || !canDeleteTodo(todo, actor)}
            onOpenMenu={point => setMenu({ todo, ...point })}
            statusControl={<button type="button" onClick={() => void onComplete(todo)} disabled={disabled || isCompleted || todo.status === '已收納' || savingKey === todo.id} aria-label={isCompleted ? `${todo.title} 已完成` : `完成 ${todo.title}`} className="shrink-0 rounded-full text-secondary transition hover:text-accent disabled:opacity-60">
              {savingKey === todo.id ? <Loader2 className="animate-spin" size={20} /> : isCompleted ? <CheckCircle2 className="text-accent" size={20} /> : <Circle size={20} />}
            </button>}
            title={
              <TodoInlineText todo={todo} onSaved={onSaved}/>
            }
            secondary={detail ? <span className="truncate">{detail}</span> : null}
            className="my-2 flex items-start gap-3 rounded-xl border border-[var(--warning)] bg-[var(--surface-secondary)] p-3 shadow-sm transition hover:border-[var(--accent)]"
          />
        );
      })}
      <TodoContextMenu
        point={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        actions={menu ? [
          { label: '編輯待辦', tone: 'accent', onSelect: () => onEdit(menu.todo) },
          { label: '刪除待辦', tone: 'danger', onSelect: () => void onDelete(menu.todo) },
        ] : []}
      />
    </div>
  );
}
