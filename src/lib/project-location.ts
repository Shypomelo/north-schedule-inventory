import type { Project } from '@/lib/db/types';

export type TaiwanProjectLocation = {
  city: string;
  district: string;
};

type ProjectSearchSource = Pick<
  Project,
  'name' | 'short_name' | 'project_code' | 'address' | 'region'
>;

const TAIWAN_CITIES = [
  '台北市',
  '新北市',
  '桃園市',
  '台中市',
  '台南市',
  '高雄市',
  '基隆市',
  '新竹市',
  '嘉義市',
  '新竹縣',
  '苗栗縣',
  '彰化縣',
  '南投縣',
  '雲林縣',
  '嘉義縣',
  '屏東縣',
  '宜蘭縣',
  '花蓮縣',
  '台東縣',
  '澎湖縣',
  '金門縣',
  '連江縣',
] as const;

const LEGACY_CITY_NAMES: Record<string, string> = {
  台北縣: '新北市',
  桃園縣: '桃園市',
};

const normalizeTaiwanCharacters = (value: string): string => value.replace(/臺/g, '台');

export function normalizeProjectSearchText(value: string | null | undefined): string {
  return normalizeTaiwanCharacters((value || '').trim().toLocaleLowerCase('zh-TW'))
    .replace(/[\s\u3000]+/g, '');
}

export function parseTaiwanProjectLocation(
  address: string | null | undefined,
): TaiwanProjectLocation | null {
  const normalizedAddress = normalizeTaiwanCharacters((address || '').trim())
    .replace(/[\s\u3000]+/g, '');
  if (!normalizedAddress) return null;

  const cityCandidates = [
    ...TAIWAN_CITIES.map(city => ({ source: city, canonical: city })),
    ...Object.entries(LEGACY_CITY_NAMES).map(([source, canonical]) => ({ source, canonical })),
  ];
  const cityMatch = cityCandidates
    .map(candidate => ({ ...candidate, index: normalizedAddress.indexOf(candidate.source) }))
    .filter(candidate => candidate.index >= 0)
    .sort((a, b) => a.index - b.index)[0];

  if (!cityMatch) return null;

  const afterCity = normalizedAddress.slice(cityMatch.index + cityMatch.source.length);
  const districtMatch = afterCity.match(/^(.{1,6}?(?:區|鄉|鎮|市))/);
  if (!districtMatch) return null;

  return {
    city: cityMatch.canonical,
    district: districtMatch[1],
  };
}

const removeAdministrativeSuffix = (value: string): string => value.replace(/[市縣區鄉鎮]$/, '');

const getLocationSearchValues = (project: ProjectSearchSource): string[] => {
  const location = parseTaiwanProjectLocation(project.address)
    || parseTaiwanProjectLocation(project.region);
  if (!location) return [];

  const cityShort = removeAdministrativeSuffix(location.city);
  const districtShort = removeAdministrativeSuffix(location.district);
  return [
    location.city,
    location.district,
    `${location.city}${location.district}`,
    cityShort,
    districtShort,
    `${cityShort}${location.district}`,
    `${cityShort}${districtShort}`,
  ];
};

export function buildProjectSearchableText(
  project: ProjectSearchSource,
  additionalValues: Array<string | null | undefined> = [],
): string {
  return [
    project.name,
    project.short_name,
    project.project_code,
    project.address,
    project.region,
    ...getLocationSearchValues(project),
    ...additionalValues,
  ]
    .map(normalizeProjectSearchText)
    .filter(Boolean)
    .join('\n');
}

const getSearchTokens = (query: string): string[] => query
  .trim()
  .split(/[\s\u3000]+/)
  .map(normalizeProjectSearchText)
  .filter(Boolean);

export function projectMatchesSearchQuery(
  project: ProjectSearchSource,
  query: string,
  additionalValues: Array<string | null | undefined> = [],
): boolean {
  const tokens = getSearchTokens(query);
  if (tokens.length === 0) return true;

  const searchableText = buildProjectSearchableText(project, additionalValues);
  return tokens.every(token => searchableText.includes(token));
}

export function getProjectSearchScore(
  project: ProjectSearchSource,
  query: string,
  additionalValues: Array<string | null | undefined> = [],
): number {
  if (!projectMatchesSearchQuery(project, query, additionalValues)) return 0;

  const normalizedQuery = normalizeProjectSearchText(query);
  let score = 1;
  if (normalizeProjectSearchText(project.name).includes(normalizedQuery)) score += 100;
  if (normalizeProjectSearchText(project.short_name).includes(normalizedQuery)) score += 80;
  if (normalizeProjectSearchText(project.project_code).includes(normalizedQuery)) score += 60;

  const locationText = [
    project.address,
    project.region,
    ...getLocationSearchValues(project),
  ].map(normalizeProjectSearchText).join('\n');
  if (locationText.includes(normalizedQuery)) score += 40;
  if (additionalValues.some(value => normalizeProjectSearchText(value).includes(normalizedQuery))) {
    score += 20;
  }

  return score;
}

export function getProjectLocationLabel(project: ProjectSearchSource): string | null {
  const location = parseTaiwanProjectLocation(project.address)
    || parseTaiwanProjectLocation(project.region);
  if (location) return `${location.city}${location.district}`;
  return project.region?.trim() || null;
}
