"use client";

import React, { useState, useEffect } from 'react';
import { ScheduleTask, ScheduleTaskMember, Project, User, Todo, TaskStatus } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { ScheduleTaskForm } from '@/components/ScheduleTaskForm';
import { TodoForm } from '@/components/TodoForm';
import { startOfWeek, addDays, subDays, format, isSameDay, startOfMonth, endOfMonth, getDay } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, X, ArrowLeft } from 'lucide-react';
import { useUser } from '@/components/UserContext';

type ViewMode = 'week' | 'month';

export default function SchedulePage() {
  const { currentUser } = useUser();
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [members, setMembers] = useState<ScheduleTaskMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Task Modal & Drawer State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Partial<ScheduleTask> | null>(null);
  const [editingTaskMembers, setEditingTaskMembers] = useState<string[]>([]);
  const [convertingTodoId, setConvertingTodoId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  const fetchData = async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    const [t, m, p, u, td] = await Promise.all([
      dbAdapter.getScheduleTasks(),
      dbAdapter.getScheduleTaskMembers(),
      dbAdapter.getProjects(),
      dbAdapter.getUsers(),
      dbAdapter.getTodos()
    ]);
    setTasks(t);
    setMembers(m);
    setProjects(p);
    setUsers(u);
    setTodos(td);
    if (showLoading) setIsLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Week View Dates
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 }); 
  const weekDays = Array.from({ length: 6 }).map((_, i) => addDays(weekStart, i));

  // Month View Dates
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
  const monthDays: Date[] = [];
  let d = startDate;
  while (d <= monthEnd || getDay(d) !== 1) { 
    monthDays.push(d);
    d = addDays(d, 1);
  }

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

  const handleCreateOrUpdateTask = async (data: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>, newMemberIds: string[]) => {
    setIsSubmitting(true);
    try {
      let sourceTodoId = convertingTodoId || (editingTask as ScheduleTask)?.source_todo_id;

      if (editingTask?.id) {
        setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...data, updated_at: new Date().toISOString() } as ScheduleTask : t));
        await dbAdapter.updateScheduleTask(editingTask.id, data, newMemberIds);
        await dbAdapter.logActivity({
          actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
          action_type: 'UPDATE_TASK', target_type: 'ScheduleTask', target_id: editingTask.id, target_label: data.title,
          project_id: data.project_id, project_name: '', before_value: null, after_value: null, message: '編輯排程任務'
        });
      } else {
        const payload = { ...data, source_todo_id: convertingTodoId };
        const newTask = await dbAdapter.createScheduleTask(payload, newMemberIds);
        
        setTasks(prev => [...prev, newTask]);

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
      }

      if (data.status === '完成' && sourceTodoId) {
        await dbAdapter.updateTodo(sourceTodoId, { status: '已完成' });
      }

      setIsFormOpen(false);
      setEditingTask(null);
      setConvertingTodoId(null);
      await fetchData(false);

      if (selectedDayTasks) {
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
    try {
      const dataStr = e.dataTransfer.getData('application/x-schedule-item') || e.dataTransfer.getData('text/plain');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      const { dragId, dragType } = data;
      
      if (dragType !== 'task') return;
      const task = tasks.find(t => t.id === dragId);
      if (!task) return;

      await handleReturnToTodo(task);
    } catch(err) { console.error(err); }
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
        // Optimistic UI Update
        setTasks(prev => prev.map(t => t.id === dragId ? { ...t, task_date: dateStr } : t));
        
        await dbAdapter.updateScheduleTask(dragId, { task_date: dateStr });
        await dbAdapter.logActivity({
          actor_user_id: currentUser?.id || 'system', actor_name: currentUser?.name || 'System',
          action_type: 'RESCHEDULE_TASK', target_type: 'ScheduleTask', target_id: task.id, target_label: task.title,
          project_id: task.project_id, project_name: '', before_value: task.task_date, after_value: dateStr, message: '拖曳改期'
        });
        await fetchData(false);
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
    } catch(err) { console.error(err); }
  };

  const getTaskDisplay = (task: ScheduleTask) => {
    const proj = projects.find(p => p.id === task.project_id);
    const projName = task.project_name || proj?.short_name || proj?.name || '未指定案場';
    const mainUser = users.find(u => u.id === task.main_assignee_id);
    const memberUids = members.filter(m => m.task_id === task.id).map(m => m.user_id);
    const coUsers = users.filter(u => memberUids.includes(u.id));
    // Use the full name if user explicitly wants like 柚子/維揚 instead of just short name, but short_name or name is fine.
    // The prompt says 柚子/維揚. So let's use name.
    const allUsersShort = [mainUser?.name, ...coUsers.map(u => u.name)].filter(Boolean).join('/');
    
    let regionStr = proj?.region || '';
    if (!regionStr && (task.address || proj?.address)) {
      const addr = task.address || proj?.address || '';
      const match = addr.match(/.{2,3}[縣市](.{2,3})[區鄉鎮市]/);
      if (match && match[1]) {
        regionStr = match[1];
      }
    }
    const region = regionStr ? `[${regionStr}]` : '';
    const searchAddress = task.address || proj?.address || projName;

    return { projName, allUsersShort, region, searchAddress };
  };

  return (
    <div className="p-8 h-full flex flex-col min-w-[1500px] mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-6">
          <h1 className="text-3xl font-bold text-slate-100">排程管理</h1>
          
          <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
            <button 
              onClick={() => setViewMode('week')}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${viewMode === 'week' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              週檢視
            </button>
            <button 
              onClick={() => setViewMode('month')}
              className={`px-4 py-1.5 text-sm font-semibold rounded-md transition ${viewMode === 'month' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              月檢視
            </button>
          </div>

          <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg p-1">
            <button 
              onClick={() => setCurrentDate(viewMode === 'week' ? subDays(currentDate, 7) : addDays(currentDate, -30))} 
              className="p-1 hover:bg-slate-700 rounded text-slate-300"
            >
              <ChevronLeft size={20}/>
            </button>
            <span className="text-sm font-semibold text-slate-200 px-2 min-w-[160px] text-center">
              {viewMode === 'week' ? 
                `${format(weekStart, 'yyyy/MM/dd')} - ${format(addDays(weekStart, 5), 'yyyy/MM/dd')}` : 
                format(currentDate, 'yyyy 年 MM 月')}
            </span>
            <button 
              onClick={() => setCurrentDate(viewMode === 'week' ? addDays(currentDate, 7) : addDays(currentDate, 30))} 
              className="p-1 hover:bg-slate-700 rounded text-slate-300"
            >
              <ChevronRight size={20}/>
            </button>
          </div>
        </div>

        <button 
          onClick={() => { setEditingTask(null); setConvertingTodoId(null); setEditingTaskMembers([]); setIsFormOpen(true); }}
          disabled={currentUser?.role === 'VIEWER'}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded shadow transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} />
          新增任務
        </button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-slate-400">載入中...</div>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">
          {viewMode === 'week' ? (
            <div className="flex-1 grid grid-cols-7 border border-slate-700 rounded-xl bg-slate-800/30 overflow-hidden">
              
              {weekDays.map((day, i) => {
                const dateStr = format(day, 'yyyy-MM-dd');
                const dayTasks = sortTasks(tasks.filter(t => t.task_date === dateStr));
                const displayTasks = dayTasks.slice(0, 3);
                const hiddenCount = dayTasks.length - 3;
                
                return (
                  <div 
                    key={i} 
                    className="border-r border-slate-700 flex flex-col"
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
                      className={`text-center py-3 border-b border-slate-700 font-semibold cursor-pointer hover:bg-slate-700/50 transition ${isSameDay(day, new Date()) ? 'text-emerald-400 bg-emerald-950/20' : 'text-slate-300'}`}
                      onClick={() => setSelectedDayTasks({ date: day, tasks: dayTasks })}
                    >
                      <div className="text-sm">週{['日','一','二','三','四','五','六'][day.getDay()]}</div>
                      <div className="text-xl">{format(day, 'd')}</div>
                    </div>
                    <div className="flex-1 p-2 flex flex-col gap-2 overflow-y-auto">
                      {displayTasks.map(task => {
                        const { projName, allUsersShort, region, searchAddress } = getTaskDisplay(task);
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
                              isDone ? 'bg-slate-800 border-slate-700 opacity-40' : 
                              isRescheduled ? 'bg-slate-800 border-dashed border-slate-500 opacity-60' :
                              task.is_tentative ? 'bg-amber-950/40 border-amber-800/50' : 
                              'bg-indigo-950/40 border-indigo-800/50'
                            }`}
                          >
                            <div className={`text-xs font-semibold truncate ${isDone || isRescheduled ? 'text-slate-400' : task.is_tentative ? 'text-amber-300' : 'text-slate-200'}`}>
                              {isDone ? '✓ ' : ''}{isRescheduled ? '【改期】 ' : ''}{task.is_tentative ? '[暫] ' : ''}{projName}
                            </div>
                            <div className={`text-[11px] mt-0.5 font-bold truncate ${isDone || isRescheduled ? 'text-slate-500' : 'text-indigo-300'}`}>
                              {region}[{task.task_type}]
                            </div>
                            <div className={`text-[11px] mt-0.5 truncate ${isDone || isRescheduled ? 'text-slate-500' : 'text-slate-300'}`}>
                              {task.title || '無備註'}
                            </div>
                            {allUsersShort && (
                              <div className={`text-[11px] mt-0.5 truncate ${isDone || isRescheduled ? 'text-slate-600' : 'text-slate-400'}`}>
                                {allUsersShort}
                              </div>
                            )}
                            <div className="text-[11px] mt-1">
                              <a 
                                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchAddress)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className={`underline font-bold transition-colors ${isDone || isRescheduled ? 'text-emerald-700 hover:text-emerald-600' : 'text-emerald-400 hover:text-emerald-300'}`}
                              >
                                MAP
                              </a>
                            </div>
                          </div>
                        );
                      })}
                      {hiddenCount > 0 && (
                        <div 
                          className="text-center text-xs font-bold text-slate-500 hover:text-emerald-400 cursor-pointer mt-1"
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
                className="flex flex-col min-h-[400px] bg-slate-800/50 relative overflow-hidden flex-1"
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
                <div className="text-center py-3 border-b border-slate-700 font-bold text-amber-400 bg-slate-800 flex justify-between items-center px-4 shrink-0">
                  <span>待辦事項</span>
                  <button onClick={() => setIsTodoFormOpen(true)} disabled={currentUser?.role === 'VIEWER'} className="hover:bg-slate-700 p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed" title="新增待辦"><Plus size={16}/></button>
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
                        className="p-2 rounded border border-amber-500/30 bg-slate-800 shadow-sm cursor-pointer hover:border-amber-400 transition"
                      >
                        <div className="text-xs font-semibold text-amber-300 truncate">
                          {projName}
                        </div>
                        <div className="text-xs mt-1 font-bold text-indigo-300 truncate">
                          [{todo.task_type || '未分類'}]
                        </div>
                        <div className="text-xs mt-0.5 text-slate-300 truncate">
                          {todo.title}
                        </div>
                      </div>
                    );
                  })}
                  {todos.filter(t => t.status === '待安排').length === 0 && (
                     <div className="text-xs text-slate-500 text-center mt-4">無待辦事項</div>
                  )}
                </div>
              </div>

            </div>
          ) : (
            <div className="flex-1 flex flex-col border border-slate-700 rounded-xl bg-slate-800/30 overflow-hidden">
              <div className="grid grid-cols-7 bg-slate-800 border-b border-slate-700">
                {['一','二','三','四','五','六','日'].map(d => (
                  <div key={d} className="text-center py-2 text-sm font-bold text-slate-400">週{d}</div>
                ))}
              </div>
              <div className="flex-1 grid grid-cols-7 auto-rows-fr">
                {monthDays.map((day, i) => {
                  const dateStr = format(day, 'yyyy-MM-dd');
                  const dayTasks = sortTasks(tasks.filter(t => t.task_date === dateStr));
                  const isCurrentMonth = day.getMonth() === currentDate.getMonth();
                  
                  return (
                    <div 
                      key={i} 
                      className={`border-r border-b border-slate-700 last:border-r-0 flex flex-col p-1 ${!isCurrentMonth ? 'bg-slate-900/50 opacity-50' : ''}`}
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
                      <div className={`text-right text-xs p-1 font-semibold ${isSameDay(day, new Date()) ? 'text-emerald-400' : 'text-slate-400'}`}>
                        {format(day, 'd')}
                      </div>
                      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
                        {dayTasks.slice(0, 3).map(task => {
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
                              className={`text-[10px] px-1 py-0.5 rounded cursor-pointer truncate ${
                                isDone ? 'bg-slate-800 text-slate-500 opacity-50' : 
                                isRescheduled ? 'bg-slate-800 text-slate-500 border border-dashed border-slate-500 opacity-60' :
                                task.is_tentative ? 'bg-amber-900/50 text-amber-300' : 
                                'bg-indigo-900/50 text-indigo-300'
                              }`}
                            >
                              {isDone ? '✓ ' : ''}{isRescheduled ? '【改期】 ' : ''}{task.is_tentative ? '[暫]' : ''}
                              <span className="font-bold">[{task.task_type}]</span> {getTaskDisplay(task).projName}
                              {task.title ? ` - ${task.title}` : ''}
                            </div>
                          );
                        })}
                        {dayTasks.length > 3 && (
                          <div 
                            className="text-[10px] text-center text-slate-500 cursor-pointer hover:text-emerald-400"
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
        <div className="absolute top-0 right-0 h-full w-96 bg-slate-800 border-l border-slate-700 shadow-2xl flex flex-col transform transition-transform z-10">
          <div className="flex justify-between items-center p-4 border-b border-slate-700">
            <h2 className="text-xl font-bold text-emerald-400">
              {format(selectedDayTasks.date, 'yyyy/MM/dd')} 任務清單
            </h2>
            <button onClick={() => setSelectedDayTasks(null)} className="p-1 hover:bg-slate-700 rounded text-slate-300">
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {selectedDayTasks.tasks.length === 0 ? (
              <div className="text-slate-500 text-center mt-10">尚無排程任務</div>
            ) : (
              selectedDayTasks.tasks.map(task => {
                const { projName, allUsersShort, region, searchAddress } = getTaskDisplay(task);
                return (
                  <div key={task.id} className={`bg-slate-900 border border-slate-700 rounded-lg p-4 ${task.status === '完成' ? 'opacity-50' : ''}`}>
                    <div className="flex justify-between items-start mb-2">
                      <div className="text-sm text-slate-400 font-mono">
                        {task.is_all_day ? '全天' : task.start_time ? `${task.start_time} - ${task.end_time}` : '未指定時間'}
                      </div>
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
                        }} disabled={currentUser?.role === 'VIEWER'} className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed">
                          編輯
                        </button>
                      </div>
                    </div>
                    <div className={`font-semibold text-lg ${task.status === '完成' ? 'line-through text-slate-500' : 'text-slate-200'}`}>
                      {task.status === '完成' ? '✓ ' : ''}{task.is_tentative ? '[暫] ' : ''}{projName}
                    </div>
                    <div className="text-sm text-indigo-400 mt-1 font-bold">{region}[{task.task_type}] {task.title ? task.title : '無備註'}</div>
                    <div className="text-sm text-slate-300 mt-1">人員：{allUsersShort}</div>
                    <div className="text-sm mt-1">
                      <a 
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchAddress)}`}
                        target="_blank" 
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()} 
                        className="text-emerald-400 hover:text-emerald-300 underline font-bold"
                      >MAP</a>
                    </div>
                    <div className="text-xs text-slate-500 mt-2 flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full bg-slate-800`}>{task.status || '正常'}</span>
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
          className="fixed bg-slate-800 border border-slate-700 shadow-xl rounded py-1 z-50 min-w-[120px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button 
            className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={(e) => handleContextAction(e, 'RESCHEDULE_TASK')} disabled={currentUser?.role === 'VIEWER'}
          >改期</button>
          <button 
            className="w-full text-left px-4 py-2 text-sm text-emerald-400 hover:bg-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={(e) => handleContextAction(e, 'COMPLETE_TASK')} disabled={currentUser?.role === 'VIEWER'}
          >完成</button>
          <button 
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={(e) => handleContextAction(e, 'DELETE_TASK')} disabled={currentUser?.role === 'VIEWER'}
          >刪除</button>
        </div>
      )}

      {dayContextMenu && (
        <div 
          className="fixed bg-slate-800 border border-slate-700 rounded shadow-xl py-1 z-50 text-sm min-w-[120px]"
          style={{ top: dayContextMenu.y, left: dayContextMenu.x }}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
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
          className="fixed bg-slate-800 border border-slate-700 rounded shadow-xl py-1 z-50 text-sm min-w-[120px]"
          style={{ top: todoContextMenu.y, left: todoContextMenu.x }}
        >
          {todoContextMenu.todoId ? (
            <button 
              className="w-full text-left px-4 py-2 hover:bg-slate-700 text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
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
              className="w-full text-left px-4 py-2 hover:bg-slate-700 text-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
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
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-5 rounded-2xl w-full max-w-xl max-h-[95vh] overflow-auto shadow-2xl">
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

      {isTodoFormOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-5 rounded-2xl w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-bold text-slate-100 mb-4">新增待辦事項</h2>
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
