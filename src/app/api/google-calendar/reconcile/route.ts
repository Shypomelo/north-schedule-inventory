import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { dbAdapter } from '@/lib/db';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import { GOOGLE_SYNC_SOURCE, getGoogleEventTiming } from '@/lib/google-calendar-sync';
import { ScheduleTask } from '@/lib/db/types';

export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);
const runningReconciles = new Set<string>();

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

export async function POST(req: Request) {
  let lockKey = '';
  try {
    if (!GOOGLE_CALENDAR_ID) {
      return NextResponse.json({ success: false, error: 'Missing GOOGLE_CALENDAR_ID' }, { status: 500 });
    }

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
          await dbAdapter.deleteScheduleTask(task.id, true);
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

        await dbAdapter.updateScheduleTask(task.id, updates, undefined, true);
      } catch (eventError: any) {
        if (eventError?.status === 404 || eventError?.status === 410) {
          await dbAdapter.deleteScheduleTask(task.id, true);
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

    return NextResponse.json({
      success: failures.length === 0,
      checked,
      updated,
      deleted,
      skipped,
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
