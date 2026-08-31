"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ScheduleTask, ScheduleTaskMember, Project, User, Todo, TaskStatus } from '@/lib/db/types';
import { dbAdapter, isGoogleRemoteDeletedError } from '@/lib/db';
import { ScheduleTaskForm } from '@/components/ScheduleTaskForm';
import {
  GoogleCalendarSyncSummaryDialog,
  GoogleCalendarUnmatchedDialog,
  type GoogleCalendarSyncDecision,
  type GoogleCalendarSyncFailure,
  type GoogleCalendarSyncSummary,
  type GoogleCalendarUnmatchedEvent,
} from '@/components/GoogleCalendarSyncDialogs';
import { TodoForm } from '@/components/TodoForm';
import { startOfWeek, endOfWeek, addDays, subDays, format, isSameDay, startOfMonth, endOfMonth } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, X, ArrowLeft, RefreshCw } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { getDatabaseErrorMessage, isMissingCoreTablesError } from '@/lib/db/supabase-errors';
import { supabase } from '@/lib/db/supabaseClient';
import { parseTaiwanProjectLocation } from '@/lib/project-location';
import {
  collectUniqueWeatherRequests,
  resolveTaskWeatherRequest,
  WEATHER_STATE_DISPLAY,
  type WeatherState,
} from '@/lib/weather';

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
  matchedImportedOrUpdated?: number;
  unmatchedImported?: number;
  skippedThisRun?: number;
  failed?: number;
  unmatchedEvents?: GoogleCalendarUnmatchedEvent[];
  failures?: GoogleCalendarSyncFailure[];
  error?: string;
};

type ReconcileOptions = {
  force?: boolean;
  decisions?: GoogleCalendarSyncDecision[];
};

const RECONCILE_COOLDOWN_MS = 30000;
let reconcileInFlight: Promise<ReconcileResult | null> | null = null;
let lastReconcileAt = 0;

const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === 'AbortError'
);

const sortTasks = (taskList: ScheduleTask[]) => {
  return [...taskList].filter(t => t.status !== '取消').sort((a, b) => {
    if (a.is_tentative && !b.is_tentative) return 1;
    if (!a.is_tentative && b.is_tentative) return -1;

    const timeWeight = (t: ScheduleTask) => {
      if (t.start_time) return t.start_time;
      if (t.is_all_day) return '25:00';
      return '26:00';
    };
    return timeWeight(a).localeCompare(timeWeight(b));
  });
};

const formatTaskTime = (task: ScheduleTask): string => {
  if (task.is_all_day) return '全天';
  if (task.start_time && task.end_time) return `${task.start_time}–${task.end_time}`;
  return task.start_time || '未指定時間';
};

const getScheduleDistrictLabel = (
  task: ScheduleTask,
  project: Project | undefined,
): string => {
  const location = parseTaiwanProjectLocation(project?.address)
    || parseTaiwanProjectLocation(task.address);
  if (!location) return '';

  if (location.city === '新竹市' || location.city === '嘉義市') {
    return `${location.city.replace(/市$/, '')}${location.district}`;
  }

  return location.district.replace(/[區鄉鎮市]$/, '');
};

export default function SchedulePage() {
  const { currentUser } = useUser();
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [scheduleFontSize, setScheduleFontSize] = useState<ScheduleFontSize>('medium');
  const [currentDate, setCurrentDate] = useState(new Date());
  
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [members, setMembers] = useState<ScheduleTaskMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [weatherByKey, setWeatherByKey] = useState<Map<string, WeatherState | null>>(() => new Map());
  const weatherCacheRef = useRef<Map<string, WeatherState | null>>(new Map());
  const requestedWeatherKeysRef = useRef<Set<string>>(new Set());

  // Task Modal & Drawer State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Partial<ScheduleTask> | null>(null);
  const [editingTaskMembers, setEditingTaskMembers] = useState<string[]>([]);
  const [convertingTodoId, setConvertingTodoId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmingGoogleEvents, setIsConfirmingGoogleEvents] = useState(false);
  const [unmatchedGoogleEvents, setUnmatchedGoogleEvents] = useState<GoogleCalendarUnmatchedEvent[]>([]);
  const [googleSyncSummary, setGoogleSyncSummary] = useState<GoogleCalendarSyncSummary | null>(null);
  const [pendingGoogleSyncSummary, setPendingGoogleSyncSummary] = useState<GoogleCalendarSyncSummary | null>(null);
  const [selectedDayTasks, setSelectedDayTasks] = useState<{date: Date, tasks: ScheduleTask[]} | null>(null);

  // Todo Modal
  const [isTodoFormOpen, setIsTodoFormOpen] = useState(false);

  // Context Menu
  const [contextMenu, setContextMenu] = useState<{taskId: string, x: number, y: number} | null>(null);
  const [dayContextMenu, setDayContextMenu] = useState<{dateStr: string, x: number, y: number} | null>(null);
  const [todoContextMenu, setTodoContextMenu] = useState<{todoId: string | null, x: number, y: number} | null>(null);
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null);
      setDayContextMenu(null);
      setTodoContextMenu(null);
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

  const handleScheduleFontSizeChange = (fontSize: ScheduleFontSize) => {
    setScheduleFontSize(fontSize);
    window.localStorage.setItem(SCHEDULE_FONT_SIZE_STORAGE_KEY, fontSize);
  };

  const [error, setError] = useState<string | null>(null);

  const reconcileGoogleCalendar = useCallback(async (options: ReconcileOptions = {}) => {
    if (currentUser?.role?.toUpperCase() === 'VIEWER') return null;

    const now = Date.now();
    if (reconcileInFlight) return reconcileInFlight;
    if (!options.force && now - lastReconcileAt < RECONCILE_COOLDOWN_MS) return null;

    const reconcilePromise = supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token) return;

      return fetch('/api/google-calendar/reconcile', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options.decisions ? { decisions: options.decisions } : {}),
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

  const handleManualSync = async () => {
    try {
      setIsLoading(true);
      const res = await reconcileGoogleCalendar({ force: true });
      if (res) {
        if (res.success === false) {
          alert(`同步失敗：${res.error || '未知錯誤'}`);
        } else {
          const summary: GoogleCalendarSyncSummary = {
            matchedImportedOrUpdated: res.matchedImportedOrUpdated || 0,
            unmatchedImported: res.unmatchedImported || 0,
            skippedThisRun: res.skippedThisRun || 0,
            failed: res.failed || 0,
            failures: res.failures || [],
          };
          if (res.unmatchedEvents?.length) {
            setPendingGoogleSyncSummary(summary);
            setUnmatchedGoogleEvents(res.unmatchedEvents);
          } else {
            setGoogleSyncSummary(summary);
          }
        }
        await fetchData(false);
      } else {
        alert('目前同步暫時無法執行，請稍後再試');
      }
    } catch (e: any) {
      alert(`同步失敗：${e.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmUnmatchedGoogleEvents = async (decisions: GoogleCalendarSyncDecision[]) => {
    setIsConfirmingGoogleEvents(true);
    try {
      const res = await reconcileGoogleCalendar({ force: true, decisions });
      if (!res || res.success === false) {
        throw new Error(res?.error || '確認未匹配活動失敗');
      }
      const initial = pendingGoogleSyncSummary || {
        matchedImportedOrUpdated: 0,
        unmatchedImported: 0,
        skippedThisRun: 0,
        failed: 0,
        failures: [],
      };
      setGoogleSyncSummary({
        matchedImportedOrUpdated: initial.matchedImportedOrUpdated + (res.matchedImportedOrUpdated || 0),
        unmatchedImported: initial.unmatchedImported + (res.unmatchedImported || 0),
        skippedThisRun: initial.skippedThisRun + (res.skippedThisRun || 0),
        failed: initial.failed + (res.failed || 0),
        failures: [...initial.failures, ...(res.failures || [])],
      });
      setUnmatchedGoogleEvents([]);
      setPendingGoogleSyncSummary(null);
      await fetchData(false);
    } catch (error: any) {
      alert(`未匹配活動處理失敗：${error.message}`);
    } finally {
      setIsConfirmingGoogleEvents(false);
    }
  };

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    setError(null);
    try {
      // Add timeout to prevent infinite loading
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('讀取超時，請重試')), 10000)
      );

      const [t, m, p, u, td] = await Promise.race([
        Promise.all([
          dbAdapter.getScheduleTasks().catch(e => { console.error('Schedule tasks error:', e); return []; }),
          dbAdapter.getScheduleTaskMembers().catch(e => { console.error('Schedule members error:', e); return []; }),
          dbAdapter.getProjects().catch(e => {
            console.error('Projects error:', e);
            if (isMissingCoreTablesError(e)) throw e;
            return [];
          }),
          dbAdapter.getUsers().catch(e => { console.error('Users error:', e); return []; }),
          dbAdapter.getTodos().catch(e => { console.error('Todos error:', e); return []; })
        ]),
        timeoutPromise
      ]) as [ScheduleTask[], ScheduleTaskMember[], Project[], User[], Todo[]];

      setTasks(t);
      setMembers(m);
      setProjects(p);
      setUsers(u);
      setTodos(td);

      if (showLoading) setIsLoading(false);

      if (showLoading) {
        reconcileGoogleCalendar().then((res: any) => {
          if (res?.updated || res?.deleted) {
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

  const removeTaskFromVisibleState = useCallback((taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
    setSelectedDayTasks(prev => prev
      ? { ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }
      : null
    );
  }, []);

  const handleRemoteDeletedTask = useCallback(async (taskId: string) => {
    removeTaskFromVisibleState(taskId);
    setIsFormOpen(false);
    setEditingTask(null);
    setEditingTaskMembers([]);
    setConvertingTodoId(null);
    alert('此排程已從 Google 日曆刪除，系統已同步移除');
    await fetchData(false);
  }, [fetchData, removeTaskFromVisibleState]);

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
  const monthWeekCount = monthDays.length / 7;
  const fontSizeClasses = SCHEDULE_FONT_SIZE_CLASSES[scheduleFontSize];

  const visibleWeatherTasks = useMemo(() => {
    const visibleTasks = selectedDayTasks ? [...selectedDayTasks.tasks] : [];
    if (viewMode !== 'week') return visibleTasks;

    const visibleWeekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
    for (let index = 0; index < 6; index += 1) {
      const dateStr = format(addDays(visibleWeekStart, index), 'yyyy-MM-dd');
      visibleTasks.push(...sortTasks(tasks.filter(task => task.task_date === dateStr)).slice(0, 3));
    }
    return visibleTasks;
  }, [currentDate, selectedDayTasks, tasks, viewMode]);

  const weatherRequests = useMemo(
    () => collectUniqueWeatherRequests(visibleWeatherTasks, projects),
    [projects, visibleWeatherTasks],
  );

  useEffect(() => {
    const missingRequests = weatherRequests.filter(request => (
      !weatherCacheRef.current.has(request.key)
      && !requestedWeatherKeysRef.current.has(request.key)
    ));
    if (missingRequests.length === 0) return;

    missingRequests.forEach(request => requestedWeatherKeysRef.current.add(request.key));

    Promise.all(missingRequests.map(async weatherRequest => {
      const searchParams = new URLSearchParams({
        date: weatherRequest.date,
        city: weatherRequest.city,
        district: weatherRequest.district,
      });

      try {
        const response = await fetch(`/api/weather?${searchParams.toString()}`);
        if (!response.ok) return [weatherRequest.key, null] as const;
        const data = await response.json() as { weather?: WeatherState | null };
        return [weatherRequest.key, data.weather || null] as const;
      } catch {
        return [weatherRequest.key, null] as const;
      }
    })).then(results => {
      const nextWeatherByKey = new Map(weatherCacheRef.current);
      results.forEach(([key, weather]) => nextWeatherByKey.set(key, weather));
      weatherCacheRef.current = nextWeatherByKey;
      setWeatherByKey(nextWeatherByKey);
    });
  }, [weatherRequests]);

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

  const handleCreateOrUpdateTask = async (data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>, newMemberIds: string[]) => {
    setIsSubmitting(true);
    try {
      let sourceTodoId = convertingTodoId || (editingTask as ScheduleTask)?.source_todo_id;

      if (editingTask?.id) {
        const originalTask = tasks.find(t => t.id === editingTask.id);
        // Optimistic Update
        setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...data, updated_at: new Date().toISOString() } as ScheduleTask : t));
        
        try {
          await dbAdapter.updateScheduleTask(editingTask.id, data, newMemberIds);
          replaceTaskMembers(editingTask.id, newMemberIds);
          const projectChanged = originalTask?.project_id !== data.project_id;
          await dbAdapter.logActivity({
            actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
            action_type: 'UPDATE_TASK', target_type: 'ScheduleTask', target_id: editingTask.id, target_label: data.title,
            project_id: data.project_id, project_name: data.project_name || '',
            before_value: projectChanged ? (originalTask?.project_name || '未匹配案場') : null,
            after_value: projectChanged ? (data.project_name || '未匹配案場') : null,
            message: projectChanged ? '編輯排程任務並更新案場關聯' : '編輯排程任務'
          });
        } catch (error) {
          if (isGoogleRemoteDeletedError(error)) {
            await handleRemoteDeletedTask(editingTask.id);
            return;
          }

          console.error('Update failed, rolling back:', error);
          alert('排程更新失敗，請檢查網路連線或稍後再試。');
          if (originalTask) {
            setTasks(prev => prev.map(t => t.id === editingTask.id ? originalTask : t));
          }
          replaceTaskMembers(editingTask.id, editingTaskMembers);
          throw error;
        }
      } else {
        const payload = { ...data, source_todo_id: convertingTodoId };
        
        // Optimistic Create
        const tempId = `temp-${Date.now()}`;
        const tempTask = { ...payload, id: tempId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as ScheduleTask;
        setTasks(prev => [...prev, tempTask]);
        
        try {
          const newTask = await dbAdapter.createScheduleTask(payload, newMemberIds);
          
          // Replace temp with real
          setTasks(prev => prev.map(t => t.id === tempId ? newTask : t));
          replaceTaskMembers(newTask.id, newMemberIds);

          await dbAdapter.logActivity({
            actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
            action_type: 'CREATE_TASK', target_type: 'ScheduleTask', target_id: newTask.id, target_label: data.title,
            project_id: data.project_id, project_name: '', before_value: null, after_value: null, message: '建立排程任務'
          });

          if (convertingTodoId) {
            setTodos(prev => prev.filter(t => t.id !== convertingTodoId));
            await dbAdapter.updateTodo(convertingTodoId, { status: '已排程', converted_task_id: newTask.id });
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
          tasks: sortTasks(freshTasks.filter(t => t.task_date === dateStr))
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
           converted_task_id: null,
           created_by: 'mock-user-engineer'
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
    let staleTaskId: string | null = null;
    try {
      const dataStr = e.dataTransfer.getData('application/x-schedule-item') || e.dataTransfer.getData('text/plain');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      const { dragId, dragType } = data;
      
      if (dragType !== 'task') return;
      const task = tasks.find(t => t.id === dragId);
      if (!task) return;
      staleTaskId = task.id;

      await handleReturnToTodo(task);
    } catch(err) {
      if (isGoogleRemoteDeletedError(err) && staleTaskId) {
        await handleRemoteDeletedTask(staleTaskId);
        return;
      }

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

  const handleDragStart = (e: React.DragEvent, id: string, type: 'task' | 'todo') => {
    const data = JSON.stringify({ dragId: id, dragType: type });
    e.dataTransfer.setData('application/x-schedule-item', data);
    e.dataTransfer.setData('text/plain', data);
    e.dataTransfer.effectAllowed = 'move';
  };

  const openTodoConvertForm = (todo: Todo, dateStr: string) => {
    setConvertingTodoId(todo.id);
    setEditingTask({
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
          await dbAdapter.updateScheduleTask(dragId, { task_date: dateStr });
          await dbAdapter.logActivity({
            actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
            action_type: 'RESCHEDULE_TASK', target_type: 'ScheduleTask', target_id: task.id, target_label: task.title,
            project_id: task.project_id, project_name: '', before_value: originalDate, after_value: dateStr, message: '拖曳改期'
          });
          // Optimistic update succeeded, we can fetch later silently
          fetchData(false);
        } catch (error) {
          if (isGoogleRemoteDeletedError(error)) {
            await handleRemoteDeletedTask(dragId);
            return;
          }

          console.error('Update failed, rolling back:', error);
          alert('排程更新失敗，請檢查網路連線或稍後再試。');
          // Rollback
          setTasks(prev => prev.map(t => t.id === dragId ? { ...t, task_date: originalDate } : t));
        }

        if (selectedDayTasks) {
          const freshTasks = await dbAdapter.getScheduleTasks();
          setSelectedDayTasks(prev => prev ? {
            date: prev.date,
            tasks: sortTasks(freshTasks.filter(t => t.task_date === format(prev.date, 'yyyy-MM-dd')))
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
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: '改期' } : t));
        await dbAdapter.updateScheduleTask(task.id, { status: '改期' });
        await dbAdapter.logActivity({
          actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
          action_type: 'RESCHEDULE_TASK', target_type: 'ScheduleTask', target_id: task.id, target_label: task.title,
          project_id: task.project_id, project_name: '', before_value: task.status, after_value: '改期', message: null
        });
      } else if (action === 'COMPLETE_TASK') {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: '完成' } : t));
        await dbAdapter.updateScheduleTask(task.id, { status: '完成' });
        if (task.source_todo_id) {
            setTodos(prev => prev.map(td => td.id === task.source_todo_id ? { ...td, status: '已完成' } : td));
            await dbAdapter.updateTodo(task.source_todo_id, { status: '已完成' });
        }
        await dbAdapter.logActivity({
          actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
          action_type: 'COMPLETE_TASK', target_type: 'ScheduleTask', target_id: task.id, target_label: task.title,
          project_id: task.project_id, project_name: '', before_value: task.status, after_value: '完成', message: null
        });
      } else if (action === 'DELETE_TASK') {
        setTasks(prev => prev.filter(t => t.id !== task.id));
        await dbAdapter.deleteScheduleTask(task.id);
        await dbAdapter.logActivity({
          actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
          action_type: 'DELETE_TASK', target_type: 'ScheduleTask', target_id: task.id, target_label: task.title,
          project_id: task.project_id, project_name: '', before_value: task.status, after_value: '刪除', message: '硬刪除'
        });
      }
      await fetchData(false);
      if (selectedDayTasks) {
        const freshTasks = await dbAdapter.getScheduleTasks();
        setSelectedDayTasks(prev => prev ? {
          date: prev.date,
          tasks: sortTasks(freshTasks.filter(t => t.task_date === format(prev.date, 'yyyy-MM-dd')))
        } : null);
      }
    } catch(err) {
      if (isGoogleRemoteDeletedError(err)) {
        await handleRemoteDeletedTask(currentTaskId);
        return;
      }

      console.error(err);
    }
  };

  const getTaskDisplay = (task: ScheduleTask) => {
    const proj = projects.find(p => p.id === task.project_id);
    const projName = task.project_name || proj?.short_name || proj?.name || '未匹配案場';
    const mainUser = users.find(u => u.id === task.main_assignee_id);
    const memberUids = members.filter(m => m.task_id === task.id).map(m => m.user_id);
    const coUsers = users.filter(u => memberUids.includes(u.id));
    const mainAssigneeName = mainUser?.name || '';
    const coworkerNames = coUsers.map(u => u.name);
    const assigneeDisplay = mainAssigneeName ? `主要：${mainAssigneeName}` : '主要：未指定負責人';
    const coworkerDisplay = coworkerNames.length > 0 ? `協同：${coworkerNames.join('、')}` : '';
    
    const districtName = getScheduleDistrictLabel(task, proj);
    const district = districtName ? `[${districtName}]` : '';
    const searchAddress = task.address || proj?.address || projName;

    return { projName, assigneeDisplay, coworkerDisplay, district, searchAddress };
  };

  const getTaskWeatherDisplay = (task: ScheduleTask) => {
    const project = projects.find(candidate => candidate.id === task.project_id);
    const weatherRequest = resolveTaskWeatherRequest(task, project);
    if (!weatherRequest) return null;

    const weather = weatherByKey.get(weatherRequest.key);
    return weather ? WEATHER_STATE_DISPLAY[weather] : null;
  };

  return (
    <div className="p-8 h-full flex flex-col min-w-[1500px] mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-6">
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">排程管理</h1>
          
          <div className="flex bg-[var(--surface)] rounded-lg p-1 border border-[var(--border)]">
            <button 
              onClick={() => setViewMode('week')}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${viewMode === 'week' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              週檢視
            </button>
            <button 
              onClick={() => setViewMode('month')}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${viewMode === 'month' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              月檢視
            </button>
          </div>

          <div className="flex items-center bg-[var(--surface)] rounded-lg p-1 border border-[var(--border)]">
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

          <div className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-1">
            <button 
              onClick={() => setCurrentDate(viewMode === 'week' ? subDays(currentDate, 7) : addDays(currentDate, -30))} 
              className="p-1 hover:bg-[var(--surface-secondary)] rounded text-[var(--text-primary)]"
            >
              <ChevronLeft size={20}/>
            </button>
            <span className="text-sm font-semibold text-[var(--text-primary)] px-2 min-w-[160px] text-center">
              {viewMode === 'week' ? 
                `${format(weekStart, 'yyyy/MM/dd')} - ${format(addDays(weekStart, 5), 'yyyy/MM/dd')}` : 
                format(currentDate, 'yyyy 年 MM 月')}
            </span>
            <button 
              onClick={() => setCurrentDate(viewMode === 'week' ? addDays(currentDate, 7) : addDays(currentDate, 30))} 
              className="p-1 hover:bg-[var(--surface-secondary)] rounded text-[var(--text-primary)]"
            >
              <ChevronRight size={20}/>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleManualSync}
            disabled={currentUser?.role === 'VIEWER' || isLoading}
            className="flex items-center gap-2 bg-[var(--surface)] hover:bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--accent)] px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            重新同步 Google 日曆
          </button>
          <button
            onClick={() => { setEditingTask(null); setConvertingTodoId(null); setEditingTaskMembers([]); setIsFormOpen(true); }}
            disabled={currentUser?.role === 'VIEWER'}
            className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-text)] px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={20} />
            新增任務
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--danger)]">
          <p className="mb-2 text-xl font-bold">載入失敗</p>
          <p>{error}</p>
          <button onClick={() => fetchData(true)} className="mt-4 px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-text)] rounded">重試</button>
        </div>
      ) : isLoading ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">載入中...</div>
      ) : tasks.length === 0 && viewMode === 'week' ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">目前沒有排程，點擊右上角「新增任務」開始排程。</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {viewMode === 'week' ? (
            <div className="flex-1 grid grid-cols-7 border border-[var(--border)] rounded-xl bg-[var(--surface)] overflow-hidden">
              
              {weekDays.map((day, i) => {
                const dateStr = format(day, 'yyyy-MM-dd');
                const dayTasks = sortTasks(tasks.filter(t => t.task_date === dateStr));
                const displayTasks = dayTasks.slice(0, 3);
                const hiddenCount = dayTasks.length - 3;
                
                return (
                  <div 
                    key={i} 
                    className="border-r border-[var(--border)] flex flex-col"
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
                    <div 
                      className={`text-center py-3 border-b border-[var(--border)] font-semibold cursor-pointer hover:bg-[var(--surface-secondary)] transition ${isSameDay(day, new Date()) ? 'text-[var(--accent)] bg-[var(--surface-secondary)]' : 'text-[var(--text-primary)]'}`}
                      onClick={() => setSelectedDayTasks({ date: day, tasks: dayTasks })}
                    >
                      <div className="text-sm">週{['日','一','二','三','四','五','六'][day.getDay()]}</div>
                      <div className="text-xl">{format(day, 'd')}</div>
                    </div>
                    <div className="flex-1 p-2 flex flex-col gap-2 overflow-y-auto">
                      {displayTasks.map(task => {
                        const { projName, assigneeDisplay, coworkerDisplay, district, searchAddress } = getTaskDisplay(task);
                        const weatherDisplay = getTaskWeatherDisplay(task);
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
                            className={`p-2 rounded cursor-pointer border shadow-sm transition transform hover:scale-[1.02] active:scale-95 ${
                              isDone ? 'bg-[var(--surface-secondary)] border-[var(--border)] opacity-50' :
                              isRescheduled ? 'bg-[var(--surface-secondary)] border-dashed border-[var(--text-muted)] opacity-60' :
                              task.is_tentative ? 'bg-[var(--surface-secondary)] border-[var(--warning)]' :
                              'bg-[var(--surface-secondary)] border-[var(--accent)]'
                            }`}
                          >
                            <div className={`${fontSizeClasses.primary} font-semibold truncate ${isDone || isRescheduled ? 'text-[var(--text-muted)]' : task.is_tentative ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]'}`}>
                              {isDone ? '✓ ' : ''}{isRescheduled ? '【改期】 ' : ''}{task.is_tentative ? '[暫] ' : ''}{projName} {formatTaskTime(task)}
                            </div>
                            <div className={`${fontSizeClasses.secondary} mt-0.5 font-bold truncate ${isDone || isRescheduled ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}`}>
                              {district}[{task.task_type}] {task.title || '無標題'}
                            </div>
                            {(assigneeDisplay || coworkerDisplay) && (
                              <div className={`${fontSizeClasses.people} mt-0.5 space-y-0.5 ${isDone || isRescheduled ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>
                                {assigneeDisplay && <div className="truncate">{assigneeDisplay}</div>}
                                {coworkerDisplay && <div className="truncate">{coworkerDisplay}</div>}
                              </div>
                            )}
                            <div className={`${fontSizeClasses.footer} mt-1 flex items-center justify-between gap-2`}>
                              <a 
                                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchAddress)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="underline font-bold text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                              >
                                MAP
                              </a>
                              {weatherDisplay && (
                                <span
                                  className="text-[var(--text-secondary)] whitespace-nowrap"
                                  title={weatherDisplay.label}
                                  aria-label={`天氣：${weatherDisplay.label}`}
                                >
                                  {weatherDisplay.icon}<span className="hidden 2xl:inline"> {weatherDisplay.label}</span>
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {hiddenCount > 0 && (
                        <div 
                          className="text-center text-xs font-bold text-[var(--text-muted)] hover:text-[var(--accent)] cursor-pointer mt-1"
                          onClick={() => setSelectedDayTasks({ date: day, tasks: dayTasks })}
                        >
                          +{hiddenCount} 筆
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              <div 
                className="flex flex-col min-h-[400px] bg-[var(--surface-secondary)] relative overflow-hidden flex-1"
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={handleDropToTodo}
                onContextMenu={e => {
                  e.preventDefault();
                  if (currentUser?.role === 'VIEWER') return;
                  if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('flex-1')) {
                    setContextMenu(null);
                    setDayContextMenu(null);
                    setTodoContextMenu({ todoId: null, x: e.clientX, y: e.clientY });
                  }
                }}
              >
                <div className="text-center py-3 border-b border-[var(--border)] font-bold text-[var(--warning)] bg-[var(--surface)] flex justify-between items-center px-4 shrink-0">
                  <span>待辦事項</span>
                  <button onClick={() => setIsTodoFormOpen(true)} disabled={currentUser?.role === 'VIEWER'} className="hover:bg-[var(--surface-secondary)] p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed" title="新增待辦"><Plus size={16}/></button>
                </div>
                
                <div className="flex-1 p-2 flex flex-col gap-2 overflow-y-auto">
                  {todos.filter(t => t.status === '待安排').map(todo => {
                    const proj = projects.find(p => p.id === todo.project_id);
                    const projName = proj?.short_name || proj?.name || '未指定案場';
                    
                    return (
                      <div 
                        key={todo.id}
                        draggable={currentUser?.role !== 'VIEWER'}
                        onDragStart={(e) => handleDragStart(e, todo.id, 'todo')}
                        onClick={() => openTodoConvertForm(todo, format(new Date(), 'yyyy-MM-dd'))}
                        onContextMenu={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (currentUser?.role === 'VIEWER') return;
                          setContextMenu(null);
                          setDayContextMenu(null);
                          setTodoContextMenu({ todoId: todo.id, x: e.clientX, y: e.clientY });
                        }}
                        className="p-2 rounded border border-[var(--warning)] bg-[var(--surface)] shadow-sm cursor-pointer hover:border-[var(--accent)] transition"
                      >
                        <div className="text-xs font-semibold text-amber-300 truncate">
                          {projName}
                        </div>
                        <div className="text-xs mt-1 font-bold text-[var(--accent)] truncate">
                          [{todo.task_type || '未分類'}]
                        </div>
                        <div className="text-xs mt-0.5 text-[var(--text-primary)] truncate">
                          {todo.title}
                        </div>
                      </div>
                    );
                  })}
                  {todos.filter(t => t.status === '待安排').length === 0 && (
                     <div className="text-xs text-[var(--text-muted)] text-center mt-4">無待辦事項</div>
                  )}
                </div>
              </div>

            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col border border-[var(--border)] rounded-xl bg-[var(--surface)] overflow-hidden">
              <div className="grid grid-cols-7 bg-[var(--surface-secondary)] border-b border-[var(--border)]">
                {['一','二','三','四','五','六','日'].map(d => (
                  <div key={d} className="text-center py-2 text-sm font-bold text-[var(--text-secondary)]">週{d}</div>
                ))}
              </div>
              <div
                className="flex-1 min-h-0 grid grid-cols-7 overflow-y-auto"
                style={{ gridTemplateRows: `repeat(${monthWeekCount}, minmax(160px, 1fr))` }}
              >
                {monthDays.map((day, i) => {
                  const dateStr = format(day, 'yyyy-MM-dd');
                  const dayTasks = sortTasks(tasks.filter(t => t.task_date === dateStr));
                  const isCurrentMonth = day.getMonth() === currentDate.getMonth();
                  
                  return (
                    <div 
                      key={i} 
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
                      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
                        {dayTasks.slice(0, 3).map(task => {
                          const { projName, assigneeDisplay, coworkerDisplay, district, searchAddress } = getTaskDisplay(task);
                          const weatherDisplay = getTaskWeatherDisplay(task);
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
                              className={`${fontSizeClasses.month} min-w-0 px-1 py-0.5 rounded cursor-pointer ${
                                isDone ? 'bg-[var(--surface-secondary)] text-[var(--text-muted)] opacity-50' :
                                isRescheduled ? 'bg-[var(--surface-secondary)] text-[var(--text-muted)] border border-dashed border-[var(--text-muted)] opacity-60' :
                                task.is_tentative ? 'bg-[var(--surface-secondary)] text-[var(--warning)] border border-[var(--warning)]' :
                                'bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--accent)]'
                              }`}
                            >
                              <div className="font-semibold truncate">
                                {isDone ? '✓ ' : ''}{isRescheduled ? '【改期】 ' : ''}{task.is_tentative ? '[暫] ' : ''}{projName} {formatTaskTime(task)}
                              </div>
                              <div className="truncate opacity-80">{district}[{task.task_type}] {task.title || '無標題'}</div>
                              {assigneeDisplay && <div className="truncate opacity-80">{assigneeDisplay}</div>}
                              {coworkerDisplay && <div className="truncate opacity-80">{coworkerDisplay}</div>}
                              <div className="mt-0.5 flex items-center justify-between gap-1">
                                <a
                                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchAddress)}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={e => e.stopPropagation()}
                                  className="underline font-bold text-[var(--accent)]"
                                >
                                  MAP
                                </a>
                                {weatherDisplay && (
                                  <span title={weatherDisplay.label} aria-label={`天氣：${weatherDisplay.label}`}>
                                    {weatherDisplay.icon}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {dayTasks.length > 3 && (
                          <div 
                            className="text-[10px] text-center text-[var(--text-muted)] cursor-pointer hover:text-[var(--accent)]"
                            onClick={() => setSelectedDayTasks({ date: day, tasks: dayTasks })}
                          >
                            +{dayTasks.length - 3}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {selectedDayTasks && (
        <div className="absolute top-0 right-0 h-full w-96 bg-[var(--surface)] border-l border-[var(--border)] shadow-2xl flex flex-col transform transition-transform z-10">
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
                const { projName, assigneeDisplay, coworkerDisplay, district, searchAddress } = getTaskDisplay(task);
                const weatherDisplay = getTaskWeatherDisplay(task);
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
                    <div className={`${fontSizeClasses.primary} font-semibold truncate ${task.status === '完成' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                      {task.status === '完成' ? '✓ ' : ''}{task.is_tentative ? '[暫] ' : ''}{projName} {formatTaskTime(task)}
                    </div>
                    <div className={`${fontSizeClasses.secondary} text-[var(--accent)] mt-1 font-bold truncate`}>{district}[{task.task_type}] {task.title || '無標題'}</div>
                    <div className={`${fontSizeClasses.people} text-[var(--text-secondary)] mt-1`}>
                      {assigneeDisplay && <div className="truncate">{assigneeDisplay}</div>}
                      {coworkerDisplay && <div className="truncate">{coworkerDisplay}</div>}
                    </div>
                    <div className={`${fontSizeClasses.footer} mt-1 flex items-center justify-between gap-2`}>
                      <a 
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchAddress)}`}
                        target="_blank" 
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()} 
                        className="text-[var(--accent)] hover:text-[var(--accent-hover)] underline font-bold"
                      >MAP</a>
                      {weatherDisplay && (
                        <span
                          className="text-[var(--text-secondary)] whitespace-nowrap"
                          title={weatherDisplay.label}
                          aria-label={`天氣：${weatherDisplay.label}`}
                        >
                          {weatherDisplay.icon} {weatherDisplay.label}
                        </span>
                      )}
                    </div>
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
              setEditingTask({ task_date: dayContextMenu.dateStr, task_type: '維修', status: '已排程' as TaskStatus });
              setEditingTaskMembers([]);
              setIsFormOpen(true);
              setDayContextMenu(null);
            }}
          >
            新增行程
          </button>
        </div>
      )}

      {todoContextMenu && (
        <div 
          className="fixed bg-[var(--surface)] border border-[var(--border)] rounded shadow-xl py-1 z-50 text-sm min-w-[120px]"
          style={{ top: todoContextMenu.y, left: todoContextMenu.x }}
        >
          {todoContextMenu.todoId ? (
            <button 
              className="w-full text-left px-4 py-2 hover:bg-[var(--surface-secondary)] text-[var(--danger)] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={currentUser?.role === 'VIEWER'}
              onClick={async (e) => {
                e.stopPropagation();
                const id = todoContextMenu.todoId;
                if (!id) return;
                setTodoContextMenu(null);
                setTodos(prev => prev.filter(t => t.id !== id));
                await dbAdapter.deleteTodo(id);
                await dbAdapter.logActivity({
                  actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
                  action_type: 'DELETE_TASK', target_type: 'Todo', target_id: id, target_label: '已刪除',
                  project_id: null, project_name: '', before_value: null, after_value: '刪除', message: '刪除待辦'
                });
                await fetchData(false);
              }}
            >刪除待辦</button>
          ) : (
            <button 
              className="w-full text-left px-4 py-2 hover:bg-[var(--surface-secondary)] text-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={currentUser?.role === 'VIEWER'}
              onClick={(e) => {
                e.stopPropagation();
                setTodoContextMenu(null);
                setIsTodoFormOpen(true);
              }}
            >新增待辦</button>
          )}
        </div>
      )}

      {isFormOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--modal-bg)] text-[var(--modal-text)] border border-[var(--border)] p-5 rounded-2xl w-full max-w-xl max-h-[95vh] overflow-auto shadow-2xl">
            <ScheduleTaskForm 
              initialData={editingTask || undefined}
              initialMemberIds={editingTaskMembers}
              onSubmit={handleCreateOrUpdateTask}
              onCancel={() => { setIsFormOpen(false); setEditingTask(null); setConvertingTodoId(null); setEditingTaskMembers([]); }}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      )}

      {unmatchedGoogleEvents.length > 0 && (
        <GoogleCalendarUnmatchedDialog
          events={unmatchedGoogleEvents}
          projects={projects}
          isSubmitting={isConfirmingGoogleEvents}
          onConfirm={handleConfirmUnmatchedGoogleEvents}
          onClose={() => {
            setUnmatchedGoogleEvents([]);
            setGoogleSyncSummary(pendingGoogleSyncSummary);
            setPendingGoogleSyncSummary(null);
          }}
        />
      )}

      {googleSyncSummary && (
        <GoogleCalendarSyncSummaryDialog
          summary={googleSyncSummary}
          onClose={() => setGoogleSyncSummary(null)}
        />
      )}

      {isTodoFormOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--modal-bg)] text-[var(--modal-text)] border border-[var(--border)] p-5 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-bold text-[var(--modal-text)] mb-4">新增待辦事項</h2>
            <TodoForm 
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
