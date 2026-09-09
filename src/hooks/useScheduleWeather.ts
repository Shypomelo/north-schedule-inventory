import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ScheduleTask } from '@/lib/db/types';
import {
  collectUniqueWeatherRequests,
  resolveTaskWeatherRequest,
  WEATHER_STATE_DISPLAY,
  type WeatherDisplay,
  type WeatherState,
} from '@/lib/weather';

export function useScheduleWeather(tasks: ScheduleTask[], projects: Project[]) {
  const [weatherByKey, setWeatherByKey] = useState<Map<string, WeatherState | null>>(() => new Map());
  const weatherCacheRef = useRef<Map<string, WeatherState | null>>(new Map());
  const requestedWeatherKeysRef = useRef<Set<string>>(new Set());
  const weatherRequests = useMemo(
    () => collectUniqueWeatherRequests(tasks, projects),
    [projects, tasks],
  );

  useEffect(() => {
    const missingRequests = weatherRequests.filter(request => (
      !weatherCacheRef.current.has(request.key)
      && !requestedWeatherKeysRef.current.has(request.key)
    ));
    if (missingRequests.length === 0) return;

    missingRequests.forEach(request => requestedWeatherKeysRef.current.add(request.key));
    void Promise.all(missingRequests.map(async weatherRequest => {
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

  return (task: ScheduleTask): WeatherDisplay | null => {
    const project = projects.find(candidate => candidate.id === task.project_id);
    const weatherRequest = resolveTaskWeatherRequest(task, project);
    if (!weatherRequest) return null;
    const weather = weatherByKey.get(weatherRequest.key);
    return weather ? WEATHER_STATE_DISPLAY[weather] : null;
  };
}
