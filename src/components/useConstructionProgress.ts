"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { dbAdapter } from '@/lib/db';
import { constructionProgressAdapter, ConstructionCreate, ConstructionUpdate } from '@/lib/db/construction-progress';
import type { Contractor, ProjectConstructionProgress } from '@/lib/db/types';
import { getDatabaseErrorMessage } from '@/lib/db/supabase-errors';
import type { ConstructionConflictRow } from '@/lib/construction-progress';
import { runMutationWithParentRefresh } from '@/lib/mutation-refresh';

export function useConstructionProgress(projectId: string, canEdit: boolean, onMutationSuccess?: () => Promise<void>) {
  const [rows, setRows] = useState<ProjectConstructionProgress[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [conflicts, setConflicts] = useState<ConstructionConflictRow[]>([]);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setLoaded(false);
    setError(null);
    setConflictError(null);
    try {
      const [progress, vendors, conflictResult] = await Promise.all([
        constructionProgressAdapter.list(projectId), dbAdapter.getContractors(),
        constructionProgressAdapter.conflicts(projectId).then(data => ({ data, error: null }), error => ({ data: [], error })),
      ]);
      if (version !== generation.current) return;
      setRows(progress);
      setContractors(vendors);
      setConflicts(conflictResult.data);
      if (conflictResult.error) setConflictError('無法取得包商撞期資訊，請重新載入後確認。');
      setLoaded(true);
    } catch (cause) {
      if (version === generation.current) setError(getDatabaseErrorMessage(cause, '無法載入施工資料'));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => { void load(); return invalidate; }, [load, invalidate]);

  const mutate = async (operation: () => Promise<void>): Promise<boolean> => {
    if (!canEdit || !loaded || loading || lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await runMutationWithParentRefresh(operation, onMutationSuccess);
      return true;
    } catch (cause) {
      setError(getDatabaseErrorMessage(cause, '施工資料儲存失敗，請重試'));
      return false;
    } finally { lock.current = false; setBusy(false); }
  };
  const save = (row: ProjectConstructionProgress | null, values: ConstructionUpdate, create?: ConstructionCreate) => mutate(async () => {
    const saved = row
      ? await constructionProgressAdapter.update(projectId, row.id, values)
      : await constructionProgressAdapter.create(projectId, { ...create!, ...values });
    setRows(current => [...current.filter(item => item.id !== saved.id), saved]);
  });
  const remove = (id: string) => mutate(async () => {
    await constructionProgressAdapter.removeOther(projectId, id);
    setRows(current => current.filter(item => item.id !== id));
  });
  return { rows, contractors, conflicts, conflictError, loading, busy, error, canEdit: canEdit && loaded, save, remove, reload: load };
}

export type ConstructionProgressModel = ReturnType<typeof useConstructionProgress>;
