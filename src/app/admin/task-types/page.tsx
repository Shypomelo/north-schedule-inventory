"use client";

import { DragEvent, FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, ListChecks, Pencil, Plus } from 'lucide-react';
import { useUser } from '@/components/UserContext';
import { dbAdapter } from '@/lib/db';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import { ScheduleTaskType } from '@/lib/db/types';

type DropTarget = {
  id: string;
  edge: 'before' | 'after';
};

export default function AdminTaskTypesPage() {
  const router = useRouter();
  const { currentUser, isLoading: contextLoading } = useUser();
  const isAdmin = currentUser?.role === 'ADMIN';
  const [taskTypes, setTaskTypes] = useState<ScheduleTaskType[]>([]);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [isReordering, setIsReordering] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTaskTypes = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setTaskTypes(await dbAdapter.listScheduleTaskTypes());
    } catch (loadError) {
      setError(getDatabaseErrorMessage(loadError, '無法載入任務類型'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (contextLoading) return;
    if (!isAdmin) {
      router.replace('/');
      return;
    }
    void loadTaskTypes();
  }, [contextLoading, isAdmin, loadTaskTypes, router]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setSavingId('new');
    setError(null);
    try {
      const nextSortOrder = taskTypes.reduce((max, taskType) => Math.max(max, taskType.sort_order), -1) + 1;
      await dbAdapter.createScheduleTaskType({ name, sort_order: nextSortOrder });
      setNewName('');
      await loadTaskTypes();
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '新增任務類型失敗'));
    } finally {
      setSavingId(null);
    }
  };

  const handleRename = async (taskType: ScheduleTaskType) => {
    const name = editingName.trim();
    if (!name) return;
    setSavingId(taskType.id);
    setError(null);
    try {
      await dbAdapter.updateScheduleTaskType(taskType.id, { name });
      setEditingId(null);
      await loadTaskTypes();
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, '修改任務類型失敗'));
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleActive = async (taskType: ScheduleTaskType) => {
    const nextActive = !taskType.is_active;
    if (!window.confirm(`確定要${nextActive ? '啟用' : '停用'}「${taskType.name}」嗎？`)) return;
    setSavingId(taskType.id);
    setError(null);
    try {
      await dbAdapter.updateScheduleTaskType(taskType.id, { is_active: nextActive });
      await loadTaskTypes();
    } catch (saveError) {
      setError(getDatabaseErrorMessage(saveError, `${nextActive ? '啟用' : '停用'}任務類型失敗`));
    } finally {
      setSavingId(null);
    }
  };

  const getDropEdge = (event: DragEvent<HTMLDivElement>): DropTarget['edge'] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
  };

  const resetDragState = () => {
    setDraggedId(null);
    setDropTarget(null);
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, id: string) => {
    if (!isAdmin || isReordering || savingId !== null) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    setDraggedId(id);
    setDropTarget(null);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, id: string) => {
    if (!draggedId || draggedId === id || isReordering) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ id, edge: getDropEdge(event) });
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    if (!draggedId || draggedId === targetId || isReordering) {
      resetDragState();
      return;
    }

    const originalTaskTypes = taskTypes;
    const sourceIndex = originalTaskTypes.findIndex(taskType => taskType.id === draggedId);
    const targetIndex = originalTaskTypes.findIndex(taskType => taskType.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) {
      resetDragState();
      return;
    }

    const edge = getDropEdge(event);
    const reorderedTaskTypes = [...originalTaskTypes];
    const [draggedTaskType] = reorderedTaskTypes.splice(sourceIndex, 1);
    let insertIndex = targetIndex + (edge === 'after' ? 1 : 0);
    if (sourceIndex < insertIndex) insertIndex -= 1;
    reorderedTaskTypes.splice(insertIndex, 0, draggedTaskType);

    const nextTaskTypes = reorderedTaskTypes.map((taskType, sort_order) => ({
      ...taskType,
      sort_order,
    }));
    const orderChanged = nextTaskTypes.some((taskType, index) => (
      taskType.id !== originalTaskTypes[index]?.id
    ));
    resetDragState();
    if (!orderChanged) return;

    setTaskTypes(nextTaskTypes);
    setIsReordering(true);
    setError(null);
    try {
      await dbAdapter.reorderScheduleTaskTypes(nextTaskTypes.map(taskType => taskType.id));
    } catch {
      setTaskTypes(originalTaskTypes);
      setError('排序更新失敗');
    } finally {
      setIsReordering(false);
    }
  };

  if (contextLoading || !isAdmin) {
    return <div className="p-8 text-center text-secondary">驗證權限中...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
      <div className="bg-card p-6 rounded-xl border border-theme-border shadow-sm">
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <ListChecks className="text-accent" />
          系統管理 - 任務類型
        </h1>
        <p className="text-sm text-secondary mt-1">名稱修改只套用於未來選擇；既有任務會保留原始類型文字。</p>
      </div>

      <form onSubmit={handleCreate} className="bg-card/40 border border-theme-border rounded-xl p-4 flex gap-3">
        <input
          value={newName}
          onChange={event => setNewName(event.target.value)}
          placeholder="新增任務類型名稱"
          className="flex-1 bg-page border border-theme-border rounded-lg px-3 py-2 text-primary focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!newName.trim() || savingId === 'new'}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white disabled:opacity-50 transition"
        >
          <Plus size={17} />新增
        </button>
      </form>

      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-danger">{error}</div>}

      <div className="bg-card/40 border border-theme-border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-secondary">載入中...</div>
        ) : taskTypes.length === 0 ? (
          <div className="p-8 text-center text-secondary/70">尚無任務類型</div>
        ) : (
          <div className="divide-y divide-theme-border">
            {taskTypes.map(taskType => {
              const isDragged = draggedId === taskType.id;
              const isDropTarget = dropTarget?.id === taskType.id;

              return (
              <div
                key={taskType.id}
                onDragOver={event => handleDragOver(event, taskType.id)}
                onDrop={event => void handleDrop(event, taskType.id)}
                className={`p-4 flex flex-col sm:flex-row sm:items-center gap-3 transition-colors ${isDragged ? 'opacity-50 bg-page/60' : ''} ${isDropTarget && dropTarget.edge === 'before' ? 'border-t-2 border-accent bg-accent/5' : ''} ${isDropTarget && dropTarget.edge === 'after' ? 'border-b-2 border-accent bg-accent/5' : ''}`}
              >
                <button
                  type="button"
                  draggable={isAdmin && !isReordering && savingId === null}
                  disabled={!isAdmin || isReordering || savingId !== null}
                  onDragStart={event => handleDragStart(event, taskType.id)}
                  onDragEnd={resetDragState}
                  aria-label={`拖曳排序：${taskType.name}`}
                  title="拖曳排序"
                  className="self-start sm:self-auto shrink-0 rounded p-1.5 text-secondary hover:bg-card hover:text-primary cursor-grab active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <GripVertical size={20} aria-hidden="true" />
                </button>
                <div className="w-20 shrink-0">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${taskType.is_active ? 'border-success/20 bg-success/10 text-success' : 'border-theme-border bg-card text-secondary'}`}>
                    {taskType.is_active ? '啟用' : '停用'}
                  </span>
                </div>

                <div className="flex-1">
                  {editingId === taskType.id ? (
                    <input
                      autoFocus
                      value={editingName}
                      onChange={event => setEditingName(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') void handleRename(taskType);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                      className="w-full bg-page border border-theme-border rounded px-3 py-2 text-primary focus:outline-none focus:border-accent"
                    />
                  ) : (
                    <span className="font-medium text-primary">{taskType.name}</span>
                  )}
                </div>

                <div className="flex gap-2">
                  {editingId === taskType.id ? (
                    <>
                      <button
                        type="button"
                        disabled={!editingName.trim() || savingId === taskType.id}
                        onClick={() => void handleRename(taskType)}
                        className="px-3 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm disabled:opacity-50 transition"
                      >儲存</button>
                      <button type="button" onClick={() => setEditingId(null)} className="px-3 py-2 rounded bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary text-sm transition">取消</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(taskType.id);
                        setEditingName(taskType.name);
                      }}
                      className="flex items-center gap-1 px-3 py-2 rounded bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary text-sm transition"
                    ><Pencil size={14} />修改名稱</button>
                  )}
                  <button
                    type="button"
                    disabled={isReordering || savingId === taskType.id}
                    onClick={() => void handleToggleActive(taskType)}
                    className={`px-3 py-2 rounded text-sm disabled:opacity-50 transition ${taskType.is_active ? 'bg-warning/10 hover:bg-warning/20 text-warning' : 'bg-success/10 hover:bg-success/20 text-success'}`}
                  >{taskType.is_active ? '停用' : '啟用'}</button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
