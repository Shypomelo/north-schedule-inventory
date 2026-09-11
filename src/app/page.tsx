"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { ArrowUpRight, BriefcaseBusiness, CalendarDays, CheckCircle2, Circle, ListTodo, Loader2, MapPin, Plus, Users } from 'lucide-react';
import { ProjectDetailModal } from '@/components/ProjectDetailModal';
import { ScheduleTaskDetail } from '@/components/ScheduleTaskDetail';
import { ScheduleTaskFormDialog } from '@/components/ScheduleTaskFormDialog';
import { useUser } from '@/components/UserContext';
import { dbAdapter } from '@/lib/db';
import type { MemberProjectResponsibility, Project, ScheduleTask, ScheduleTaskMember, Todo, WorkGroup } from '@/lib/db/types';
import { buildDashboardProjectCards } from '@/lib/engineering-dashboard';
import { formatScheduleTaskTime, selectTodayMemberSchedule } from '@/lib/schedule-selectors';
import { getScheduleTaskPresentation } from '@/lib/schedule-presentation';
import { useScheduleWeather } from '@/hooks/useScheduleWeather';
import {
  completeScheduleTaskWithActivity,
  confirmScheduleTaskDeletion,
  deleteScheduleTaskWithActivity,
  updateScheduleTaskWithActivity,
} from '@/lib/schedule-task-actions';

type MobileDashboardPage = 'schedule' | 'projects' | 'todos';
type MobileTodoPage = 'private' | 'team';

export default function EngineeringDashboardPage() {
  const { currentUser, allUsers } = useUser();
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [taskMembers, setTaskMembers] = useState<ScheduleTaskMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workGroups, setWorkGroups] = useState<WorkGroup[]>([]);
  const [responsibilities, setResponsibilities] = useState<MemberProjectResponsibility[]>([]);
  const [privateTodos, setPrivateTodos] = useState<Todo[]>([]);
  const [teamTodos, setTeamTodos] = useState<Todo[]>([]);
  const [privateTitle, setPrivateTitle] = useState('');
  const [teamTitle, setTeamTitle] = useState('');
  const [hideCompletedPrivate, setHideCompletedPrivate] = useState(true);
  const [hideCompletedTeam, setHideCompletedTeam] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<{ project: Project; milestoneId: string | null } | null>(null);
  const [selectedTask, setSelectedTask] = useState<ScheduleTask | null>(null);
  const [editingTask, setEditingTask] = useState<ScheduleTask | null>(null);
  const [editingTaskMemberIds, setEditingTaskMemberIds] = useState<string[]>([]);
  const [taskActionPending, setTaskActionPending] = useState(false);
  const [mobilePage, setMobilePage] = useState<MobileDashboardPage>('schedule');
  const [mobileTodoPage, setMobileTodoPage] = useState<MobileTodoPage>('private');
  const today = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);
  const canMutateTodos = Boolean(currentUser && currentUser.role !== 'VIEWER');

  const loadDashboard = useCallback(async () => {
    if (!currentUser) return;
    setError(null);
    try {
      const [taskRows, memberRows, projectRows, responsibilityRows, privateRows, teamRows, workGroupRows] = await Promise.all([
        dbAdapter.getScheduleTasks(),
        dbAdapter.getScheduleTaskMembers(),
        dbAdapter.getProjects(),
        dbAdapter.getMemberProjectResponsibilities(currentUser.id),
        dbAdapter.getPrivateTodos(),
        dbAdapter.getTodos(),
        dbAdapter.getWorkGroups(),
      ]);
      setTasks(taskRows);
      setTaskMembers(memberRows);
      setProjects(projectRows);
      setResponsibilities(responsibilityRows);
      setPrivateTodos(privateRows);
      setTeamTodos(teamRows);
      setWorkGroups(workGroupRows);
    } catch (loadError) {
      console.error('Dashboard load failed:', loadError);
      setError(loadError instanceof Error ? loadError.message : '工程儀表載入失敗');
    } finally {
      setIsLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) void loadDashboard();
  }, [currentUser, loadDashboard]);

  const todayTasks = useMemo(() => currentUser ? selectTodayMemberSchedule({
    tasks,
    members: taskMembers,
    memberId: currentUser.id,
    today,
  }) : [], [currentUser, taskMembers, tasks, today]);
  const getTaskWeatherDisplay = useScheduleWeather(todayTasks, projects);
  const projectCards = useMemo(
    () => buildDashboardProjectCards(responsibilities, today),
    [responsibilities, today],
  );
  const visiblePrivateTodos = privateTodos.filter(todo => !hideCompletedPrivate || todo.status !== '已完成');
  const visibleTeamTodos = teamTodos.filter(todo => !hideCompletedTeam || todo.status !== '已完成');

  const createPrivateTodo = async (event: FormEvent) => {
    event.preventDefault();
    const title = privateTitle.trim();
    if (!title || !currentUser || !canMutateTodos) return;
    setSavingKey('private-new');
    try {
      await dbAdapter.createPrivateTodo({ title, created_by: currentUser.id });
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

  const scheduleActor = { id: currentUser?.id, name: currentUser?.name };

  const completeSelectedTask = async () => {
    if (!selectedTask || !canMutateTodos) return;
    setTaskActionPending(true);
    try {
      await completeScheduleTaskWithActivity(selectedTask, scheduleActor);
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
      await updateScheduleTaskWithActivity({ task: editingTask, data, memberIds, actor: scheduleActor });
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
      await deleteScheduleTaskWithActivity(selectedTask, scheduleActor);
      setSelectedTask(null);
      await loadDashboard();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '排程刪除失敗');
    } finally {
      setTaskActionPending(false);
    }
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center gap-3 text-secondary"><Loader2 className="animate-spin" size={20} />載入工程儀表…</div>;
  }

  return (
    <div className="min-h-full bg-page px-4 py-5 text-primary md:px-6 md:py-7 xl:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-accent">Engineering overview</p>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">工程儀表</h1>
        </div>
        <div className="text-right">
          <div className="font-semibold">{format(new Date(), 'M月d日 EEEE', { locale: zhTW })}</div>
          <div className="mt-0.5 text-sm text-secondary">{currentUser?.name}</div>
        </div>
      </header>

      {error ? <div className="mb-5 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}

      <nav className="mb-4 grid grid-cols-3 rounded-xl border border-theme-border bg-card p-1 md:hidden" aria-label="工程儀表頁面" role="tablist">
        <MobileTab active={mobilePage === 'schedule'} onClick={() => setMobilePage('schedule')}>今日排程</MobileTab>
        <MobileTab active={mobilePage === 'projects'} onClick={() => setMobilePage('projects')}>專案進度</MobileTab>
        <MobileTab active={mobilePage === 'todos'} onClick={() => setMobilePage('todos')}>TODO</MobileTab>
      </nav>

      <div className="grid items-start gap-5 md:grid-cols-2 min-[1100px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)_minmax(0,0.9fr)]">
        <DashboardSection icon={<CalendarDays size={18} />} title="今日排程" count={todayTasks.length} actionHref="/schedule" actionLabel="查看排程" className={`${mobilePage === 'schedule' ? 'block' : 'hidden'} md:block min-[1100px]:sticky min-[1100px]:top-6`}>
          {todayTasks.length === 0 ? <EmptyState text="今天暫時沒有排程" /> : (
            <div className="space-y-2.5">
              {todayTasks.map(task => {
                const display = getScheduleTaskPresentation(task, projects, allUsers, taskMembers, workGroups);
                const weather = getTaskWeatherDisplay(task);
                const isDone = task.status === '完成' || task.status === '已完成';
                return (
                  <article
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看排程：${display.projectName}`}
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
                        <div className="truncate font-semibold">{display.projectName}</div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-accent">[{task.task_type}] {task.title || '無標題'}</span>
                          <span className="shrink-0 rounded-full border border-theme-border px-1.5 py-0.5 text-[10px] font-semibold text-secondary">{display.workGroupName}</span>
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-page px-2 py-1 text-xs font-semibold text-secondary">{formatScheduleTaskTime(task)}</span>
                    </div>
                    <div className="mt-2 min-w-0 text-xs leading-5 text-secondary">
                      <div className="truncate">{display.assigneeDisplay}</div>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{display.collaboratorDisplay || '協同：無'}</span>
                        <span className="shrink-0 whitespace-nowrap" aria-label={`天氣：${weather?.label || '無資料'}`}>
                          {weather ? `${weather.icon} ${weather.label}` : '天氣：—'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-theme-border/60 pt-2">
                      <a
                        href={display.mapUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                        className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-bold text-accent hover:bg-page"
                      >
                        <MapPin size={14} /> MAP
                      </a>
                      <span className="text-[11px] font-medium text-secondary">點擊查看完整資訊</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </DashboardSection>

        <DashboardSection icon={<BriefcaseBusiness size={18} />} title="我的專案進度" count={projectCards.length} className={`${mobilePage === 'projects' ? 'block' : 'hidden'} md:block`}>
          {projectCards.length === 0 ? <EmptyState text="目前沒有指派中的專案" /> : (
            <div className="space-y-3">
              {projectCards.map(card => {
                const fullProject = projects.find(project => project.id === card.project.id) ?? card.project;
                const milestoneTarget = [...card.progress]
                  .filter(group => group.current)
                  .sort((a, b) => (a.current?.planned_date || '9999').localeCompare(b.current?.planned_date || '9999'))[0]
                  ?.current?.id ?? null;
                return (
                  <button type="button" key={card.project.id} onClick={() => setSelectedProject({ project: fullProject, milestoneId: milestoneTarget })} className="group w-full rounded-xl border border-theme-border bg-[var(--surface-secondary)] p-4 text-left transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-bold">{card.project.name}</div>
                        {card.project.project_code ? <div className="mt-0.5 text-xs text-secondary">{card.project.project_code}</div> : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {card.isOverdue ? <span className="rounded-full bg-danger/10 px-2 py-1 text-[11px] font-bold text-danger">逾期</span> : null}
                        <ArrowUpRight className="text-secondary transition group-hover:text-accent" size={18} />
                      </div>
                    </div>
                    <div className="mt-3 divide-y divide-theme-border/70">
                      {card.progress.map(group => (
                        <div key={group.positionId} className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[5rem_1fr]">
                          <span className="text-xs font-bold text-secondary">{group.positionName}</span>
                          <div className="min-w-0 text-sm">
                            <div className="flex gap-2 text-secondary"><span className="shrink-0">前項</span><span className="truncate text-primary/70">{group.previous?.label || '—'}</span></div>
                            <div className="mt-1 flex gap-2"><span className="shrink-0 font-semibold text-accent">目前</span><span className="truncate font-semibold">{group.current?.label || '已完成'}</span></div>
                            <div className="mt-1 flex gap-2 text-secondary"><span className="shrink-0">預計</span><span className={group.current?.planned_date && group.current.planned_date < today ? 'font-semibold text-danger' : ''}>{group.current?.planned_date || '未設定'}</span></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </DashboardSection>

        <div className={`${mobilePage === 'todos' ? 'block' : 'hidden'} space-y-5 md:col-span-2 md:block min-[1100px]:col-span-1`}>
          <nav className="grid grid-cols-2 rounded-xl border border-theme-border bg-card p-1 md:hidden" aria-label="TODO 類型" role="tablist">
            <MobileTab active={mobileTodoPage === 'private'} onClick={() => setMobileTodoPage('private')}>我的</MobileTab>
            <MobileTab active={mobileTodoPage === 'team'} onClick={() => setMobileTodoPage('team')}>團隊</MobileTab>
          </nav>
          <DashboardSection icon={<ListTodo size={18} />} title="我的 TODO" count={visiblePrivateTodos.length} className={`${mobileTodoPage === 'private' ? 'block' : 'hidden'} md:block`}>
            <HideCompletedToggle checked={hideCompletedPrivate} onChange={setHideCompletedPrivate} />
            <TodoComposer value={privateTitle} onChange={setPrivateTitle} onSubmit={createPrivateTodo} placeholder="新增私人記事…" disabled={!canMutateTodos} isSaving={savingKey === 'private-new'} />
            <TodoList todos={visiblePrivateTodos} emptyText={hideCompletedPrivate ? '沒有未完成的私人記事' : '目前沒有私人記事'} savingKey={savingKey} onComplete={completePrivateTodo} disabled={!canMutateTodos} />
          </DashboardSection>

          <DashboardSection icon={<Users size={18} />} title="團隊 TODO" count={visibleTeamTodos.length} actionHref="/schedule" actionLabel="週排程待辦" className={`${mobileTodoPage === 'team' ? 'block' : 'hidden'} md:block`}>
            <HideCompletedToggle checked={hideCompletedTeam} onChange={setHideCompletedTeam} />
            <TodoComposer value={teamTitle} onChange={setTeamTitle} onSubmit={createTeamTodo} placeholder="新增團隊待辦…" disabled={!canMutateTodos} isSaving={savingKey === 'team-new'} />
            <TodoList
              todos={visibleTeamTodos}
              emptyText={hideCompletedTeam ? '目前沒有未完成的團隊待辦' : '目前沒有團隊待辦'}
              savingKey={savingKey}
              onComplete={completeTeamTodo}
              disabled={!canMutateTodos}
              secondary={todo => {
                const assignee = allUsers.find(user => user.id === todo.assigned_to);
                const project = projects.find(row => row.id === todo.project_id);
                return [project?.name, assignee ? `指派給 ${assignee.name}` : null].filter(Boolean).join(' · ');
              }}
            />
          </DashboardSection>
        </div>
      </div>

      {selectedProject ? (
        <ProjectDetailModal
          key={`${selectedProject.project.id}:${selectedProject.milestoneId || ''}`}
          project={selectedProject.project}
          initialMilestoneId={selectedProject.milestoneId}
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

function DashboardSection({ icon, title, count, children, actionHref, actionLabel, className = '' }: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-theme-border bg-card/70 p-4 shadow-sm backdrop-blur-sm md:p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">{icon}</span>
          <h2 className="font-bold">{title}</h2>
          <span className="rounded-full bg-page px-2 py-0.5 text-xs font-semibold text-secondary">{count}</span>
        </div>
        {actionHref ? <a href={actionHref} className="text-xs font-semibold text-secondary transition hover:text-accent">{actionLabel} →</a> : null}
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
    <label className="mb-3 flex min-h-10 cursor-pointer items-center justify-end gap-2 text-xs font-medium text-secondary">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
      隱藏已完成
    </label>
  );
}

function TodoComposer({ value, onChange, onSubmit, placeholder, disabled, isSaving }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  placeholder: string;
  disabled: boolean;
  isSaving: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="mb-3 flex items-center gap-2 border-b border-theme-border pb-3">
      <Plus size={17} className="shrink-0 text-accent" />
      <input value={value} onChange={event => onChange(event.target.value)} disabled={disabled || isSaving} placeholder={disabled ? '僅可檢視' : placeholder} aria-label={placeholder} className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-secondary/70 disabled:cursor-not-allowed" />
      <button type="submit" disabled={disabled || isSaving || !value.trim()} className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-accent-hover disabled:opacity-40">
        {isSaving ? <Loader2 className="animate-spin" size={14} /> : '新增'}
      </button>
    </form>
  );
}

function TodoList({ todos, emptyText, savingKey, onComplete, disabled, secondary }: {
  todos: Todo[];
  emptyText: string;
  savingKey: string | null;
  onComplete: (todo: Todo) => Promise<void>;
  disabled?: boolean;
  secondary?: (todo: Todo) => string;
}) {
  if (todos.length === 0) return <p className="py-4 text-center text-sm text-secondary">{emptyText}</p>;
  return (
    <div className="divide-y divide-theme-border/70">
      {todos.map(todo => {
        const detail = secondary?.(todo);
        const isCompleted = todo.status === '已完成';
        return (
          <div key={todo.id} className="flex items-start gap-3 py-3 first:pt-1 last:pb-0">
            <button type="button" onClick={() => void onComplete(todo)} disabled={disabled || isCompleted || savingKey === todo.id} aria-label={isCompleted ? `${todo.title} 已完成` : `完成 ${todo.title}`} className="mt-0.5 shrink-0 rounded-full text-secondary transition hover:text-accent disabled:opacity-60">
              {savingKey === todo.id ? <Loader2 className="animate-spin" size={20} /> : isCompleted ? <CheckCircle2 className="text-accent" size={20} /> : <Circle size={20} />}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`break-words text-sm font-medium leading-5 ${isCompleted ? 'text-secondary line-through' : ''}`}>{todo.title}</div>
              {detail ? <div className="mt-1 truncate text-xs text-secondary">{detail}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
