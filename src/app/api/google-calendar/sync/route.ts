import { NextResponse } from 'next/server';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import { ScheduleTask } from '@/lib/db/types';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; // Using anon key for now since POC uses anon everywhere. Or service_role if available.

const supabase = createClient(supabaseUrl, supabaseKey);

const getSafeErrorInfo = (error: any) => ({
  status: error?.status ?? error?.code ?? null,
  message: error?.message || 'Unknown Google API Error',
});

export async function POST(req: Request) {
  try {
    const { action, task } = await req.json() as { action: 'CREATE' | 'UPDATE' | 'DELETE', task: ScheduleTask };

    if (!task) {
      return NextResponse.json({ error: 'Task is required' }, { status: 400 });
    }

    const calendar = getGoogleCalendarClient();

    // 1. DELETE
    if (action === 'DELETE') {
      if (task.google_event_id) {
        try {
          await calendar.events.delete({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: task.google_event_id,
          });
        } catch (err: any) {
          // Ignore 404 or deleted events
          if (err.status !== 404 && err.status !== 410) {
            console.error('Failed to delete Google event:', getSafeErrorInfo(err));
            // We still return success so the front-end doesn't break, it's already soft-deleted in DB.
          }
        }
      }
      return NextResponse.json({ success: true });
    }

    // Prepare Google Event Format
    let title = `【${task.project_name || '無案場'}】${task.title}`;
    if (task.status === '完成' || task.status === '已完成') {
      title = `[已完成] ${title}`;
    }

    const descriptionParts = [
      `任務類型: ${task.task_type || '未分類'}`,
      `狀態: ${task.status}`,
      `主要負責人: ${task.main_assignee_id || '未指派'}`, // Ideally map this to name if available
      `內部任務ID: ${task.id}`
    ];

    const description = descriptionParts.join('\n');

    let startObj: any = {};
    let endObj: any = {};

    if (task.is_all_day) {
      // All day requires date only (YYYY-MM-DD), end date is exclusive
      startObj = { date: task.task_date };
      const nextDay = new Date(task.task_date);
      nextDay.setDate(nextDay.getDate() + 1);
      endObj = { date: nextDay.toISOString().split('T')[0] };
    } else {
      // Time based
      const startTime = task.start_time || '09:00';
      const endTime = task.end_time || '10:00';
      startObj = { dateTime: `${task.task_date}T${startTime}:00+08:00`, timeZone: 'Asia/Taipei' };
      endObj = { dateTime: `${task.task_date}T${endTime}:00+08:00`, timeZone: 'Asia/Taipei' };
    }

    const eventBody = {
      summary: title,
      description,
      start: startObj,
      end: endObj,
      // For tentatively we could set transparency to transparent
      transparency: task.is_tentative ? 'transparent' : 'opaque'
    };

    let newEventId = task.google_event_id;
    let syncStatus: 'synced' | 'failed' = 'synced';
    let syncError: string | null = null;

    try {
      if (action === 'CREATE' && !task.google_event_id) {
        // Insert
        const res = await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          requestBody: eventBody,
        });
        newEventId = res.data.id || null;
      } else if ((action === 'UPDATE' || action === 'CREATE') && task.google_event_id) {
        // Update (if action=CREATE but it has an ID, maybe it's a retry)
        await calendar.events.update({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: task.google_event_id,
          requestBody: eventBody,
        });
        newEventId = task.google_event_id;
      }
    } catch (apiError: any) {
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
