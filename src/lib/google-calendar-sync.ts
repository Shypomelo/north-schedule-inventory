import type { calendar_v3 } from 'googleapis';
import type { ScheduleTask } from '@/lib/db/types';

export const GOOGLE_SYNC_SOURCE = 'north-schedule-inventory';

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const GOOGLE_TIME_ZONE = 'Asia/Taipei';

type SupabaseClientLike = {
  from: (table: string) => any;
};

type ScheduleTaskSyncRow = {
  id: string;
  task_type: string | null;
  title: string | null;
  project_id: string | null;
  project_name: string | null;
  address: string | null;
  task_date: string | null;
  start_time: string | null;
  end_time: string | null;
  is_all_day: boolean | null;
  is_tentative: boolean | null;
  status: string | null;
  primary_member_id: string | null;
  primary_member_name: string | null;
  assistant_member_ids: string[] | string | null;
  assistant_member_names: string[] | string | null;
  google_calendar_id: string | null;
  google_event_id: string | null;
  google_sync_status: string | null;
  google_sync_error: string | null;
  last_synced_at: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type GoogleEventTiming = {
  task_date: string;
  start_time: string | null;
  end_time: string | null;
  is_all_day: boolean;
};

export type ManualGoogleEventSkipReason =
  | 'missing_event_id'
  | 'missing_summary'
  | 'missing_creator_email'
  | 'creator_not_active_team_member'
  | 'no_project_match'
  | 'ambiguous_project_match'
  | 'unsupported_multi_day_event'
  | 'invalid_time';

export type GoogleImportMember = {
  id: string;
  email: string;
  google_calendar_email: string | null;
  name: string;
};

export type GoogleImportProject = {
  id: string;
  project_name: string;
  project_short_name: string | null;
  project_code: string | null;
  address: string | null;
};

export type ManualScheduleTaskInsert = {
  project_id: string | null;
  project_name: string;
  task_type: '其他';
  title: string;
  notes: string | null;
  task_date: string;
  start_time: string | null;
  end_time: string | null;
  is_all_day: boolean;
  primary_member_id: string;
  primary_member_name: string;
  assistant_member_ids: string[];
  assistant_member_names: string[];
  status: '已排程';
  is_tentative: false;
  address: string | null;
  google_maps_url: null;
  google_calendar_id: string;
  google_event_id: string;
  google_sync_status: 'synced';
  google_sync_error: null;
  last_synced_at: string;
  created_by: 'google-calendar-import';
  updated_by: 'google-calendar-import';
};

export type ManualGoogleEventMapping =
  | { ok: true; task: ManualScheduleTaskInsert }
  | { ok: false; reason: ManualGoogleEventSkipReason };

const toArray = (value: string[] | string | null | undefined): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map(item => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
};

const sanitizeVisibleValue = (value: string | null | undefined, fallback: string): string => {
  const trimmed = (value || '').trim();
  if (!trimmed) return fallback;
  const withoutUuids = trimmed.replace(UUID_PATTERN, '').trim();
  return withoutUuids || fallback;
};

const formatReadableStatus = (status: string | null | undefined): string => {
  if (!status || status === '未開始' || status === '進行中') return '已排程';
  if (status === '完成' || status === '已完成') return '已完成';
  return sanitizeVisibleValue(status, '已排程');
};

const formatTaipeiParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: GOOGLE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find(part => part.type === type)?.value || '';

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
};

const isDateOnly = (value: string | null | undefined): value is string => (
  !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
);

const addUtcDateDays = (dateString: string, days: number): string | null => {
  if (!isDateOnly(dateString)) return null;
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const normalizeExactText = (value: string | null | undefined): string => (
  (value || '').trim().toLocaleLowerCase('zh-TW')
);

const normalizeEmail = (value: string | null | undefined): string => (
  (value || '').trim().toLowerCase()
);

const findExactProject = (
  event: calendar_v3.Schema$Event,
  projects: GoogleImportProject[],
):
  | { ok: true; project: GoogleImportProject }
  | { ok: false; reason: 'no_project_match' | 'ambiguous_project_match' } => {
  const summary = (event.summary || '').trim();
  const bracketMatch = summary.match(/^【([^】]+)】/);
  const summaryKeys = new Set(
    [bracketMatch?.[1], summary]
      .map(normalizeExactText)
      .filter(Boolean),
  );
  const locationKey = normalizeExactText(event.location);

  const matches = projects.filter((project) => {
    const identifiers = [
      project.project_name,
      project.project_short_name,
      project.project_code,
    ].map(normalizeExactText).filter(Boolean);
    const summaryMatches = identifiers.some(identifier => summaryKeys.has(identifier));
    const locationMatches = !!locationKey
      && normalizeExactText(project.address) === locationKey;
    return summaryMatches || locationMatches;
  });

  if (matches.length === 1) return { ok: true, project: matches[0] };
  return {
    ok: false,
    reason: matches.length === 0 ? 'no_project_match' : 'ambiguous_project_match',
  };
};

const getManualGoogleEventTiming = (
  event: calendar_v3.Schema$Event,
): { ok: true; timing: GoogleEventTiming } | { ok: false; reason: 'invalid_time' | 'unsupported_multi_day_event' } => {
  if (event.start?.date || event.end?.date) {
    if (!isDateOnly(event.start?.date) || !isDateOnly(event.end?.date)) {
      return { ok: false, reason: 'invalid_time' };
    }
    if (addUtcDateDays(event.start.date, 1) !== event.end.date) {
      return { ok: false, reason: 'unsupported_multi_day_event' };
    }
    return {
      ok: true,
      timing: {
        task_date: event.start.date,
        start_time: null,
        end_time: null,
        is_all_day: true,
      },
    };
  }

  if (!event.start?.dateTime || !event.end?.dateTime) {
    return { ok: false, reason: 'invalid_time' };
  }

  const startDate = new Date(event.start.dateTime);
  const endDate = new Date(event.end.dateTime);
  if (
    Number.isNaN(startDate.getTime())
    || Number.isNaN(endDate.getTime())
    || endDate.getTime() <= startDate.getTime()
  ) {
    return { ok: false, reason: 'invalid_time' };
  }

  const start = formatTaipeiParts(startDate);
  const end = formatTaipeiParts(endDate);
  if (start.date !== end.date) {
    return { ok: false, reason: 'unsupported_multi_day_event' };
  }

  return {
    ok: true,
    timing: {
      task_date: start.date,
      start_time: start.time,
      end_time: end.time,
      is_all_day: false,
    },
  };
};

export function isSystemManagedGoogleEvent(event: calendar_v3.Schema$Event): boolean {
  const privateProperties = event.extendedProperties?.private;
  return privateProperties?.source === GOOGLE_SYNC_SOURCE
    || !!privateProperties?.scheduleTaskId;
}

export function mapManualGoogleEvent(
  event: calendar_v3.Schema$Event,
  options: {
    calendarId: string;
    activeMembers: GoogleImportMember[];
    projects: GoogleImportProject[];
    syncedAt: string;
  },
): ManualGoogleEventMapping {
  if (!event.id) return { ok: false, reason: 'missing_event_id' };

  const title = (event.summary || '').trim();
  if (!title) return { ok: false, reason: 'missing_summary' };

  const creatorEmail = normalizeEmail(event.creator?.email);
  if (!creatorEmail) return { ok: false, reason: 'missing_creator_email' };

  const calendarEmailMatches = options.activeMembers.filter(
    member => normalizeEmail(member.google_calendar_email) === creatorEmail,
  );
  const systemEmailMatches = options.activeMembers.filter(
    member => normalizeEmail(member.email) === creatorEmail,
  );
  const memberMatches = calendarEmailMatches.length > 0
    ? calendarEmailMatches
    : systemEmailMatches;
  if (memberMatches.length !== 1) {
    return { ok: false, reason: 'creator_not_active_team_member' };
  }

  const timingResult = getManualGoogleEventTiming(event);
  if (!timingResult.ok) return timingResult;

  const member = memberMatches[0];
  const projectMatch = findExactProject(event, options.projects);
  if (!projectMatch.ok) return projectMatch;

  const project = projectMatch.project;
  const notes = (event.description || '').trim() || null;
  const address = (event.location || '').trim() || null;

  return {
    ok: true,
    task: {
      project_id: project.id,
      project_name: project.project_name,
      task_type: '其他',
      title,
      notes,
      task_date: timingResult.timing.task_date,
      start_time: timingResult.timing.start_time,
      end_time: timingResult.timing.end_time,
      is_all_day: timingResult.timing.is_all_day,
      primary_member_id: member.id,
      primary_member_name: member.name,
      assistant_member_ids: [],
      assistant_member_names: [],
      status: '已排程',
      is_tentative: false,
      address,
      google_maps_url: null,
      google_calendar_id: options.calendarId,
      google_event_id: event.id,
      google_sync_status: 'synced',
      google_sync_error: null,
      last_synced_at: options.syncedAt,
      created_by: 'google-calendar-import',
      updated_by: 'google-calendar-import',
    },
  };
}

const addOneDay = (dateString: string): string => {
  const date = new Date(`${dateString}T00:00:00+08:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
};

const normalizeTime = (time: string | null | undefined, fallback: string): string => {
  const value = (time || '').trim();
  if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
  return fallback;
};

const mapRowToScheduleTask = (row: ScheduleTaskSyncRow): ScheduleTask => ({
  id: row.id,
  task_type: row.task_type || '',
  title: row.title || '',
  project_id: row.project_id || null,
  project_name: row.project_name || null,
  address: row.address || null,
  task_date: row.task_date || '',
  start_time: row.start_time || null,
  end_time: row.end_time || null,
  is_all_day: !!row.is_all_day,
  is_tentative: !!row.is_tentative,
  status: (row.status || '未開始') as ScheduleTask['status'],
  main_assignee_id: row.primary_member_id || null,
  description: null,
  source_todo_id: null,
  google_calendar_id: row.google_calendar_id || null,
  google_event_id: row.google_event_id || null,
  google_sync_status: row.google_sync_status as ScheduleTask['google_sync_status'],
  google_sync_error: row.google_sync_error || null,
  last_synced_at: row.last_synced_at || null,
  created_by: row.created_by || 'system',
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

export async function loadScheduleTaskSyncRow(
  supabase: SupabaseClientLike,
  taskId: string,
): Promise<ScheduleTaskSyncRow | null> {
  const { data, error } = await supabase
    .from('schedule_tasks')
    .select(`
      id,
      task_type,
      title,
      project_id,
      project_name,
      address,
      task_date,
      start_time,
      end_time,
      is_all_day,
      is_tentative,
      status,
      primary_member_id,
      primary_member_name,
      assistant_member_ids,
      assistant_member_names,
      google_calendar_id,
      google_event_id,
      google_sync_status,
      google_sync_error,
      last_synced_at,
      created_by,
      created_at,
      updated_at
    `)
    .eq('id', taskId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

const loadNameById = async (
  supabase: SupabaseClientLike,
  table: 'team_members' | 'projects',
  idColumn: string,
  nameColumn: string,
  id: string | null | undefined,
): Promise<string | null> => {
  if (!id) return null;

  const { data, error } = await supabase
    .from(table)
    .select(nameColumn)
    .eq(idColumn, id)
    .maybeSingle();

  if (error) throw error;
  return data?.[nameColumn] || null;
};

const loadUserNameMap = async (
  supabase: SupabaseClientLike,
  userIds: string[],
): Promise<Map<string, string>> => {
  if (userIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('team_members')
    .select('id, name')
    .in('id', Array.from(new Set(userIds)));

  if (error) throw error;
  return new Map((data || []).map((user: { id: string; name: string }) => [user.id, user.name]));
};

export async function buildGoogleEventBody(
  supabase: SupabaseClientLike,
  task: ScheduleTask,
): Promise<calendar_v3.Schema$Event> {
  const row = await loadScheduleTaskSyncRow(supabase, task.id);
  const syncRow = row || ({
    id: task.id,
    task_type: task.task_type,
    title: task.title,
    project_id: task.project_id,
    project_name: task.project_name,
    address: task.address,
    task_date: task.task_date,
    start_time: task.start_time,
    end_time: task.end_time,
    is_all_day: task.is_all_day,
    is_tentative: task.is_tentative,
    status: task.status,
    primary_member_id: task.main_assignee_id,
    primary_member_name: null,
    assistant_member_ids: [],
    assistant_member_names: [],
    google_calendar_id: task.google_calendar_id,
    google_event_id: task.google_event_id,
    google_sync_status: task.google_sync_status,
    google_sync_error: task.google_sync_error,
    last_synced_at: task.last_synced_at,
    created_by: task.created_by,
    created_at: task.created_at,
    updated_at: task.updated_at,
  } satisfies ScheduleTaskSyncRow);

  const assistantIds = toArray(syncRow.assistant_member_ids);
  const assistantNamesFromRow = toArray(syncRow.assistant_member_names)
    .map(name => sanitizeVisibleValue(name, ''))
    .filter(Boolean);
  const userNameMap = await loadUserNameMap(
    supabase,
    [syncRow.primary_member_id, ...assistantIds].filter(Boolean) as string[],
  );

  const projectNameFromMapping = await loadNameById(
    supabase,
    'projects',
    'id',
    'project_name',
    syncRow.project_id,
  );

  const projectName = sanitizeVisibleValue(
    projectNameFromMapping || syncRow.project_name,
    '無案場',
  );
  let taskTitle = syncRow.task_type || '未分類';
  if (syncRow.title && syncRow.title.trim() !== '') {
    taskTitle += ` - ${syncRow.title.trim()}`;
  }
  const mainAssigneeName = sanitizeVisibleValue(
    syncRow.primary_member_name || userNameMap.get(syncRow.primary_member_id || ''),
    '未指派',
  );
  const assistantNames = assistantNamesFromRow.length > 0
    ? assistantNamesFromRow
    : assistantIds
        .map(id => sanitizeVisibleValue(userNameMap.get(id), ''))
        .filter(Boolean);

  const description = [
    `任務類型：${sanitizeVisibleValue(syncRow.task_type, '未分類')}`,
    `狀態：${formatReadableStatus(syncRow.status)}`,
    `主要負責人：${mainAssigneeName}`,
    `協同人員：${assistantNames.length > 0 ? assistantNames.join('、') : '無'}`,
  ].join('\n');

  const isAllDay = !!syncRow.is_all_day;
  const start = isAllDay
    ? { date: syncRow.task_date || task.task_date }
    : {
        dateTime: `${syncRow.task_date || task.task_date}T${normalizeTime(syncRow.start_time, '09:00')}:00+08:00`,
        timeZone: GOOGLE_TIME_ZONE,
      };
  const end = isAllDay
    ? { date: addOneDay(syncRow.task_date || task.task_date) }
    : {
        dateTime: `${syncRow.task_date || task.task_date}T${normalizeTime(syncRow.end_time, '10:00')}:00+08:00`,
        timeZone: GOOGLE_TIME_ZONE,
      };

  let finalAddress = syncRow.address || task.address;
  if (!finalAddress && syncRow.project_id) {
    const { data: pData } = await supabase
      .from('projects')
      .select('address')
      .eq('id', syncRow.project_id)
      .maybeSingle();
    if (pData?.address) {
      finalAddress = pData.address;
    }
  }

  return {
    summary: `【${projectName}】${taskTitle}`,
    description,
    location: finalAddress || undefined,
    start,
    end,
    transparency: syncRow.is_tentative ? 'transparent' : 'opaque',
    extendedProperties: {
      private: {
        scheduleTaskId: syncRow.id,
        source: GOOGLE_SYNC_SOURCE,
      },
    },
  };
}

export function getScheduleTaskFromSyncRow(row: ScheduleTaskSyncRow): ScheduleTask {
  return mapRowToScheduleTask(row);
}

export function getGoogleEventTiming(event: calendar_v3.Schema$Event): GoogleEventTiming | null {
  if (event.start?.date) {
    return {
      task_date: event.start.date,
      start_time: null,
      end_time: null,
      is_all_day: true,
    };
  }

  if (!event.start?.dateTime || !event.end?.dateTime) return null;

  const start = formatTaipeiParts(new Date(event.start.dateTime));
  const end = formatTaipeiParts(new Date(event.end.dateTime));

  return {
    task_date: start.date,
    start_time: start.time,
    end_time: end.time,
    is_all_day: false,
  };
}

export function descriptionContainsUuid(description: string | null | undefined): boolean {
  UUID_PATTERN.lastIndex = 0;
  return UUID_PATTERN.test(description || '');
}
