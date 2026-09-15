"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ActivityLog, ScheduleTask, ScheduleTaskMember, Project, User, Todo, TaskStatus, WorkGroup, WorkGroupKey } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { ScheduleTaskFormDialog } from '@/components/ScheduleTaskFormDialog';
import { ScheduleDeletedAuditDialog } from '@/components/ScheduleDeletedAuditDialog';
import { TodoForm } from '@/components/TodoForm';
import { TodoInlineText } from '@/components/TodoInlineText';
import { TodoContextMenu } from '@/components/TodoContextMenu';
import { TodoRow } from '@/components/TodoRow';
import { useWorkGroups } from '@/hooks/useWorkGroups';
import { requireTodoWorkGroup } from '@/lib/work-groups';
import { startOfWeek, endOfWeek, addDays, subDays, format, isSameDay, startOfMonth, endOfMonth } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, X, ArrowLeft, Maximize2, Minimize2, Trash2 } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { getDatabaseErrorMessage, isMissingCoreTablesError } from '@/lib/db/supabase-errors';
import { supabase } from '@/lib/db/supabaseClient';
import { formatScheduleTaskTime, selectScheduleTasksByWorkGroup, sortScheduleTasks } from '@/lib/schedule-selectors';
import { selectActiveTeamTodos } from '@/lib/todo-selectors';
import { type MemberWorkGroup, selectActiveWorkGroups } from '@/lib/work-groups';
import { getScheduleTaskPresentation } from '@/lib/schedule-presentation';
import { useScheduleWeather } from '@/hooks/useScheduleWeather';
import { canDeleteTodo } from '@/lib/todo-text-actions';
import {
  completeScheduleTaskWithActivity,
  confirmScheduleTaskDeletion,
  deleteScheduleTaskWithActivity,
  logScheduleTaskCreation,
  updateScheduleTaskWithActivity,
} from '@/lib/schedule-task-actions';
import {
  buildMonthScheduleWeeks,
  collapseExpandedMonthWeeks,
  toggleExpandedMonthWeek,
} from '@/lib/schedule-month-expand';

type ViewMode = 'week' | 'month';
type ScheduleFontSize = 'small' | 'medium' | 'large';

const SCHEDULE_FONT_SIZE_STORAGE_KEY = 'north-engineering-schedule-font-size';
const SCHEDULE_FONT_SIZE_CLASSES: Record<ScheduleFontSize, {
  month: string;
  primary: string;
  secondary: string;
  people: string;
  footer: string;
}> = {
  small: {
    month: 'text-[10px]',
    primary: 'text-xs',
    secondary: 'text-[11px]',
    people: 'text-[11px]',
    footer: 'text-[11px]',
  },
  medium: {
    month: 'text-xs',
    primary: 'text-[13px]',
    secondary: 'text-xs',
    people: 'text-xs',
    footer: 'text-xs',
  },
  large: {
    month: 'text-sm',
    primary: 'text-[15px]',
    secondary: 'text-sm',
    people: 'text-sm',
    footer: 'text-sm',
  },
};

type ReconcileResult = {
  success?: boolean;
  updated?: number;
  deleted?: number;
  imported?: number;
  skipped?: number;
  skipped_system_created?: number;
  skippedEvents?: { eventId: string; reason: string }[];
  unmatchedProjectImported?: number;
  unassignedMemberImported?: number;
  failed?: number;
  error?: string;
};

const RECONCILE_COOLDOWN_MS = 30000;
const DAILY_TASK_DISPLAY_LIMIT = 8;
let reconcileInFlight: Promise<ReconcileResult | null> | null = null;
let lastReconcileAt = 0;

const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === 'AbortError'
);

const sortTasks = sortScheduleTasks;
const formatTaskTime = formatScheduleTaskTime;

export default function SchedulePage() {
  const { currentUser } = useUser();
  const workspace = useWorkGroups();
  const [initializedMember, setInitializedMember] = useState<string>();
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [scheduleFontSize, setScheduleFontSize] = useState<ScheduleFontSize>('medium');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [isPresentationMode, setIsPresentationMode] = useState(false);
  const [expandedMonthWeeks, setExpandedMonthWeeks] = useState<Set<string>>(collapseExpandedMonthWeeks);
  const visibleMonthKey = format(currentDate, 'yyyy-MM');

  useEffect(() => {
    setExpandedMonthWeeks(collapseExpandedMonthWeeks());
  }, [viewMode, visibleMonthKey]);
  
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [members, setMembers] = useState<ScheduleTaskMember[]>([]);
  const [groupMemberships,setGroupMemberships]=useState<MemberWorkGroup[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [workGroups, setWorkGroups] = useState<WorkGroup[]>([]);
  const [activeWorkGroupKey, setActiveWorkGroupKey] = useState<WorkGroupKey | null>('ENGINEERING');
  useEffect(() => {
    if (workspace.ready && currentUser?.id !== initializedMember) {
      setActiveWorkGroupKey(workspace.defaultGroup?.key ?? null);
      setInitializedMember(currentUser?.id);
    }
  }, [workspace.ready, workspace.defaultGroup, currentUser?.id, initializedMember]);
  const [isLoading, setIsLoading] = useState(true);

  // Task Modal & Drawer State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Partial<ScheduleTask> | null>(null);
  const [editingTaskMembers, setEditingTaskMembers] = useState<string[]>([]);
  const [convertingTodoId, setConvertingTodoId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeletedAuditOpen, setIsDeletedAuditOpen] = useState(false);
  const [deletedAuditLogs, setDeletedAuditLogs] = useState<ActivityLog[]>([]);
  const [isDeletedAuditLoading, setIsDeletedAuditLoading] = useState(false);
  const [selectedDayTasks, setSelectedDayTasks] = useState<{date: Date, tasks: ScheduleTask[]} | null>(null);

  // Todo creation modal; existing Todo text stays inline.
  const [isTodoFormOpen, setIsTodoFormOpen] = useState(false);

  // Context Menu
  const [contextMenu, setContextMenu] = useState<{taskId: string, x: number, y: number} | null>(null);
  const [dayContextMenu, setDayContextMenu] = useState<{dateStr: string, x: number, y: number} | null>(null);
  const [todoContextMenu, setTodoContextMenu] = useState<{todoId: string | null, x: number, y: number} | null>(null);
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null);
      setDayContextMenu(null);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  useEffect(() => {
    const savedFontSize = window.localStorage.getItem(SCHEDULE_FONT_SIZE_STORAGE_KEY);
    if (savedFontSize === 'small' || savedFontSize === 'medium' || savedFontSize === 'large') {
      setScheduleFontSize(savedFontSize);
    }
  }, []);

  useEffect(() => {
    if (!isPresentationMode) return;
    const previousOverflow = document.body.style.overflow;
    const handlePresentationKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsPresentationMode(false);
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handlePresentationKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handlePresentationKeyDown);
    };
  }, [isPresentationMode]);

  const handleScheduleFontSizeChange = (fontSize: ScheduleFontSize) => {
    setScheduleFontSize(fontSize);
    window.localStorage.setItem(SCHEDULE_FONT_SIZE_STORAGE_KEY, fontSize);
  };

  const [error, setError] = useState<string | null>(null);

  const reconcileGoogleCalendar = useCallback(async () => {
    if (currentUser?.role?.toUpperCase() === 'VIEWER') return null;

    const now = Date.now();
    if (reconcileInFlight) return reconcileInFlight;
    if (now - lastReconcileAt < RECONCILE_COOLDOWN_MS) return null;

    const reconcilePromise = supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token) return;

      return fetch('/api/google-calendar/reconcile', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
    }).then(async response => {
      if (!response) return null;

      const result = await response.json().catch(() => null) as ReconcileResult | null;
      if (!response.ok) {
        throw new Error(result?.error || `Google Calendar reconcile failed (${response.status})`);
      }

      return result;
    }).catch((error: unknown) => {
      if (!isAbortError(error)) {
        console.error('Google Calendar reconcile failed:', error);
      }
      return null;
    }).finally(() => {
      lastReconcileAt = Date.now();
      reconcileInFlight = null;
    });

    reconcileInFlight = reconcilePromise;
    return reconcilePromise;
  }, [currentUser?.role]);

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    setError(null);
    try {
      // Add timeout to prevent infinite loading
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('讀取超時，請重試')), 10000)
      );

      const [t, m, p, u, td, wg, memberships] = await Promise.race([
        Promise.all([
          dbAdapter.getScheduleTasks().catch(e => { console.error('Schedule tasks error:', e); return []; }),
          dbAdapter.getScheduleTaskMembers().catch(e => { console.error('Schedule members error:', e); return []; }),
          dbAdapter.getProjects().catch(e => {
            console.error('Projects error:', e);
            if (isMissingCoreTablesError(e)) throw e;
            return [];
          }),
          dbAdapter.getUsers().catch(e => { console.error('Users error:', e); return []; }),
          dbAdapter.getWorkGroups().then(groups => Promise.all(selectActiveWorkGroups(groups).map(group => dbAdapter.getTodos(group.id)))).then(rows => rows.flat()).catch(e => { console.error('Todos error:', e); return []; }),
          dbAdapter.getWorkGroups(),
          dbAdapter.getMemberWorkGroups()
        ]),
        timeoutPromise
      ]) as [ScheduleTask[], ScheduleTaskMember[], Project[], User[], Todo[], WorkGroup[],MemberWorkGroup[]];

      setTasks(t);
      setMembers(m);
      setProjects(p);
      setUsers(u);
      setTodos(td);
      setWorkGroups(selectActiveWorkGroups(wg));
      setGroupMemberships(memberships);

      if (showLoading) setIsLoading(false);

      if (showLoading) {
        reconcileGoogleCalendar().then((res: any) => {
          if (res?.updated || res?.deleted || res?.imported) {
            fetchData(false); // Silently refresh data
          }
        });
      }
    } catch (err: any) {
      console.error('Fetch data failed:', err);
      setError(getDatabaseErrorMessage(err, '無法載入排程資料'));
      if (showLoading) setIsLoading(false);
    }
  }, [reconcileGoogleCalendar]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeWorkGroup = workGroups.find(group => group.key === activeWorkGroupKey);
  const activeTeamTodos = useMemo(
    () => selectActiveTeamTodos(todos, activeWorkGroup?.id ?? null),
    [activeWorkGroup?.id, todos],
  );
  const groupTasks = useMemo(
    () => selectScheduleTasksByWorkGroup(tasks, activeWorkGroup?.id,{members,users,memberships:groupMemberships,groups:workGroups}),
    [activeWorkGroup?.id, tasks,members,users,groupMemberships,workGroups],
  );

  useEffect(() => {
    setSelectedDayTasks(null);
  }, [activeWorkGroupKey]);

  // Week View Dates
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 }); 
  const weekDays = Array.from({ length: 6 }).map((_, i) => addDays(weekStart, i));

  // Month View Dates
  const calendarStart = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
  const calendarEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
  const monthDays: Date[] = [];
  let d = calendarStart;
  while (d <= calendarEnd) {
    monthDays.push(d);
    d = addDays(d, 1);
  }
  const monthWeeks = buildMonthScheduleWeeks(monthDays);
  const expandedMonthWeekDetails = monthWeeks.filter(week => expandedMonthWeeks.has(week.key));
  const monthGridTemplateRows = monthWeeks.flatMap(week => [
    expandedMonthWeeks.has(week.key) ? 'auto' : 'minmax(160px, 1fr)',
    'auto',
  ]).join(' ');
  const fontSizeClasses = SCHEDULE_FONT_SIZE_CLASSES[scheduleFontSize];

  const visibleWeatherTasks = useMemo(() => {
    const visibleTasks = selectedDayTasks ? [...selectedDayTasks.tasks] : [];
    if (viewMode === 'month' && expandedMonthWeekDetails.length > 0) {
      for (const week of expandedMonthWeekDetails) {
        for (const day of week.scheduleDays) {
          const dateStr = format(day, 'yyyy-MM-dd');
          visibleTasks.push(...sortTasks(groupTasks.filter(task => task.task_date === dateStr)).slice(0, DAILY_TASK_DISPLAY_LIMIT));
        }
      }
      return visibleTasks;
    }
    if (viewMode !== 'week') return visibleTasks;

    const visibleWeekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    for (let index = 0; index < 6; index += 1) {
      const dateStr = format(addDays(visibleWeekStart, index), 'yyyy-MM-dd');
      visibleTasks.push(...sortTasks(groupTasks.filter(task => task.task_date === dateStr)).slice(0, DAILY_TASK_DISPLAY_LIMIT));
    }
    return visibleTasks;
  }, [currentDate, expandedMonthWeekDetails, groupTasks, selectedDayTasks, viewMode]);

  const getTaskWeatherDisplay = useScheduleWeather(visibleWeatherTasks, projects);

  const buildMemberRows = (taskId: string, userIds: string[]): ScheduleTaskMember[] => (
    userIds.map(userId => ({
      id: `${taskId}:${userId}`,
      task_id: taskId,
      user_id: userId,
      created_at: new Date().toISOString(),
    }))
  );

  const replaceTaskMembers = (taskId: string, userIds: string[]) => {
    setMembers(prev => [
      ...prev.filter(member => member.task_id !== taskId),
      ...buildMemberRows(taskId, userIds),
    ]);
  };

  const getTaskMemberIds = (taskId: string) => (
    members.filter(member => member.task_id === taskId).map(member => member.user_id)
  );

  const openDeletedAudit = async () => {
    if (currentUser?.role !== 'ADMIN') return;
    setIsDeletedAuditOpen(true);
    setIsDeletedAuditLoading(true);
    try {
      setDeletedAuditLogs(await dbAdapter.getScheduleDeletedActivityLogs());
    } catch (auditError) {
      console.error('讀取排程刪除紀錄失敗', auditError);
      setDeletedAuditLogs([]);
    } finally {
      setIsDeletedAuditLoading(false);
    }
  };

  const handleCreateOrUpdateTask = async (data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>, newMemberIds: string[]) => {
    setIsSubmitting(true);
    try {
      const sourceTodoId = convertingTodoId || (editingTask as ScheduleTask)?.source_todo_id;

      if (editingTask?.id) {
        const originalTask = tasks.find(t => t.id === editingTask.id);
        if (!originalTask) throw new Error('找不到要更新的排程');
        const safeData = { ...data, work_group_id: originalTask.work_group_id };
        // Optimistic Update
        setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...safeData, updated_at: new Date().toISOString() } as ScheduleTask : t));
        
        try {
          await updateScheduleTaskWithActivity({
            task: originalTask,
            data: safeData,
            memberIds: newMemberIds,
            previousMemberIds: editingTaskMembers,
            actor: { id: currentUser?.id, name: currentUser?.name },
            auditContext: { projects, users },
          });
          replaceTaskMembers(editingTask.id, newMemberIds);
        } catch (error) {
          console.error('Update failed, rolling back:', error);
          alert('排程更新失敗，請檢查網路連線或稍後再試。');
          if (originalTask) {
            setTasks(prev => prev.map(t => t.id === editingTask.id ? originalTask : t));
          }
          replaceTaskMembers(editingTask.id, editingTaskMembers);
          throw error;
        }
      } else {
        const targetWorkGroup = convertingTodoId
          ? workGroups.find(group => group.id === requireTodoWorkGroup(todos.find(todo => todo.id === convertingTodoId)!))
          : activeWorkGroup;
        if (!targetWorkGroup) throw new Error('找不到排程群組');
        const payload = {
          ...data,
          work_group_id: targetWorkGroup.id,
          source_todo_id: convertingTodoId,
        };
        
        // Optimistic Create
        const tempId = `temp-${Date.now()}`;
        const tempTask = { ...payload, id: tempId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as ScheduleTask;
        setTasks(prev => [...prev, tempTask]);
        
        try {
          const newTask = await dbAdapter.createScheduleTask(payload, newMemberIds);
          
          // Replace temp with real
          setTasks(prev => prev.map(t => t.id === tempId ? newTask : t));
          replaceTaskMembers(newTask.id, newMemberIds);

          await logScheduleTaskCreation(
            newTask,
            { id: currentUser?.id, name: currentUser?.name },
            { projects, users, memberIds: newMemberIds },
          );

          if (convertingTodoId) {
            await dbAdapter.updateTodo(convertingTodoId, { status: '已排程', converted_task_id: newTask.id });
            setTodos(prev => prev.map(todo => todo.id === convertingTodoId
              ? { ...todo, status: '已排程', converted_task_id: newTask.id }
              : todo));
            await dbAdapter.logActivity({
              actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
              action_type: 'TODO_TO_TASK', target_type: 'Todo', target_id: convertingTodoId, target_label: data.title,
              project_id: data.project_id, project_name: '', before_value: '待安排', after_value: '已排程', message: '待辦轉排程'
            });
          }
        } catch (error) {
          console.error('Create failed, rolling back:', error);
          alert('排程建立失敗，請檢查網路連線或稍後再試。');
          setTasks(prev => prev.filter(t => t.id !== tempId));
          throw error;
        }
      }

      if (data.status === '完成' && sourceTodoId) {
        await dbAdapter.updateTodo(sourceTodoId, { status: '已完成' });
      }

      setIsFormOpen(false);
      setEditingTask(null);
      setEditingTaskMembers([]);
      setConvertingTodoId(null);
      // Fetch data silently in background
      fetchData(false);

      if (selectedDayTasks) {
        // ... (This will be updated implicitly when tasks state changes or via fetchData)
        const freshTasks = await dbAdapter.getScheduleTasks();
        const dateStr = format(selectedDayTasks.date, 'yyyy-MM-dd');
        setSelectedDayTasks({
          date: selectedDayTasks.date,
            tasks: sortTasks(selectScheduleTasksByWorkGroup(freshTasks,activeWorkGroup?.id,{members,users,memberships:groupMemberships,groups:workGroups}).filter(t => t.task_date === dateStr))
        });
      }

    } catch (e) {
      console.error('儲存失敗', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReturnToTodo = async (task: ScheduleTask) => {
    try {
      setTasks(prev => prev.filter(t => t.id !== task.id));
      if (task.source_todo_id) {
        setTodos(prev => prev.map(t => t.id === task.source_todo_id ? { ...t, status: '待安排' } : t));
        await dbAdapter.deleteScheduleTask(task.id);
        await dbAdapter.updateTodo(task.source_todo_id, { status: '待安排', converted_task_id: null });
      } else {
        const newTodo = await dbAdapter.createTodo({
           title: task.title,
           content: task.description || null,
           project_id: task.project_id,
           task_type: task.task_type,
           status: '待安排',
           scope: 'TEAM',
           work_group_id: task.work_group_id,
           converted_task_id: null,
           created_by: currentUser?.id || null,
           assigned_to: null,
           assigned_by: null,
           rejected_by: null,
           rejected_at: null,
           rejection_reason: null,
        });
        setTodos(prev => [newTodo, ...prev]);
        await dbAdapter.deleteScheduleTask(task.id);
      }
      
      await dbAdapter.logActivity({
        actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
        action_type: 'TASK_TO_TODO', target_type: 'ScheduleTask', target_id: task.id, target_label: task.title,
        project_id: task.project_id, project_name: '', before_value: null, after_value: null, message: '排程退回待辦'
      });

      await fetchData(false);
      if (selectedDayTasks) {
        setSelectedDayTasks(prev => prev ? { ...prev, tasks: prev.tasks.filter(t => t.id !== task.id) } : null);
      }
    } catch(err) {
      console.error('退回失敗', err);
    }
  };

  const handleDropToTodo = async (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const dataStr = e.dataTransfer.getData('application/x-schedule-item') || e.dataTransfer.getData('text/plain');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      const { dragId, dragType } = data;
      
      if (dragType !== 'task') return;
      const task = tasks.find(t => t.id === dragId);
      if (!task) return;
      await handleReturnToTodo(task);
    } catch(err) {
      console.error(err);
    }
  };

  const handleCreateTodo = async (data: Omit<Todo, 'id' | 'created_at' | 'updated_at'>) => {
    setIsSubmitting(true);
    try {
      const newTodo = await dbAdapter.createTodo(data);
      await dbAdapter.logActivity({
        actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
        action_type: 'CREATE_TODO', target_type: 'Todo', target_id: newTodo.id, target_label: data.title,
        project_id: data.project_id, project_name: '', before_value: null, after_value: null, message: '新增待辦'
      });
      setIsTodoFormOpen(false);
      await fetchData(false);
    } catch (e) {
      console.error('儲存失敗', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteTodo = async (todo: Todo) => {
    if (!canDeleteTodo(todo, currentUser) || !window.confirm(`確定要刪除「${todo.title}」嗎？`)) return;
    setIsSubmitting(true);
    try {
      await dbAdapter.deleteTodo(todo.id);
      await fetchData(false);
    } catch (deleteError) {
      console.error('刪除待辦失敗', deleteError);
      setError('待辦刪除失敗，請重新整理後重試');
    } finally { setIsSubmitting(false); }
  };

  const handleDragStart = (e: React.DragEvent, id: string, type: 'task' | 'todo') => {
    const data = JSON.stringify({ dragId: id, dragType: type });
    e.dataTransfer.setData('application/x-schedule-item', data);
    e.dataTransfer.setData('text/plain', data);
    e.dataTransfer.effectAllowed = 'move';
  };

  const openTodoConvertForm = (todo: Todo, dateStr: string) => {
    const sourceWorkGroup = workGroups.find(group => group.id === todo.work_group_id);
    if (!sourceWorkGroup) return;
    setConvertingTodoId(todo.id);
    setEditingTask({
      work_group_id: requireTodoWorkGroup(todo),
      title: todo.title,
      description: todo.content,
      project_id: todo.project_id,
      task_type: todo.task_type || '維修',
      task_date: dateStr
    });
    setEditingTaskMembers([]);
    setIsFormOpen(true);
  };

  const handleDropToDate = async (e: React.DragEvent, dateStr: string) => {
    e.preventDefault();
    try {
      const dataStr = e.dataTransfer.getData('application/x-schedule-item') || e.dataTransfer.getData('text/plain');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      const { dragId, dragType } = data;
      
      if (!dragId || !dragType) return;

      if (dragType === 'task') {
        const task = tasks.find(t => t.id === dragId);
        if (!task || task.task_date === dateStr) return;
        
        const originalDate = task.task_date;
        
        // Optimistic UI Update: Move immediately
        setTasks(prev => prev.map(t => t.id === dragId ? { ...t, task_date: dateStr } : t));
        
        try {
          const taskMemberIds = members.filter(member => member.task_id === task.id).map(member => member.user_id);
          await updateScheduleTaskWithActivity({
            task,
            data: {...task,task_date:dateStr},
            memberIds: taskMemberIds,
            previousMemberIds: taskMemberIds,
            actionType: 'DRAG_MOVE_TASK',
            actor: {id:currentUser?.id,name:currentUser?.name},
            auditContext: { projects, users },
          });
          // Optimistic update succeeded, we can fetch later silently
          fetchData(false);
        } catch (error) {
          console.error('Update failed, rolling back:', error);
          alert('排程更新失敗，請檢查網路連線或稍後再試。');
          // Rollback
          setTasks(prev => prev.map(t => t.id === dragId ? { ...t, task_date: originalDate } : t));
        }

        if (selectedDayTasks) {
          const freshTasks = await dbAdapter.getScheduleTasks();
          setSelectedDayTasks(prev => prev ? {
            date: prev.date,
            tasks: sortTasks(selectScheduleTasksByWorkGroup(freshTasks,activeWorkGroup?.id,{members,users,memberships:groupMemberships,groups:workGroups}).filter(t => t.task_date === format(prev.date, 'yyyy-MM-dd')))
          } : null);
        }
      } else if (dragType === 'todo') {
        const todo = todos.find(t => t.id === dragId);
        if (!todo) return;
        openTodoConvertForm(todo, dateStr);
      }
    } catch(err) { console.error('Drop error', err); }
  };

  const handleContextMenu = (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDayContextMenu(null);
    setTodoContextMenu(null);
    setContextMenu({ taskId, x: e.clientX, y: e.clientY });
  };

  const handleContextAction = async (e: React.MouseEvent, action: 'RESCHEDULE_TASK' | 'COMPLETE_TASK' | 'DELETE_TASK') => {
    e.stopPropagation();
    if (!contextMenu) return;
    const currentTaskId = contextMenu.taskId;
    setContextMenu(null);

    const task = tasks.find(t => t.id === currentTaskId);
    if (!task) return;

    try {
      if (action === 'RESCHEDULE_TASK') {
        setEditingTask(task);
        setEditingTaskMembers(members.filter(member => member.task_id === task.id).map(member => member.user_id));
        setIsFormOpen(true);
        return;
      } else if (action === 'COMPLETE_TASK') {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: '完成' } : t));
        if (task.source_todo_id) setTodos(prev => prev.map(td => td.id === task.source_todo_id ? { ...td, status: '已完成' } : td));
        await completeScheduleTaskWithActivity(task, { id: currentUser?.id, name: currentUser?.name }, {
          projects,
          users,
          memberIds: getTaskMemberIds(task.id),
        });
      } else if (action === 'DELETE_TASK') {
        if (!confirmScheduleTaskDeletion()) return;
        setTasks(prev => prev.filter(t => t.id !== task.id));
        await deleteScheduleTaskWithActivity(task, { id: currentUser?.id, name: currentUser?.name }, {
          projects,
          users,
          memberIds: getTaskMemberIds(task.id),
        });
      }
      await fetchData(false);
      if (selectedDayTasks) {
        const freshTasks = await dbAdapter.getScheduleTasks();
        setSelectedDayTasks(prev => prev ? {
          date: prev.date,
          tasks: sortTasks(selectScheduleTasksByWorkGroup(freshTasks,activeWorkGroup?.id,{members,users,memberships:groupMemberships,groups:workGroups}).filter(t => t.task_date === format(prev.date, 'yyyy-MM-dd')))
        } : null);
      }
    } catch(err) {
      console.error(err);
    }
  };

  const getTaskDisplay = (task: ScheduleTask) => {
    const display = getScheduleTaskPresentation(task, projects, users, members);
    return {
      projName: display.projectName,
      cardDetail: display.cardDetail,
      assigneeDisplay: display.assigneeDisplay,
      coworkerDisplay: display.collaboratorDisplay,
      district: display.district,
      searchAddress: display.searchAddress,
      mapUrl: display.mapUrl,
    };
  };

  const renderWeeklySchedule = (days: Date[], includeTodoColumn: boolean, presentationMode = false) => {
    const displayFontSizeClasses = presentationMode ? {
      primary: 'text-[clamp(1rem,1.35vw,1.75rem)] leading-[clamp(1.35rem,1.8vw,2.2rem)]',
      secondary: 'text-[clamp(0.9rem,1.12vw,1.4rem)] leading-[clamp(1.2rem,1.5vw,1.8rem)]',
      people: 'text-[clamp(0.82rem,0.98vw,1.2rem)] leading-[clamp(1.1rem,1.3vw,1.55rem)]',
      footer: 'text-[clamp(0.78rem,0.88vw,1.05rem)] leading-[clamp(1rem,1.15vw,1.35rem)]',
    } : fontSizeClasses;
    return (
    <div
      data-schedule-presentation={presentationMode || undefined}
      className={`grid ${presentationMode ? 'h-full min-w-[72rem] border-0' : 'min-w-[72rem] rounded-xl border'} ${includeTodoColumn ? 'grid-cols-7 flex-1' : 'grid-cols-6'} border-[var(--border)] bg-[var(--surface)] overflow-hidden`}
    >
      {days.map(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const dayTasks = sortTasks(groupTasks.filter(task => task.task_date === dateStr));
        const displayTasks = presentationMode ? dayTasks : dayTasks.slice(0, DAILY_TASK_DISPLAY_LIMIT);
        const hiddenCount = presentationMode ? 0 : dayTasks.length - DAILY_TASK_DISPLAY_LIMIT;

        return (
          <div
            key={dateStr}
            className="min-h-0 border-r border-[var(--border)] flex flex-col"
            onDragOver={presentationMode ? undefined : event => event.preventDefault()}
            onDrop={presentationMode ? undefined : event => handleDropToDate(event, dateStr)}
            onContextMenu={presentationMode ? undefined : event => {
              event.preventDefault();
              if (currentUser?.role === 'VIEWER') return;
              setContextMenu(null);
              setTodoContextMenu(null);
              setDayContextMenu({ dateStr, x: event.clientX, y: event.clientY });
            }}
          >
            <div
              className={`text-center border-b border-[var(--border)] font-semibold ${presentationMode ? 'cursor-default py-[clamp(0.75rem,1.25vh,1.5rem)]' : 'cursor-pointer py-3 hover:bg-[var(--surface-secondary)] transition'} ${isSameDay(day, new Date()) ? 'text-[var(--accent)] bg-[var(--surface-secondary)]' : 'text-[var(--text-primary)]'}`}
              onClick={presentationMode ? undefined : () => setSelectedDayTasks({ date: day, tasks: dayTasks })}
            >
              <div className={presentationMode ? 'text-[clamp(1rem,1.3vw,1.65rem)] leading-tight' : 'text-sm'}>週{['日','一','二','三','四','五','六'][day.getDay()]}</div>
              <div className={presentationMode ? 'text-[clamp(1.8rem,2.75vw,3.5rem)] leading-none' : 'text-xl'}>{format(day, 'd')}</div>
            </div>
            <div className={`flex-1 min-h-0 flex flex-col overflow-y-auto ${presentationMode ? 'gap-[clamp(0.65rem,0.8vw,1.25rem)] p-[clamp(0.65rem,0.85vw,1.25rem)]' : 'gap-2 p-2'}`}>
              {displayTasks.map(task => {
                const { projName, cardDetail, assigneeDisplay, coworkerDisplay, mapUrl } = getTaskDisplay(task);
                const weatherDisplay = getTaskWeatherDisplay(task);
                const primaryLabel = [projName, formatTaskTime(task)].filter(Boolean).join(' ');
                const isDone = task.status === '完成' || task.status === '已完成';
                const isRescheduled = task.status === '改期';

                return (
                  <div
                    key={task.id}
                    draggable={!presentationMode && currentUser?.role !== 'VIEWER'}
                    onDragStart={presentationMode ? undefined : event => handleDragStart(event, task.id, 'task')}
                    onContextMenu={presentationMode ? undefined : event => {
                      if (currentUser?.role === 'VIEWER') return;
                      handleContextMenu(event, task.id);
                    }}
                    onClick={presentationMode ? undefined : () => {
                      setEditingTask(task);
                      setEditingTaskMembers(members.filter(member => member.task_id === task.id).map(member => member.user_id));
                      setIsFormOpen(true);
                    }}
                    className={`shrink-0 rounded border shadow-sm ${presentationMode ? 'cursor-default rounded-[clamp(0.5rem,0.65vw,0.9rem)] p-[clamp(0.7rem,0.9vw,1.35rem)]' : 'cursor-pointer p-2 transition transform hover:scale-[1.02] active:scale-95'} ${
                      isDone ? 'bg-[var(--surface-secondary)] border-[var(--border)] opacity-50' :
                      isRescheduled ? 'bg-[var(--surface-secondary)] border-dashed border-[var(--text-muted)] opacity-60' :
                      task.is_tentative ? 'bg-[var(--surface-secondary)] border-[var(--warning)]' :
                      'bg-[var(--surface-secondary)] border-[var(--accent)]'
                    }`}
                  >
                    {primaryLabel && <div className={`${displayFontSizeClasses.primary} font-semibold ${presentationMode ? 'whitespace-normal break-words' : 'truncate'} ${isDone || isRescheduled ? 'text-[var(--text-muted)]' : task.is_tentative ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]'}`}>
                      {isDone ? '✓ ' : ''}{isRescheduled ? '【改期】 ' : ''}{task.is_tentative ? '[暫] ' : ''}{primaryLabel}
                    </div>}
                    {cardDetail && <div className={`${displayFontSizeClasses.secondary} mt-0.5 font-bold ${presentationMode ? 'whitespace-normal break-words' : 'truncate'} ${isDone || isRescheduled ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}`}>
                      {cardDetail}
                    </div>}
                    {(assigneeDisplay || coworkerDisplay) && (
                      <div className={`${displayFontSizeClasses.people} mt-0.5 space-y-0.5 ${isDone || isRescheduled ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>
                        {assigneeDisplay && <div className={presentationMode ? 'whitespace-normal break-words' : 'truncate'}>{assigneeDisplay}</div>}
                        {coworkerDisplay && <div className={presentationMode ? 'whitespace-normal break-words' : 'truncate'}>{coworkerDisplay}</div>}
                      </div>
                    )}
                    {((!presentationMode && mapUrl) || weatherDisplay) && <div className={`${displayFontSizeClasses.footer} mt-1 flex items-center justify-between gap-2`}>
                      {!presentationMode && mapUrl ? <a
                        href={mapUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={event => event.stopPropagation()}
                        className="underline font-bold text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                      >
                        MAP
                      </a> : null}
                      {weatherDisplay && (
                        <span
                          className="text-[var(--text-secondary)] whitespace-nowrap"
                          title={weatherDisplay.label}
                          aria-label={`天氣：${weatherDisplay.label}`}
                        >
                          {weatherDisplay.icon}<span className="hidden 2xl:inline"> {weatherDisplay.label}</span>
                        </span>
                      )}
                    </div>}
                  </div>
                );
              })}
              {hiddenCount > 0 && (
                <div
                  className="shrink-0 text-center text-xs font-bold text-[var(--text-muted)] hover:text-[var(--accent)] cursor-pointer mt-1"
                  onClick={() => setSelectedDayTasks({ date: day, tasks: dayTasks })}
                >
                  +{hiddenCount} 筆
                </div>
              )}
            </div>
          </div>
        );
      })}

      {includeTodoColumn && (
        <div
          className="flex flex-col min-h-[400px] bg-[var(--surface-secondary)] relative overflow-hidden flex-1"
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
          onDrop={handleDropToTodo}
          onContextMenu={event => {
            event.preventDefault();
            if (currentUser?.role === 'VIEWER') return;
            if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('flex-1')) {
              setContextMenu(null);
              setDayContextMenu(null);
              setTodoContextMenu({ todoId: null, x: event.clientX, y: event.clientY });
            }
          }}
        >
          <div className="text-center py-3 border-b border-[var(--border)] font-bold text-[var(--warning)] bg-[var(--surface)] flex justify-between items-center px-4 shrink-0">
            <span>待辦事項</span>
            <button onClick={() => setIsTodoFormOpen(true)} disabled={currentUser?.role === 'VIEWER'} className="hover:bg-[var(--surface-secondary)] p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed" title="新增待辦"><Plus size={16}/></button>
          </div>
          <div className="flex-1 p-2 flex flex-col gap-2 overflow-y-auto">
            {activeTeamTodos.map(todo => {
              const project = projects.find(candidate => candidate.id === todo.project_id);
              const projectName = project?.short_name || project?.name || '未指定案場';

              return (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  draggable={currentUser?.role !== 'VIEWER'}
                  onDragStart={event => handleDragStart(event, todo.id, 'todo')}
                  menuDisabled={currentUser?.role === 'VIEWER'}
                  menuButtonClassName="mt-1 ml-auto flex min-h-10 min-w-10 items-center justify-center rounded text-lg disabled:opacity-50 md:hidden"
                  onOpenMenu={point => {
                    setContextMenu(null);
                    setDayContextMenu(null);
                    setTodoContextMenu({ todoId: todo.id, ...point });
                  }}
                  className="cursor-grab rounded-xl border border-[var(--warning)] bg-[var(--surface-secondary)] p-2 shadow-sm transition hover:border-[var(--accent)] hover:bg-[var(--surface)]"
                  content={<TodoInlineText todo={todo} onSaved={async()=>{await fetchData(false);}} display={<>
                    <span className="block truncate text-xs font-semibold text-amber-300">{projectName}</span>
                    <span className="mt-1 block truncate text-xs font-bold text-[var(--accent)]">[{todo.task_type || '未分類'}]</span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--text-primary)]">{todo.title}</span>
                  </>}/>}
                />
              );
            })}
            {activeTeamTodos.length === 0 && (
              <div className="text-xs text-[var(--text-muted)] text-center mt-4">無待辦事項</div>
            )}
          </div>
        </div>
      )}
    </div>
    );
  };

  return (
    <div className="mx-auto flex h-full min-w-0 flex-col p-3 sm:p-5 lg:p-8">
      <div data-schedule-toolbar className="mb-3 flex flex-wrap items-center gap-2 lg:mb-4">
          <h1 className="mr-1 w-full text-2xl font-bold text-[var(--text-primary)] sm:w-auto sm:text-3xl">排程管理</h1>

          {!workspace.configurationRequired && <div className="flex shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1" role="tablist" aria-label="排程群組">
            {workGroups.filter(group => group.key === 'ENGINEERING' || group.key === 'PROJECT').map(group => (
              <button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={activeWorkGroupKey === group.key}
                onClick={() => setActiveWorkGroupKey(group.key)}
                className={`min-h-9 rounded-md px-3 py-1.5 text-sm font-semibold transition ${activeWorkGroupKey === group.key ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >
                {group.key === 'ENGINEERING' ? '工程排程' : '專案排程'}
              </button>
            ))}
          </div>}
          
          <div className="flex shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
            <button 
              onClick={() => {
                setViewMode('week');
                setExpandedMonthWeeks(collapseExpandedMonthWeeks());
              }}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${viewMode === 'week' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              週檢視
            </button>
            <button 
              onClick={() => {
                setViewMode('month');
                setExpandedMonthWeeks(collapseExpandedMonthWeeks());
              }}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${viewMode === 'month' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              月檢視
            </button>
          </div>

          <div className="flex shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
            <span className="px-2 text-xs font-semibold text-[var(--text-secondary)]">字體</span>
            {([
              ['small', '小'],
              ['medium', '中'],
              ['large', '大'],
            ] as const).map(([size, label]) => (
              <button
                key={size}
                type="button"
                onClick={() => handleScheduleFontSizeChange(size)}
                aria-pressed={scheduleFontSize === size}
                className={`px-3 py-1.5 text-sm font-semibold rounded-md transition ${scheduleFontSize === size ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
            <button 
              onClick={() => {
                setCurrentDate(viewMode === 'week' ? subDays(currentDate, 7) : addDays(currentDate, -30));
                if (viewMode === 'month') setExpandedMonthWeeks(collapseExpandedMonthWeeks());
              }}
              className="p-1 hover:bg-[var(--surface-secondary)] rounded text-[var(--text-primary)]"
            >
              <ChevronLeft size={20}/>
            </button>
            <span className="min-w-[130px] px-1 text-center text-xs font-semibold text-[var(--text-primary)] sm:min-w-[160px] sm:px-2 sm:text-sm">
              {viewMode === 'week' ? 
                `${format(weekStart, 'yyyy/MM/dd')} - ${format(addDays(weekStart, 5), 'yyyy/MM/dd')}` : 
                format(currentDate, 'yyyy 年 MM 月')}
            </span>
            <button 
              onClick={() => {
                setCurrentDate(viewMode === 'week' ? addDays(currentDate, 7) : addDays(currentDate, 30));
                if (viewMode === 'month') setExpandedMonthWeeks(collapseExpandedMonthWeeks());
              }}
              className="p-1 hover:bg-[var(--surface-secondary)] rounded text-[var(--text-primary)]"
            >
              <ChevronRight size={20}/>
            </button>
          </div>

          {viewMode === 'week' ? (
            <button
              type="button"
              onClick={() => setIsPresentationMode(true)}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-semibold text-[var(--text-primary)] shadow transition hover:bg-[var(--surface-secondary)] sm:flex-none"
            >
              <Maximize2 size={17} />
              全螢幕
            </button>
          ) : null}
          {currentUser?.role === 'ADMIN' ? (
            <button
              type="button"
              onClick={() => void openDeletedAudit()}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-semibold text-[var(--text-primary)] shadow transition hover:bg-[var(--surface-secondary)] sm:flex-none"
            >
              <Trash2 size={16} />
              刪除紀錄
            </button>
          ) : null}
          <button
            onClick={() => { setEditingTask({ work_group_id: activeWorkGroup?.id || '' }); setConvertingTodoId(null); setEditingTaskMembers([]); setIsFormOpen(true); }}
            disabled={currentUser?.role === 'VIEWER' || !activeWorkGroup || !workspace.ready}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded bg-[var(--accent)] px-4 py-2 text-[var(--accent-text)] shadow transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            <Plus size={20} />
            新增
          </button>
      </div>

      {error || workspace.error ? (
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--danger)]">
          <p className="mb-2 text-xl font-bold">載入失敗</p>
          <p>{error || workspace.error}</p>
          <button onClick={() => fetchData(true)} className="mt-4 px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-text)] rounded">重試</button>
        </div>
      ) : isLoading || !workspace.ready ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">載入中...</div>
      ) : workspace.configurationRequired ? (
        <div role="status" className="flex-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-center text-[var(--text-secondary)]">
          {currentUser?.role === 'ADMIN' ? '目前沒有有效工作群組，請至人員管理設定。' : '目前沒有可用的工作群組，請聯絡管理員完成設定。'}
        </div>
      ) : groupTasks.length === 0 && viewMode === 'week' ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">目前沒有{activeWorkGroupKey === 'ENGINEERING' ? '工程' : '專案'}排程，點擊上方「新增」開始排程。</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {viewMode === 'week' ? (
            <div className="min-h-0 flex-1 overflow-auto">{renderWeeklySchedule(weekDays, true)}</div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
              <div className="flex min-h-full min-w-[56rem] flex-col">
                <div data-month-calendar className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="grid grid-cols-7 bg-[var(--surface-secondary)] border-b border-[var(--border)]">
                  {['一','二','三','四','五','六','日'].map(d => (
                    <div key={d} className="text-center py-2 text-sm font-bold text-[var(--text-secondary)]">週{d}</div>
                  ))}
                </div>
                <div
                  className="flex-1 min-h-0 grid grid-cols-7 overflow-y-auto"
                  style={{ gridTemplateRows: monthGridTemplateRows }}
                >
                  {monthWeeks.map(week => {
                    const isExpanded = expandedMonthWeeks.has(week.key);

                    return (
                      <React.Fragment key={week.key}>
                        {isExpanded ? (
                          <section
                            data-expanded-week={week.key}
                            className="col-span-full border-b border-[var(--border)] bg-[var(--surface-secondary)] p-3"
                          >
                            {renderWeeklySchedule(week.scheduleDays, false)}
                          </section>
                        ) : (
                          week.calendarDays.map((day, dayIndex) => {
                            const dateStr = format(day, 'yyyy-MM-dd');
                            const dayTasks = sortTasks(groupTasks.filter(t => t.task_date === dateStr));
                            const isCurrentMonth = day.getMonth() === currentDate.getMonth();

                            return (
                              <div
                                key={dateStr}
                                data-compact-week={dayIndex === 0 ? week.key : undefined}
                                className={`min-h-0 min-w-0 border-r border-b border-[var(--border)] last:border-r-0 flex flex-col p-1 ${!isCurrentMonth ? 'bg-[var(--surface-secondary)] opacity-50' : ''}`}
                                onDragOver={e => e.preventDefault()}
                                onDrop={e => handleDropToDate(e, dateStr)}
                                onContextMenu={e => {
                                  e.preventDefault();
                                  if (currentUser?.role === 'VIEWER') return;
                                  setContextMenu(null);
                                  setTodoContextMenu(null);
                                  setDayContextMenu({ dateStr, x: e.clientX, y: e.clientY });
                                }}
                              >
                                <div className={`text-right text-xs p-1 font-semibold ${isSameDay(day, new Date()) ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}>
                                  {format(day, 'd')}
                                </div>
                                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
                                  {dayTasks.slice(0, DAILY_TASK_DISPLAY_LIMIT).map(task => {
                                    const { projName, cardDetail, assigneeDisplay, coworkerDisplay, mapUrl } = getTaskDisplay(task);
                                    const weatherDisplay = getTaskWeatherDisplay(task);
                                    const primaryLabel = [projName, formatTaskTime(task)].filter(Boolean).join(' ');
                                    const isDone = task.status === '完成';
                                    const isRescheduled = task.status === '改期';
                                    return (
                                      <div
                                        key={task.id}
                                        draggable={currentUser?.role !== 'VIEWER'}
                                        onDragStart={(e) => handleDragStart(e, task.id, 'task')}
                                        onContextMenu={(e) => {
                                          if (currentUser?.role === 'VIEWER') return;
                                          handleContextMenu(e, task.id);
                                        }}
                                        onClick={() => {
                                          setEditingTask(task);
                                          setEditingTaskMembers(members.filter(m => m.task_id === task.id).map(m => m.user_id));
                                          setIsFormOpen(true);
                                        }}
                                        className={`${fontSizeClasses.month} shrink-0 min-w-0 px-1 py-0.5 rounded cursor-pointer ${
                                          isDone ? 'bg-[var(--surface-secondary)] text-[var(--text-muted)] opacity-50' :
                                          isRescheduled ? 'bg-[var(--surface-secondary)] text-[var(--text-muted)] border border-dashed border-[var(--text-muted)] opacity-60' :
                                          task.is_tentative ? 'bg-[var(--surface-secondary)] text-[var(--warning)] border border-[var(--warning)]' :
                                          'bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--accent)]'
                                        }`}
                                      >
                                        {primaryLabel && <div className="font-semibold truncate">
                                          {isDone ? '✓ ' : ''}{isRescheduled ? '【改期】 ' : ''}{task.is_tentative ? '[暫] ' : ''}{primaryLabel}
                                        </div>}
                                        {cardDetail && <div className="truncate opacity-80">{cardDetail}</div>}
                                        {assigneeDisplay && <div className="truncate opacity-80">{assigneeDisplay}</div>}
                                        {coworkerDisplay && <div className="truncate opacity-80">{coworkerDisplay}</div>}
                                        {(mapUrl || weatherDisplay) && <div className="mt-0.5 flex items-center justify-between gap-1">
                                          {mapUrl && <a
                                            href={mapUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={e => e.stopPropagation()}
                                            className="underline font-bold text-[var(--accent)]"
                                          >
                                            MAP
                                          </a>}
                                          {weatherDisplay && (
                                            <span title={weatherDisplay.label} aria-label={`天氣：${weatherDisplay.label}`}>
                                              {weatherDisplay.icon}
                                            </span>
                                          )}
                                        </div>}
                                      </div>
                                    );
                                  })}
                                  {dayTasks.length > DAILY_TASK_DISPLAY_LIMIT && (
                                    <div
                                      className="shrink-0 text-[10px] text-center text-[var(--text-muted)] cursor-pointer hover:text-[var(--accent)]"
                                      onClick={() => setSelectedDayTasks({ date: day, tasks: dayTasks })}
                                    >
                                      +{dayTasks.length - DAILY_TASK_DISPLAY_LIMIT} 筆
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                        <button
                          data-week-expand-control={week.key}
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedMonthWeeks(current => (
                            toggleExpandedMonthWeek(current, week.key)
                          ))}
                          className="col-span-full flex w-full cursor-pointer items-center justify-between border-b border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                        >
                          <span className="sr-only">{isExpanded ? '收合本週排程' : '展開本週排程'}</span>
                          <span aria-hidden="true" className="text-base leading-none">{isExpanded ? '↑' : '↓'}</span>
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {selectedDayTasks && (
        <div className="absolute right-0 top-0 z-10 flex h-full w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl transition-transform sm:w-96">
          <div className="flex justify-between items-center p-4 border-b border-[var(--border)]">
            <h2 className="text-xl font-bold text-[var(--accent)]">
              {format(selectedDayTasks.date, 'yyyy/MM/dd')} 任務清單
            </h2>
            <button onClick={() => setSelectedDayTasks(null)} className="p-1 hover:bg-[var(--surface-secondary)] rounded text-[var(--text-primary)]">
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {selectedDayTasks.tasks.length === 0 ? (
              <div className="text-[var(--text-muted)] text-center mt-10">尚無排程任務</div>
            ) : (
              selectedDayTasks.tasks.map(task => {
                const { projName, cardDetail, assigneeDisplay, coworkerDisplay, mapUrl } = getTaskDisplay(task);
                const weatherDisplay = getTaskWeatherDisplay(task);
                const primaryLabel = [projName, formatTaskTime(task)].filter(Boolean).join(' ');
                return (
                  <div key={task.id} className={`bg-[var(--surface-secondary)] border border-[var(--border)] rounded-lg p-4 ${task.status === '完成' ? 'opacity-50' : ''}`}>
                    <div className="flex justify-end items-start mb-2">
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => handleReturnToTodo(task)} 
                          disabled={currentUser?.role === 'VIEWER'}
                          className="text-xs bg-amber-950/50 hover:bg-amber-900/50 text-amber-400 px-3 py-1 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ArrowLeft size={12}/> 退回待辦
                        </button>
                        <button onClick={() => {
                          setEditingTask(task);
                          setEditingTaskMembers(members.filter(m => m.task_id === task.id).map(m => m.user_id));
                          setIsFormOpen(true);
                        }} disabled={currentUser?.role === 'VIEWER'} className="text-xs bg-[var(--surface)] hover:bg-[var(--surface-secondary)] text-[var(--text-primary)] px-3 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed">
                          編輯
                        </button>
                      </div>
                    </div>
                    {primaryLabel && <div className={`${fontSizeClasses.primary} font-semibold truncate ${task.status === '完成' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                      {task.status === '完成' ? '✓ ' : ''}{task.is_tentative ? '[暫] ' : ''}{primaryLabel}
                    </div>}
                    {cardDetail && <div className={`${fontSizeClasses.secondary} text-[var(--accent)] mt-1 font-bold truncate`}>{cardDetail}</div>}
                    <div className={`${fontSizeClasses.people} text-[var(--text-secondary)] mt-1`}>
                      {assigneeDisplay && <div className="truncate">{assigneeDisplay}</div>}
                      {coworkerDisplay && <div className="truncate">{coworkerDisplay}</div>}
                    </div>
                    {(mapUrl || weatherDisplay) && <div className={`${fontSizeClasses.footer} mt-1 flex items-center justify-between gap-2`}>
                      {mapUrl && <a
                        href={mapUrl}
                        target="_blank" 
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()} 
                        className="text-[var(--accent)] hover:text-[var(--accent-hover)] underline font-bold"
                      >MAP</a>}
                      {weatherDisplay && (
                        <span
                          className="text-[var(--text-secondary)] whitespace-nowrap"
                          title={weatherDisplay.label}
                          aria-label={`天氣：${weatherDisplay.label}`}
                        >
                          {weatherDisplay.icon} {weatherDisplay.label}
                        </span>
                      )}
                    </div>}
                    <div className="text-xs text-[var(--text-muted)] mt-2 flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-full bg-[var(--surface)]">{task.status || '正常'}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {isPresentationMode ? (
        <div className="fixed inset-0 z-[120] flex flex-col bg-page text-[var(--text-primary)]" role="dialog" aria-modal="true" aria-label="週排程全螢幕展示">
          <header className="flex flex-wrap items-center justify-between gap-[clamp(0.75rem,1vw,1.5rem)] border-b border-[var(--border)] bg-[var(--surface)] px-[clamp(1rem,1.5vw,2rem)] py-[clamp(0.75rem,1.1vh,1.25rem)] shadow-sm">
            <div className="flex min-w-0 items-center gap-4">
              <div>
                <p className="text-[clamp(0.7rem,0.7vw,0.95rem)] font-bold uppercase tracking-[0.18em] text-[var(--accent)]">Weekly presentation</p>
                <h2 className="text-[clamp(1.25rem,1.65vw,2.2rem)] leading-tight font-bold">{activeWorkGroupKey === 'ENGINEERING' ? '工程' : '專案'}週排程</h2>
              </div>
              <span className="hidden text-[clamp(0.95rem,1.05vw,1.35rem)] font-semibold text-[var(--text-secondary)] sm:inline">
                {format(weekStart, 'yyyy/MM/dd')}－{format(addDays(weekStart, 5), 'yyyy/MM/dd')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setCurrentDate(subDays(currentDate, 7))} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-[var(--border)] px-3 font-semibold hover:bg-[var(--surface-secondary)]" aria-label="上一週">
                <ChevronLeft size={20} />上一週
              </button>
              <button type="button" onClick={() => setCurrentDate(new Date())} className="min-h-10 rounded-lg border border-[var(--border)] px-3 font-semibold hover:bg-[var(--surface-secondary)]">
                回到本週
              </button>
              <button type="button" onClick={() => setCurrentDate(addDays(currentDate, 7))} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-[var(--border)] px-3 font-semibold hover:bg-[var(--surface-secondary)]" aria-label="下一週">
                下一週<ChevronRight size={20} />
              </button>
              <button type="button" onClick={() => setIsPresentationMode(false)} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 font-bold text-[var(--accent-text)] hover:bg-[var(--accent-hover)]">
                <Minimize2 size={18} />離開全螢幕
              </button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-page p-3">
            {renderWeeklySchedule(weekDays, false, true)}
          </div>
          <div className="border-t border-[var(--border)] bg-[var(--surface)] px-5 py-1.5 text-right text-xs text-[var(--text-secondary)]">按 ESC 離開全螢幕展示</div>
        </div>
      ) : null}

      {contextMenu && (
        <div 
          className="fixed bg-[var(--surface)] text-[var(--text-primary)] border border-[var(--border)] shadow-xl rounded py-1 z-50 min-w-[120px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button 
            className="w-full text-left px-4 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={(e) => handleContextAction(e, 'RESCHEDULE_TASK')} disabled={currentUser?.role === 'VIEWER'}
          >改期</button>
          <button 
            className="w-full text-left px-4 py-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-secondary)] transition disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={(e) => handleContextAction(e, 'COMPLETE_TASK')} disabled={currentUser?.role === 'VIEWER'}
          >完成</button>
          <button 
            className="w-full text-left px-4 py-2 text-sm text-[var(--danger)] hover:bg-[var(--surface-secondary)] transition disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={(e) => handleContextAction(e, 'DELETE_TASK')} disabled={currentUser?.role === 'VIEWER'}
          >刪除</button>
        </div>
      )}

      {dayContextMenu && (
        <div 
          className="fixed bg-[var(--surface)] border border-[var(--border)] rounded shadow-xl py-1 z-50 text-sm min-w-[120px]"
          style={{ top: dayContextMenu.y, left: dayContextMenu.x }}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-[var(--surface-secondary)] text-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={currentUser?.role === 'VIEWER'}
            onClick={(e) => {
              e.stopPropagation();
              setEditingTask({ work_group_id: activeWorkGroup?.id || '', task_date: dayContextMenu.dateStr, task_type: '維修', status: '已排程' as TaskStatus });
              setEditingTaskMembers([]);
              setIsFormOpen(true);
              setDayContextMenu(null);
            }}
          >
            新增行程
          </button>
        </div>
      )}

      {todoContextMenu ? (
        <TodoContextMenu
          point={{ x: todoContextMenu.x, y: todoContextMenu.y }}
          onClose={() => setTodoContextMenu(null)}
          actions={(() => {
            if (!todoContextMenu.todoId) return [{ label: '新增待辦', tone: 'accent' as const, onSelect: () => setIsTodoFormOpen(true) }];
            const todo = todos.find(item => item.id === todoContextMenu.todoId);
            if (!todo) return [];
            return [
              { label: '加入排程', tone: 'accent' as const, onSelect: () => openTodoConvertForm(todo, format(new Date(), 'yyyy-MM-dd')) },
              { label: '刪除待辦', tone: 'danger' as const, onSelect: () => void handleDeleteTodo(todo) },
            ];
          })()}
        />
      ) : null}

      {isFormOpen && (
        <ScheduleTaskFormDialog
          initialData={editingTask || undefined}
          initialMemberIds={editingTaskMembers}
          onSubmit={handleCreateOrUpdateTask}
          onCancel={() => { setIsFormOpen(false); setEditingTask(null); setConvertingTodoId(null); setEditingTaskMembers([]); }}
          isSubmitting={isSubmitting}
        />
      )}

      {isDeletedAuditOpen ? (
        <ScheduleDeletedAuditDialog
          logs={deletedAuditLogs}
          loading={isDeletedAuditLoading}
          onClose={() => setIsDeletedAuditOpen(false)}
        />
      ) : null}

      {isTodoFormOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--modal-bg)] text-[var(--modal-text)] border border-[var(--border)] p-5 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-bold text-[var(--modal-text)] mb-4">新增待辦事項</h2>
            <TodoForm 
              initialData={{ work_group_id: activeWorkGroup?.id || null }}
              onSubmit={handleCreateTodo}
              onCancel={() => setIsTodoFormOpen(false)}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}
    </div>
  );
}
