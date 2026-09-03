import { NextResponse } from 'next/server';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import { ScheduleTask } from '@/lib/db/types';
import {
  deleteGoogleEventForScheduleTask,
  ensureGoogleEventForScheduleTask,
  loadScheduleTaskSyncRow,
} from '@/lib/google-calendar-sync';
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

export async function POST(req: Request) {
  try {
    const { context, error: authResponse } = await requireActiveTeamMember(req);
    if (authResponse) return authResponse;

    if (context.member.role?.toUpperCase() === 'VIEWER') {
      return NextResponse.json({ success: false, error: 'Forbidden for VIEWER role' }, { status: 403 });
    }

    const { action, task } = await req.json() as { action: 'CREATE' | 'UPDATE' | 'DELETE', task: ScheduleTask };

    if (!task) {
      return NextResponse.json({ error: 'Task is required' }, { status: 400 });
    }
    if (!GOOGLE_CALENDAR_ID) {
      return NextResponse.json({ success: false, error: 'Missing GOOGLE_CALENDAR_ID' }, { status: 500 });
    }

    const supabase = context.supabase;
    const calendar = getGoogleCalendarClient();

    const persistedTask = await loadScheduleTaskSyncRow(supabase, task.id);
    if (!persistedTask) {
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });
    }

    if (action === 'DELETE') {
      try {
        const deleteResult = await deleteGoogleEventForScheduleTask(
          calendar,
          GOOGLE_CALENDAR_ID,
          persistedTask.google_event_id,
        );
        return NextResponse.json({ success: true, deleteResult });
      } catch (deleteError: any) {
        console.error('Failed to delete Google event:', getSafeErrorInfo(deleteError));
        return NextResponse.json({
          success: false,
          error: 'Google Calendar event could not be deleted; the schedule task was preserved',
          reason: 'google_delete_failed',
        }, { status: 502 });
      }
    }

    try {
      const result = await ensureGoogleEventForScheduleTask(
        supabase,
        calendar,
        persistedTask,
        GOOGLE_CALENDAR_ID,
      );
      return NextResponse.json({
        success: true,
        syncStatus: 'synced',
        newEventId: result.eventId,
        syncAction: result.action,
      });
    } catch (apiError: any) {
      console.error('Google API Error:', getSafeErrorInfo(apiError));
      const syncError = apiError.message || 'Unknown Google API Error';
      const { error: dbError } = await supabase
        .from('schedule_tasks')
        .update({
          google_sync_status: 'failed',
          google_sync_error: syncError,
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', task.id);

      if (dbError) console.error('Failed to update task with sync status:', dbError);
      return NextResponse.json({ success: true, syncStatus: 'failed', syncError });
    }

  } catch (err: any) {
    console.error('Sync route error:', getSafeErrorInfo(err));
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
