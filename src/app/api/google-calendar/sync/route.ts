import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import { ScheduleTask } from '@/lib/db/types';
import { buildGoogleEventBody, loadScheduleTaskSyncRow } from '@/lib/google-calendar-sync';
import { requireActiveTeamMember } from '@/lib/server/supabase-auth';

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

const isGoogleEventGoneError = (error: any) => {
  const status = error?.status ?? error?.code ?? error?.response?.status;
  const message = `${error?.message || ''} ${error?.response?.data?.error?.message || ''}`.toLowerCase();
  return status === 404
    || status === 410
    || message.includes('not found')
    || message.includes('gone');
};

const deleteRemoteDeletedScheduleTask = async (
  supabase: SupabaseClient,
  taskId: string,
) => {
  const { error } = await supabase
    .from('schedule_tasks')
    .delete()
    .eq('id', taskId);

  if (error) throw error;
};

const respondRemoteDeleted = async (
  supabase: SupabaseClient,
  taskId: string,
  googleEventId: string,
  syncError: string,
) => {
  await deleteRemoteDeletedScheduleTask(supabase, taskId);
  return NextResponse.json({
    success: true,
    remote_deleted: true,
    taskId,
    googleEventId,
    syncStatus: 'failed',
    syncError,
  });
};

export async function POST(req: Request) {
  try {
    const { context, error: authResponse } = await requireActiveTeamMember(req);
    if (authResponse) return authResponse;

    const { action, task } = await req.json() as { action: 'CREATE' | 'UPDATE' | 'DELETE', task: ScheduleTask };

    if (!task) {
      return NextResponse.json({ error: 'Task is required' }, { status: 400 });
    }

    const supabase = context.supabase;
    const calendar = getGoogleCalendarClient();

    const persistedTask = await loadScheduleTaskSyncRow(supabase, task.id);
    if (!persistedTask) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });
    }

    const dbGoogleEventId = persistedTask.google_event_id;
    const eventBody = await buildGoogleEventBody(supabase, {
      ...task,
      google_event_id: dbGoogleEventId,
      google_calendar_id: persistedTask.google_calendar_id || task.google_calendar_id,
    });

    // 1. DELETE
    if (action === 'DELETE') {
      if (dbGoogleEventId) {
        try {
          await calendar.events.delete({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: dbGoogleEventId,
          });
        } catch (err: any) {
          if (isGoogleEventGoneError(err)) {
            return respondRemoteDeleted(
              supabase,
              task.id,
              dbGoogleEventId,
              'Google event was already deleted remotely',
            );
          }

          if (err.status !== 404 && err.status !== 410) {
            console.error('Failed to delete Google event:', getSafeErrorInfo(err));
            // We still return success so the front-end doesn't break, it's already soft-deleted in DB.
          }
        }
      }
      return NextResponse.json({ success: true });
    }

    let newEventId = dbGoogleEventId;
    let syncStatus: 'synced' | 'failed' = 'synced';
    let syncError: string | null = null;
    const canCreateGoogleEvent = action === 'CREATE'
      && !dbGoogleEventId
      && !persistedTask.google_calendar_id
      && !persistedTask.google_sync_status;

    try {
      if (canCreateGoogleEvent) {
        // Insert
        const res = await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          requestBody: eventBody,
        });
        newEventId = res.data.id || null;
      } else if (dbGoogleEventId) {
        const { data: existingEvent } = await calendar.events.get({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: dbGoogleEventId,
        });

        if (existingEvent.status === 'cancelled') {
          return respondRemoteDeleted(
            supabase,
            task.id,
            dbGoogleEventId,
            'Google event was deleted remotely',
          );
        }

        await calendar.events.update({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: dbGoogleEventId,
          requestBody: eventBody,
        });
        newEventId = dbGoogleEventId;
      } else {
        return NextResponse.json({
          success: false,
          skipped: true,
          reason: 'missing_google_event_id_for_update',
          taskId: task.id,
        }, { status: 409 });
      }
    } catch (apiError: any) {
      if (dbGoogleEventId && isGoogleEventGoneError(apiError)) {
        return respondRemoteDeleted(
          supabase,
          task.id,
          dbGoogleEventId,
          'Google event was deleted remotely',
        );
      }

      console.error('Google API Error:', getSafeErrorInfo(apiError));
      syncStatus = 'failed';
      syncError = apiError.message || 'Unknown Google API Error';
    }

    // Update DB with sync status
    const updatePayload = {
      google_event_id: newEventId,
      google_calendar_id: GOOGLE_CALENDAR_ID,
      google_sync_status: syncStatus,
      google_sync_error: syncError,
      last_synced_at: new Date().toISOString()
    };

    const { error: dbError } = await supabase
      .from('schedule_tasks')
      .update(updatePayload)
      .eq('id', task.id);

    if (dbError) {
      console.error('Failed to update task with sync status:', dbError);
    }

    return NextResponse.json({ success: true, syncStatus, newEventId });

  } catch (err: any) {
    console.error('Sync route error:', getSafeErrorInfo(err));
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
