import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { calendar_v3 } from 'googleapis';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import {
  ensureGoogleEventForScheduleTask,
  isSystemManagedGoogleEvent,
  mapManualGoogleEvent,
  type GoogleImportMember,
  type GoogleImportProject,
  type ManualGoogleEventSkipReason,
  type ScheduleTaskSyncRow,
} from '@/lib/google-calendar-sync';

const runningReconciles = new Set<string>();
const GOOGLE_LIST_TIME_ZONE = 'Asia/Taipei';
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const SCHEDULE_TASK_SYNC_COLUMNS = `
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
`;

export type GoogleCalendarReconcileBody = { taskId?: string };
type SyncFailure = { taskId?: string; eventId: string; title: string; message: string };

const REASON_MESSAGES: Record<ManualGoogleEventSkipReason, string> = {
  missing_event_id: 'Google 活動缺少 Event ID',
  missing_summary: 'Google 活動缺少名稱',
  unsupported_multi_day_event: '目前不支援跨日活動',
  invalid_time: '活動時間無效',
};

const getSafeErrorInfo = (error: any) => ({
  status: error?.status ?? error?.code ?? null,
  message: error?.message || 'Unknown Google API Error',
  responseError: error?.response?.data?.error,
  responseMessage: error?.response?.data?.message,
  responseErrors: error?.response?.data?.error?.errors,
  errors: error?.errors,
});

const listGoogleEventsInImportWindow = async (
  calendar: calendar_v3.Calendar,
  now: Date,
): Promise<calendar_v3.Schema$Event[]> => {
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: new Date(now.getTime() - 90 * DAY_IN_MILLISECONDS).toISOString(),
      timeMax: new Date(now.getTime() + 365 * DAY_IN_MILLISECONDS).toISOString(),
      timeZone: GOOGLE_LIST_TIME_ZONE,
      singleEvents: true,
      showDeleted: false,
      pageToken,
    });
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return events;
};

const loadImportReferences = async (supabase: any) => {
  const [{ data: members, error: membersError }, { data: projects, error: projectsError }] = await Promise.all([
    supabase.from('team_members').select('id, email, name, google_calendar_email')
      .eq('is_active', true).is('deleted_at', null),
    supabase.from('projects').select('id, project_name, project_short_name, project_code, address')
      .is('deleted_at', null),
  ]);
  if (membersError) throw membersError;
  if (projectsError) throw projectsError;
  return {
    members: (members || []) as GoogleImportMember[],
    projects: (projects || []) as GoogleImportProject[],
  };
};

export async function reconcileGoogleCalendarCore(
  supabase: SupabaseClient,
  body: GoogleCalendarReconcileBody = {},
) {
  let lockKey = '';
  try {
    if (!GOOGLE_CALENDAR_ID) {
      return NextResponse.json({ success: false, error: 'Missing GOOGLE_CALENDAR_ID' }, { status: 500 });
    }

    lockKey = body.taskId ? `task:${body.taskId}` : `calendar:${GOOGLE_CALENDAR_ID}`;

    if (runningReconciles.has(lockKey)) {
      return NextResponse.json({
        success: true, skipped: true, reason: 'already_running', checked: 0,
        updated: 0, deleted: 0, imported: 0,
        unmatchedProjectImported: 0, unassignedMemberImported: 0,
        failed: 0, failures: [],
      });
    }
    runningReconciles.add(lockKey);

    const calendar = getGoogleCalendarClient();
    const now = new Date();
    const syncedAt = now.toISOString();
    const failures: SyncFailure[] = [];
    let query = supabase.from('schedule_tasks').select(SCHEDULE_TASK_SYNC_COLUMNS);
    if (body.taskId) query = query.eq('id', body.taskId);
    const { data: queriedTasks, error } = await query;
    if (error) throw error;
    const tasks = ((queriedTasks || []) as ScheduleTaskSyncRow[]).filter(task => (
      !task.google_event_id
      || !task.google_calendar_id
      || task.google_calendar_id === GOOGLE_CALENDAR_ID
    ));

    let checked = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;
    let imported = 0;
    let skipped_system_created = 0;
    let unmatchedProjectImported = 0;
    let unassignedMemberImported = 0;

    for (const task of tasks) {
      checked += 1;
      const eventId = task.google_event_id;
      let eventTitle = task.title || eventId || task.id;
      try {
        const syncResult = await ensureGoogleEventForScheduleTask(
          supabase,
          calendar,
          task,
          GOOGLE_CALENDAR_ID,
          syncedAt,
        );
        if (syncResult.action !== 'unchanged') {
          updated += 1;
        } else {
          skipped += 1;
        }
      } catch (eventError: any) {
        failures.push({ taskId: task.id, eventId: eventId || '', title: eventTitle,
          message: eventError?.message || '未知同步錯誤' });
        console.error('Google reconcile event failed:', getSafeErrorInfo(eventError));
      }
    }

    if (!body.taskId) {
      const listedEvents = await listGoogleEventsInImportWindow(calendar, now);
      const existingEventIds = new Set(
        tasks.map(task => task.google_event_id).filter((eventId): eventId is string => !!eventId),
      );
      const { members, projects } = await loadImportReferences(supabase);

      for (const event of listedEvents) {
        if (isSystemManagedGoogleEvent(event)) {
          skipped_system_created += 1;
          continue;
        }
        const eventId = event.id || '';
        if (eventId && existingEventIds.has(eventId)) continue;

        try {
          const mapping = mapManualGoogleEvent(event, {
            calendarId: GOOGLE_CALENDAR_ID,
            activeMembers: members,
            projects,
            syncedAt,
          });
          if (!mapping.ok) {
            failures.push({ eventId, title: (event.summary || '').trim() || eventId,
              message: REASON_MESSAGES[mapping.reason] });
            continue;
          }

          const { data: insertedTask, error: insertError } = await supabase
            .from('schedule_tasks')
            .insert(mapping.task)
            .select(SCHEDULE_TASK_SYNC_COLUMNS)
            .single();
          if (insertError) {
            if (insertError.code === '23505') {
              existingEventIds.add(mapping.task.google_event_id);
              continue;
            }
            throw insertError;
          }
          existingEventIds.add(mapping.task.google_event_id);
          imported += 1;
          if (!mapping.task.project_id) unmatchedProjectImported += 1;
          if (!mapping.task.primary_member_id) unassignedMemberImported += 1;

          await ensureGoogleEventForScheduleTask(
            supabase,
            calendar,
            insertedTask as ScheduleTaskSyncRow,
            GOOGLE_CALENDAR_ID,
            syncedAt,
          );
        } catch (importError: any) {
          failures.push({ eventId, title: (event.summary || '').trim() || eventId,
            message: importError?.message || '未知匯入錯誤' });
          console.error('Google manual event import failed:', getSafeErrorInfo(importError));
        }
      }
    }

    return NextResponse.json({
      success: true, checked, updated, deleted, skipped, imported,
      skipped_system_created, unmatchedProjectImported, unassignedMemberImported,
      failed: failures.length, failures,
    });
  } catch (err: any) {
    console.error('Google reconcile failed:', getSafeErrorInfo(err));
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  } finally {
    if (lockKey) runningReconciles.delete(lockKey);
  }
}
