import { parseTaiwanProjectLocation, type TaiwanProjectLocation } from '@/lib/project-location';

export const CWA_FORECAST_DAYS = 7;

export type WeatherState = 'sunny' | 'cloudy' | 'rain' | 'windy';

export type WeatherDisplay = {
  icon: string;
  label: string;
};

type WeatherTaskSource = {
  task_date: string;
  address: string | null;
  project_id: string | null;
};

type WeatherProjectSource = {
  id: string;
  address: string | null;
  region: string | null;
};

export type WeatherRequest = TaiwanProjectLocation & {
  date: string;
  key: string;
};

export type CwaElementValue = {
  Weather?: string;
  WeatherCode?: string;
  WindSpeed?: string;
  BeaufortScale?: string;
};

export type CwaForecastTime = {
  DataTime?: string;
  StartTime?: string;
  EndTime?: string;
  ElementValue?: CwaElementValue | CwaElementValue[];
};

export type CwaWeatherElement = {
  ElementName?: string;
  Time?: CwaForecastTime[];
};

export type CwaLocation = {
  LocationName?: string;
  WeatherElement?: CwaWeatherElement[];
};

export type CwaLocations = {
  LocationsName?: string;
  Location?: CwaLocation[];
};

export const WEATHER_STATE_DISPLAY: Record<WeatherState, WeatherDisplay> = {
  sunny: { icon: '☀', label: '晴' },
  cloudy: { icon: '☁', label: '陰' },
  rain: { icon: '🌧', label: '雨' },
  windy: { icon: '💨', label: '風' },
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RAIN_PATTERN = /雨|雷|降水/;
const CLOUDY_PATTERN = /陰|多雲|霧/;
const STRONG_WIND_BEAUFORT = 6;
const STRONG_WIND_METERS_PER_SECOND = 10.8;

const WEATHER_PRIORITY: Record<WeatherState, number> = {
  sunny: 1,
  cloudy: 2,
  windy: 3,
  rain: 4,
};

function getDateOrdinal(date: string): number | null {
  const match = date.match(DATE_PATTERN);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ordinal = Date.UTC(year, month - 1, day) / 86_400_000;
  const validated = new Date(ordinal * 86_400_000);

  if (
    validated.getUTCFullYear() !== year
    || validated.getUTCMonth() + 1 !== month
    || validated.getUTCDate() !== day
  ) {
    return null;
  }

  return ordinal;
}

function parseCwaNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value || '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function getElementValues(time: CwaForecastTime): CwaElementValue[] {
  if (Array.isArray(time.ElementValue)) return time.ElementValue;
  return time.ElementValue ? [time.ElementValue] : [];
}

function isDaytimeForecast(time: CwaForecastTime, date: string): boolean {
  if (time.DataTime) {
    const hour = Number(time.DataTime.slice(11, 13));
    return time.DataTime.slice(0, 10) === date && hour >= 9 && hour < 18;
  }

  if (!time.StartTime || !time.EndTime || time.StartTime.slice(0, 10) !== date) return false;
  const startHour = Number(time.StartTime.slice(11, 13));
  const endHour = Number(time.EndTime.slice(11, 13));
  return startHour < 18 && endHour > 9;
}

function getForecastTimeKey(time: CwaForecastTime): string | null {
  if (time.DataTime) return time.DataTime;
  if (time.StartTime && time.EndTime) return `${time.StartTime}_${time.EndTime}`;
  return null;
}

export function normalizeCwaLocationName(value: string | null | undefined): string {
  return (value || '').trim().replace(/臺/g, '台');
}

export function getTaipeiTodayDateString(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isDateWithinWeatherForecast(
  date: string,
  today = getTaipeiTodayDateString(),
): boolean {
  const dateOrdinal = getDateOrdinal(date);
  const todayOrdinal = getDateOrdinal(today);
  if (dateOrdinal === null || todayOrdinal === null) return false;

  const dayOffset = dateOrdinal - todayOrdinal;
  return dayOffset >= 0 && dayOffset < CWA_FORECAST_DAYS;
}

export function buildWeatherLocationKey(
  date: string,
  city: string,
  district: string,
): string {
  return `${date}_${city}_${district}`;
}

export function resolveTaskWeatherRequest(
  task: WeatherTaskSource,
  project: WeatherProjectSource | undefined,
  today = getTaipeiTodayDateString(),
): WeatherRequest | null {
  if (!isDateWithinWeatherForecast(task.task_date, today)) return null;

  const location = parseTaiwanProjectLocation(task.address)
    || parseTaiwanProjectLocation(project?.address)
    || parseTaiwanProjectLocation(project?.region);
  if (!location) return null;

  return {
    ...location,
    date: task.task_date,
    key: buildWeatherLocationKey(task.task_date, location.city, location.district),
  };
}

export function collectUniqueWeatherRequests(
  tasks: WeatherTaskSource[],
  projects: WeatherProjectSource[],
  today = getTaipeiTodayDateString(),
): WeatherRequest[] {
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const requests = new Map<string, WeatherRequest>();

  tasks.forEach(task => {
    const project = task.project_id ? projectsById.get(task.project_id) : undefined;
    const request = resolveTaskWeatherRequest(task, project, today);
    if (request) requests.set(request.key, request);
  });

  return Array.from(requests.values());
}

export function classifyCwaWeather(
  weatherDescription: string | null | undefined,
  windSpeedMetersPerSecond?: string | number | null,
  beaufortScale?: string | number | null,
): WeatherState | null {
  const description = String(weatherDescription || '').trim();
  if (RAIN_PATTERN.test(description)) return 'rain';

  const windSpeed = parseCwaNumber(windSpeedMetersPerSecond);
  const beaufort = parseCwaNumber(beaufortScale);
  if (
    (beaufort !== null && beaufort >= STRONG_WIND_BEAUFORT)
    || (windSpeed !== null && windSpeed >= STRONG_WIND_METERS_PER_SECOND)
  ) {
    return 'windy';
  }

  if (description.startsWith('晴')) return 'sunny';
  if (CLOUDY_PATTERN.test(description)) return 'cloudy';
  if (description.includes('晴')) return 'sunny';
  return null;
}

export function findCwaLocation(
  locationGroups: CwaLocations[],
  city: string,
  district: string,
): CwaLocation | null {
  const normalizedCity = normalizeCwaLocationName(city);
  const normalizedDistrict = normalizeCwaLocationName(district);
  const cityGroup = locationGroups.find(group => (
    normalizeCwaLocationName(group.LocationsName) === normalizedCity
  ));
  if (!cityGroup) return null;

  return cityGroup.Location?.find(location => (
    normalizeCwaLocationName(location.LocationName) === normalizedDistrict
  )) || null;
}

export function selectCwaDaytimeWeather(
  location: CwaLocation,
  date: string,
): WeatherState | null {
  const forecasts = new Map<string, {
    weatherDescription?: string;
    windSpeed?: string;
    beaufortScale?: string;
  }>();

  (location.WeatherElement || []).forEach(element => {
    (element.Time || []).filter(time => isDaytimeForecast(time, date)).forEach(time => {
      const key = getForecastTimeKey(time);
      if (!key) return;

      const forecast = forecasts.get(key) || {};
      getElementValues(time).forEach(value => {
        if (value.Weather) forecast.weatherDescription = value.Weather;
        if (value.WindSpeed) forecast.windSpeed = value.WindSpeed;
        if (value.BeaufortScale) forecast.beaufortScale = value.BeaufortScale;
      });
      forecasts.set(key, forecast);
    });
  });

  let selectedWeather: WeatherState | null = null;
  forecasts.forEach(forecast => {
    const weather = classifyCwaWeather(
      forecast.weatherDescription,
      forecast.windSpeed,
      forecast.beaufortScale,
    );
    if (weather && (!selectedWeather || WEATHER_PRIORITY[weather] > WEATHER_PRIORITY[selectedWeather])) {
      selectedWeather = weather;
    }
  });

  return selectedWeather;
}
