"use client";

import { useEffect, useMemo, useState } from 'react';
import { dbAdapter } from '@/lib/db';
import { ScheduleTaskType } from '@/lib/db/types';

interface UseScheduleTaskTypesOptions {
  currentValue?: string | null;
  preserveCurrentValue?: boolean;
}

export function useScheduleTaskTypes({
  currentValue,
  preserveCurrentValue = false,
}: UseScheduleTaskTypesOptions = {}) {
  const [taskTypes, setTaskTypes] = useState<ScheduleTaskType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    dbAdapter.listScheduleTaskTypes()
      .then(data => {
        if (isMounted) setTaskTypes(data);
      })
      .catch(fetchError => {
        console.error('Failed to load schedule task types:', fetchError);
        if (isMounted) setError('任務類型載入失敗');
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const activeTaskTypes = useMemo(() => taskTypes
    .filter(taskType => taskType.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hant')),
  [taskTypes]);

  const currentMasterType = taskTypes.find(taskType => taskType.name === currentValue);
  const shouldShowLegacyValue = Boolean(
    preserveCurrentValue
    && currentValue
    && (!currentMasterType || !currentMasterType.is_active),
  );
  const defaultTaskType = activeTaskTypes.find(taskType => taskType.name === '維修')?.name
    ?? activeTaskTypes[0]?.name
    ?? '';

  return {
    activeTaskTypes,
    defaultTaskType,
    error,
    isLoading,
    shouldShowLegacyValue,
  };
}
