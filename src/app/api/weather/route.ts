import { unstable_cache } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';
import {
  findCwaLocation,
  isDateWithinWeatherForecast,
  normalizeCwaLocationName,
  selectCwaDaytimeWeather,
  type CwaLocations,
  type WeatherState,
} from '@/lib/weather';

export const dynamic = 'force-dynamic';

const CWA_DATASET_ID = 'F-D0047-093';
const CWA_SUCCESS_CACHE_SECONDS = 86_400;
const CWA_API_URL = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${CWA_DATASET_ID}`;

// F-D0047-093 is the all-Taiwan entry point. Its locationId filter accepts the
// official per-city one-week resource IDs below.
const CWA_WEEKLY_RESOURCE_BY_CITY: Record<string, string> = {
  宜蘭縣: 'F-D0047-003',
  桃園市: 'F-D0047-007',
  新竹縣: 'F-D0047-011',
  苗栗縣: 'F-D0047-015',
  彰化縣: 'F-D0047-019',
  南投縣: 'F-D0047-023',
  雲林縣: 'F-D0047-027',
  嘉義縣: 'F-D0047-031',
  屏東縣: 'F-D0047-035',
  台東縣: 'F-D0047-039',
  花蓮縣: 'F-D0047-043',
  澎湖縣: 'F-D0047-047',
  基隆市: 'F-D0047-051',
  新竹市: 'F-D0047-055',
  嘉義市: 'F-D0047-059',
  台北市: 'F-D0047-063',
  高雄市: 'F-D0047-067',
  新北市: 'F-D0047-071',
  台中市: 'F-D0047-075',
  台南市: 'F-D0047-079',
  連江縣: 'F-D0047-083',
  金門縣: 'F-D0047-087',
};

type CwaApiResponse = {
  success?: boolean | string;
  records?: {
    Locations?: CwaLocations[];
  };
};

type WeatherResponse = {
  weather: WeatherState | null;
};

const noWeather = () => NextResponse.json<WeatherResponse>(
  { weather: null },
  { headers: { 'Cache-Control': 'no-store' } },
);

async function fetchCwaWeather(
  date: string,
  city: string,
  district: string,
): Promise<WeatherState> {
  const apiKey = process.env.CWA_API_KEY;
  if (!apiKey) throw new Error('CWA_API_KEY is unavailable');

  const normalizedCity = normalizeCwaLocationName(city);
  const resourceId = CWA_WEEKLY_RESOURCE_BY_CITY[normalizedCity];
  if (!resourceId) throw new Error('CWA city resource is unavailable');

  const cwaUrl = new URL(CWA_API_URL);
  cwaUrl.searchParams.set('format', 'JSON');
  cwaUrl.searchParams.set('locationId', resourceId);
  cwaUrl.searchParams.set('locationName', district);

  const response = await fetch(cwaUrl, {
    cache: 'no-store',
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`CWA request failed with ${response.status}`);

  const data = await response.json() as CwaApiResponse;
  if (data.success !== true && data.success !== 'true') {
    throw new Error('CWA returned an unsuccessful response');
  }

  const location = findCwaLocation(data.records?.Locations || [], city, district);
  if (!location) throw new Error('CWA city or district was not found');

  const weather = selectCwaDaytimeWeather(location, date);
  if (!weather) throw new Error('CWA daytime forecast was not found');
  return weather;
}

const getCachedCwaWeather = unstable_cache(
  fetchCwaWeather,
  ['cwa-township-weather-v1'],
  { revalidate: CWA_SUCCESS_CACHE_SECONDS },
);

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get('date') || '';
  const city = request.nextUrl.searchParams.get('city') || '';
  const district = request.nextUrl.searchParams.get('district') || '';

  if (!process.env.CWA_API_KEY || !isDateWithinWeatherForecast(date) || !city || !district) {
    return noWeather();
  }

  try {
    const weather = await getCachedCwaWeather(date, city, district);
    return NextResponse.json<WeatherResponse>({ weather });
  } catch {
    return noWeather();
  }
}
