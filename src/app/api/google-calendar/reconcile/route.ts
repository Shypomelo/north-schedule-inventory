import { NextResponse } from 'next/server';
import type { calendar_v3 } from 'googleapis';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import {
  GOOGLE_SYNC_SOURCE,
  getGoogleEventTiming,
  isSystemManagedGoogleEvent,
  mapManualGoogleEvent,
  type GoogleImportMember,
  type GoogleImportProject,
  type ManualGoogleEventSkipReason,
} from '@/lib/google-calendar-sync';
import type { ScheduleTask } from '@/lib/db/types';
import { requireActiveTeamMember } from '@/lib/server/supabase-auth';

export const dynamic = 'force-dynamic';

const runningReconciles = new Set<string>();
const GOOGLE_LIST_TIME_ZONE = 'Asia/Taipei';
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

type ImportSkipReason = ManualGoogleEventSkipReason | 'already_imported' | 'insert_failed';
type SkippedEvent = { eventId: string; reason: ImportSkipReason };

const getSafeErrorInfo = (error: any) => ({
  status: error?.status ?? error?.code ?? null,
  message: error?.message || 'Unknown Google API Error',
  responseError: error?.response?.data?.error,
  responseMessage: error?.response?.data?.message,
  responseErrors: error?.response?.data?.error?.errors?.map((item: any) => ({
    domain: item?.domain,
    reason: item?.reason,
    message: item?.message,
  })),
  errors: error?.errors?.map((item: any) => ({
    reason: item?.reason,
    message: item?.message,
  })),
});

const hasTimingChanged = (task: any, timing: ReturnType<typeof getGoogleEventTiming>) => {
  if (!timing) return false;
  return task.task_date !== timing.task_date
    || (task.start_time || null) !== timing.start_time
    || (task.end_time || null) !== timing.end_time
    || !!task.is_all_day !== timing.is_all_day;
};

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

export async function POST(req: Request) {
  let lockKey = '';
  try {
    const { context, error: authResponse } = await requireActiveTeamMember(req);
    if (authResponse) return authResponse;

    if (context.member.role?.toUpperCase() === 'VIEWER') {
      return NextResponse.json({ success: false, error: 'Forbidden for VIEWER role' }, { status: 403 });
    }

    if (!GOOGLE_CALENDAR_ID) {
      return NextResponse.json({ success: false, error: 'Missing GOOGLE_CALENDAR_ID' }, { status: 500 });
    }

    const supabase = context.supabase;
    const body = await req.json().catch(() => ({})) as { taskId?: string };
    lockKey = body.taskId ? `task:${body.taskId}` : `calendar:${GOOGLE_CALENDAR_ID}`;
    if (runningReconciles.has(lockKey)) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'already_running',
        checked: 0,
        updated: 0,
        deleted: 0,
        imported: 0,
        skippedEvents: [],
        failures: [],
      });
    }

    runningReconciles.add(lockKey);

    const calendar = getGoogleCalendarClient();
    let query = supabase
      .from('schedule_tasks')
      .select('id, google_event_id, google_calendar_id, task_date, start_time, end_time, is_all_day')
      .eq('google_calendar_id', GOOGLE_CALENDAR_ID)
      .not('google_event_id', 'is', null);

    if (body.taskId) {
      query = query.eq('id', body.taskId);
    }

    const { data: tasks, error } = await query;

    if (error) throw error;

    let checked = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;
    let imported = 0;
    let skipped_system_created = 0;
    const skippedEvents: SkippedEvent[] = [];
    const failures: Array<{ taskId: string; eventId: string; message: string }> = [];

    for (const task of tasks || []) {
      checked += 1;
      const eventId = task.google_event_id;
      if (!eventId) {
        skipped += 1;
        continue;
      }

      try {
        const { data: event } = await calendar.events.get({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId,
        });

        if (event.status === 'cancelled') {
          const { error: deleteError } = await supabase
            .from('schedule_tasks')
            .delete()
            .eq('id', task.id);
          if (deleteError) throw deleteError;

          deleted += 1;
          continue;
        }

        const privateProps = event.extendedProperties?.private || {};
        if (
          privateProps.source
          && privateProps.source !== GOOGLE_SYNC_SOURCE
        ) {
          skipped += 1;
          continue;
        }
        if (
          privateProps.scheduleTaskId
          && privateProps.scheduleTaskId !== task.id
        ) {
          skipped += 1;
          failures.push({
            taskId: task.id,
            eventId,
            message: 'Google event scheduleTaskId does not match schedule_tasks.id',
          });
          continue;
        }

        const timing = getGoogleEventTiming(event);
        if (!timing) {
          skipped += 1;
          continue;
        }

        const updates: Partial<ScheduleTask> = {
          google_sync_status: 'synced',
          google_sync_error: null,
          last_synced_at: new Date().toISOString(),
        };

        if (hasTimingChanged(task, timing)) {
          updates.task_date = timing.task_date;
          updates.start_time = timing.start_time;
          updates.end_time = timing.end_time;
          updates.is_all_day = timing.is_all_day;
          updated += 1;
        }

        const dbUpdates: Record<string, unknown> = {
          google_sync_status: updates.google_sync_status,
          google_sync_error: updates.google_sync_error,
          last_synced_at: updates.last_synced_at,
          updated_at: new Date().toISOString(),
        };

        if (updates.task_date !== undefined) dbUpdates.task_date = updates.task_date;
        if (updates.start_time !== undefined) dbUpdates.start_time = updates.start_time;
        if (updates.end_time !== undefined) dbUpdates.end_time = updates.end_time;
        if (updates.is_all_day !== undefined) dbUpdates.is_all_day = updates.is_all_day;

        const { error: updateError } = await supabase
          .from('schedule_tasks')
          .update(dbUpdates)
          .eq('id', task.id);
        if (updateError) throw updateError;
      } catch (eventError: any) {
        if (eventError?.status === 404 || eventError?.status === 410) {
          const { error: deleteError } = await supabase
            .from('schedule_tasks')
            .delete()
            .eq('id', task.id);
          if (deleteError) throw deleteError;

          deleted += 1;
          continue;
        }

        failures.push({
          taskId: task.id,
          eventId,
          message: eventError?.message || 'Unknown Google API Error',
        });
        console.error('Google reconcile event failed:', getSafeErrorInfo(eventError));
      }
    }

    if (!body.taskId) {
      const now = new Date();
      const listedEvents = await listGoogleEventsInImportWindow(calendar, now);
      const existingEventIds = new Set(
        (tasks || [])
          .map(task => task.google_event_id)
          .filter((eventId): eventId is string => !!eventId),
      );

      const [{ data: members, error: membersError }, { data: projects, error: projectsError }] = await Promise.all([
        supabase
          .from('team_members')
          .select('id, email, name, google_calendar_email')
          .eq('is_active', true)
          .is('deleted_at', null),
        supabase
          .from('projects')
          .select('id, project_name, project_short_name, project_code, address')
          .is('deleted_at', null),
      ]);

      if (membersError) throw membersError;
      if (projectsError) throw projectsError;

      for (const event of listedEvents) {
        if (isSystemManagedGoogleEvent(event)) {
          skipped_system_created += 1;
          continue;
        }

        const eventId = event.id || '';
        if (eventId && existingEventIds.has(eventId)) {
          skippedEvents.push({ eventId, reason: 'already_imported' });
          continue;
        }

        const mapping = mapManualGoogleEvent(event, {
          calendarId: GOOGLE_CALENDAR_ID,
          activeMembers: (members || []) as GoogleImportMember[],
          projects: (projects || []) as GoogleImportProject[],
          syncedAt: now.toISOString(),
        });

        if (!mapping.ok) {
          skippedEvents.push({ eventId, reason: mapping.reason });
          continue;
        }

        const { error: insertError } = await supabase
          .from('schedule_tasks')
          .insert(mapping.task);

        if (insertError) {
          if (insertError.code === '23505') {
            skippedEvents.push({ eventId: mapping.task.google_event_id, reason: 'already_imported' });
          } else {
            skippedEvents.push({ eventId: mapping.task.google_event_id, reason: 'insert_failed' });
            console.error('Google manual event import failed:', getSafeErrorInfo(insertError));
          }
          continue;
        }

        existingEventIds.add(mapping.task.google_event_id);
        imported += 1;
      }
    }

    return NextResponse.json({
      success: failures.length === 0,
      checked,
      updated,
      deleted,
      skipped,
      imported,
      skipped_system_created,
      skippedEvents,
      failures,
    });
  } catch (err: any) {
    console.error('Google reconcile failed:', getSafeErrorInfo(err));
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  } finally {
    if (lockKey) {
      runningReconciles.delete(lockKey);
    }
  }
}
