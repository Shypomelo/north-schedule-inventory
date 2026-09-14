"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

export type RowAutosaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UseRowAutosaveOptions<T extends { id: string }> {
  rows: T[];
  setRows: (rows: T[]) => void;
  saveRow: (row: T) => Promise<T>;
  validate?: (row: T) => string | null;
  onError: (error: unknown, validationMessage?: string) => void;
  delay?: number;
}

export function useRowAutosave<T extends { id: string }>({
  rows,
  setRows,
  saveRow,
  validate,
  onError,
  delay = 700,
}: UseRowAutosaveOptions<T>) {
  const rowsRef = useRef(rows);
  const saveRowRef = useRef(saveRow);
  const validateRef = useRef(validate);
  const onErrorRef = useRef(onError);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const versionsRef = useRef(new Map<string, number>());
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const mountedRef = useRef(true);
  const [states, setStates] = useState<Record<string, RowAutosaveState>>({});

  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => { saveRowRef.current = saveRow; }, [saveRow]);
  useEffect(() => { validateRef.current = validate; }, [validate]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      timersRef.current.forEach(timer => clearTimeout(timer));
    };
  }, []);

  const setRowState = useCallback((id: string, state: RowAutosaveState) => {
    if (!mountedRef.current) return;
    setStates(current => ({ ...current, [id]: state }));
  }, []);

  const persist = useCallback((id: string, version: number) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);

    const previous = queuesRef.current.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (versionsRef.current.get(id) !== version) return;
      const snapshot = rowsRef.current.find(row => row.id === id);
      if (!snapshot) return;
      const validationMessage = validateRef.current?.(snapshot) ?? null;
      if (validationMessage) {
        setRowState(id, 'error');
        onErrorRef.current(new Error(validationMessage), validationMessage);
        return;
      }

      setRowState(id, 'saving');
      try {
        const saved = await saveRowRef.current(snapshot);
        if (!mountedRef.current || versionsRef.current.get(id) !== version) return;
        const next = rowsRef.current.map(row => row.id === id ? saved : row);
        rowsRef.current = next;
        setRows(next);
        setRowState(id, 'saved');
      } catch (error) {
        if (versionsRef.current.get(id) !== version) return;
        setRowState(id, 'error');
        onErrorRef.current(error);
      }
    });
    queuesRef.current.set(id, task);
    void task.finally(() => {
      if (queuesRef.current.get(id) === task) queuesRef.current.delete(id);
    });
  }, [setRowState, setRows]);

  const schedule = useCallback((id: string) => {
    const version = (versionsRef.current.get(id) ?? 0) + 1;
    versionsRef.current.set(id, version);
    const previousTimer = timersRef.current.get(id);
    if (previousTimer) clearTimeout(previousTimer);
    setRowState(id, 'saving');
    timersRef.current.set(id, setTimeout(() => persist(id, version), delay));
  }, [delay, persist, setRowState]);

  const updateRow = useCallback((id: string, updates: Partial<T>) => {
    const next = rowsRef.current.map(row => row.id === id ? { ...row, ...updates } : row);
    rowsRef.current = next;
    setRows(next);
    schedule(id);
  }, [schedule, setRows]);

  const flush = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timersRef.current.delete(id);
    persist(id, versionsRef.current.get(id) ?? 0);
  }, [persist]);

  const cancel = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
    versionsRef.current.set(id, (versionsRef.current.get(id) ?? 0) + 1);
    setStates(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  return {
    updateRow,
    flush,
    cancel,
    stateFor: (id: string): RowAutosaveState => states[id] ?? 'idle',
  };
}
