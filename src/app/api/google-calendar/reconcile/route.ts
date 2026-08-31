import { NextResponse } from 'next/server';
import type { calendar_v3 } from 'googleapis';
import { getGoogleCalendarClient, GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import {
  GOOGLE_SYNC_SOURCE,
  findSuggestedProjects,
  getGoogleEventTiming,
  isSystemManagedGoogleEvent,
  mapManualGoogleEvent,
  type GoogleImportMember,
  type GoogleImportProject,
  type ManualGoogleEventSkipReason,
} from '@/lib/google-calendar-sync';
import { requireActiveTeamMember } from '@/lib/server/supabase-auth';

export const dynamic = 'force-dynamic';

const runningReconciles = new Set<string>();
const GOOGLE_LIST_TIME_ZONE = 'Asia/Taipei';
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

type UnmatchedDecision = {
  eventId: string;
  action: 'import_with_project' | 'import_without_project' | 'skip';
  projectId?: string;
};

type ReconcileBody = { taskId?: string; decisions?: UnmatchedDecision[] };
type SyncFailure = { taskId?: string; eventId: string; title: string; message: string };

const REASON_MESSAGES: Record<ManualGoogleEventSkipReason, string> = {
  missing_event_id: 'Google 活動缺少 Event ID',
  missing_summary: 'Google 活動缺少名稱',
  missing_creator_email: 'Google 活動缺少建立者 Email',
  creator_not_active_team_member: '活動建立者不是唯一的有效團隊成員',
  no_project_match: '找不到完全匹配的案場',
  ambiguous_project_match: '有多個完全匹配的案場',
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

const toUnmatchedEvent = (
  event: calendar_v3.Schema$Event,
  reason: 'no_project_match' | 'ambiguous_project_match',
  projects: GoogleImportProject[],
) => {
  const timing = getGoogleEventTiming(event);
  return {
    eventId: event.id || '',
    title: (event.summary || '').trim(),
    date: timing?.task_date || '',
    startTime: timing?.start_time || null,
    endTime: timing?.end_time || null,
    isAllDay: timing?.is_all_day || false,
    location: (event.location || '').trim() || null,
    notes: (event.description || '').trim() || null,
    reason,
    suggestions: findSuggestedProjects(event, projects),
  };
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
    const body = await req.json().catch(() => ({})) as ReconcileBody;
    const decisions = Array.isArray(body.decisions) ? body.decisions.slice(0, 200) : null;
    lockKey = decisions
      ? `confirm:${GOOGLE_CALENDAR_ID}`
      : body.taskId ? `task:${body.taskId}` : `calendar:${GOOGLE_CALENDAR_ID}`;

    if (runningReconciles.has(lockKey)) {
      return NextResponse.json({
        success: true, skipped: true, reason: 'already_running', checked: 0,
        updated: 0, deleted: 0, imported: 0, matchedImportedOrUpdated: 0,
        unmatchedImported: 0, skippedThisRun: 0, failed: 0,
        unmatchedEvents: [], failures: [],
      });
    }
    runningReconciles.add(lockKey);

    const calendar = getGoogleCalendarClient();
    const now = new Date();
    const syncedAt = now.toISOString();
    const failures: SyncFailure[] = [];
    let matchedImportedOrUpdated = 0;
    let unmatchedImported = 0;
    let skippedThisRun = 0;

    if (decisions) {
      const { members, projects } = await loadImportReferences(supabase);
      for (const decision of decisions) {
        if (!decision.eventId || !['import_with_project', 'import_without_project', 'skip'].includes(decision.action)) {
          failures.push({
            eventId: decision.eventId || '',
            title: decision.eventId || '未知活動',
            message: '無效的未匹配活動處理方式',
          });
          continue;
        }
        if (decision.action === 'skip') {
          skippedThisRun += 1;
          continue;
        }

        let eventTitle = decision.eventId;
        try {
          const { data: existing } = await supabase.from('schedule_tasks').select('id')
            .eq('google_calendar_id', GOOGLE_CALENDAR_ID)
            .eq('google_event_id', decision.eventId).maybeSingle();
          if (existing) {
            matchedImportedOrUpdated += 1;
            continue;
          }

          const { data: event } = await calendar.events.get({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: decision.eventId,
          });
          eventTitle = (event.summary || '').trim() || decision.eventId;
          if (event.status === 'cancelled' || isSystemManagedGoogleEvent(event)) {
            throw new Error('活動已取消或已由系統管理，無法重複匯入');
          }

          let projectOverride: GoogleImportProject | null = null;
          if (decision.action === 'import_with_project') {
            projectOverride = projects.find(project => project.id === decision.projectId) || null;
            if (!projectOverride) throw new Error('選擇的案場不存在或已停用');
          }

          const mapping = mapManualGoogleEvent(event, {
            calendarId: GOOGLE_CALENDAR_ID,
            activeMembers: members,
            projects,
            syncedAt,
            projectOverride,
          });
          if (!mapping.ok) throw new Error(REASON_MESSAGES[mapping.reason]);

          const { error: insertError } = await supabase.from('schedule_tasks').insert(mapping.task);
          if (insertError) {
            if (insertError.code === '23505') {
              matchedImportedOrUpdated += 1;
              continue;
            }
            throw insertError;
          }
          if (projectOverride) matchedImportedOrUpdated += 1;
          else unmatchedImported += 1;
        } catch (error: any) {
          failures.push({
            eventId: decision.eventId,
            title: eventTitle,
            message: error?.message || '未知匯入錯誤',
          });
          console.error('Google unmatched event confirmation failed:', getSafeErrorInfo(error));
        }
      }

      return NextResponse.json({
        success: true, checked: decisions.length, updated: 0, deleted: 0,
        imported: matchedImportedOrUpdated + unmatchedImported,
        matchedImportedOrUpdated, unmatchedImported, skippedThisRun,
        failed: failures.length, unmatchedEvents: [], failures,
      });
    }

    let query = supabase.from('schedule_tasks')
      .select('id, title, notes, address, created_by, google_event_id, google_calendar_id, task_date, start_time, end_time, is_all_day')
      .eq('google_calendar_id', GOOGLE_CALENDAR_ID).not('google_event_id', 'is', null);
    if (body.taskId) query = query.eq('id', body.taskId);
    const { data: tasks, error } = await query;
    if (error) throw error;

    let checked = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;
    let imported = 0;
    let skipped_system_created = 0;

    for (const task of tasks || []) {
      checked += 1;
      const eventId = task.google_event_id;
      if (!eventId) { skipped += 1; continue; }

      let eventTitle = eventId;
      try {
        const { data: event } = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId });
        eventTitle = (event.summary || '').trim() || eventId;
        if (event.status === 'cancelled') {
          const { error: deleteError } = await supabase.from('schedule_tasks').delete().eq('id', task.id);
          if (deleteError) throw deleteError;
          deleted += 1;
          continue;
        }

        const privateProps = event.extendedProperties?.private || {};
        if (privateProps.source && privateProps.source !== GOOGLE_SYNC_SOURCE) {
          skipped += 1;
          continue;
        }
        if (privateProps.scheduleTaskId && privateProps.scheduleTaskId !== task.id) {
          throw new Error('Google event scheduleTaskId does not match schedule_tasks.id');
        }

        const timing = getGoogleEventTiming(event);
        if (!timing) throw new Error('Google 活動時間無效');
        const dbUpdates: Record<string, unknown> = {
          google_sync_status: 'synced', google_sync_error: null,
          last_synced_at: syncedAt, updated_at: syncedAt,
        };
        let taskChanged = false;
        if (hasTimingChanged(task, timing)) {
          dbUpdates.task_date = timing.task_date;
          dbUpdates.start_time = timing.start_time;
          dbUpdates.end_time = timing.end_time;
          dbUpdates.is_all_day = timing.is_all_day;
          taskChanged = true;
        }
        if (task.created_by === 'google-calendar-import' && !isSystemManagedGoogleEvent(event)) {
          const title = (event.summary || '').trim();
          const notes = (event.description || '').trim() || null;
          const address = (event.location || '').trim() || null;
          if (title && title !== task.title) { dbUpdates.title = title; taskChanged = true; }
          if (notes !== (task.notes || null)) { dbUpdates.notes = notes; taskChanged = true; }
          if (address !== (task.address || null)) { dbUpdates.address = address; taskChanged = true; }
        }
        if (taskChanged) {
          updated += 1;
          matchedImportedOrUpdated += 1;
        }
        const { error: updateError } = await supabase.from('schedule_tasks').update(dbUpdates).eq('id', task.id);
        if (updateError) throw updateError;
      } catch (eventError: any) {
        if (eventError?.status === 404 || eventError?.status === 410) {
          const { error: deleteError } = await supabase.from('schedule_tasks').delete().eq('id', task.id);
          if (deleteError) throw deleteError;
          deleted += 1;
          continue;
        }
        failures.push({ taskId: task.id, eventId, title: eventTitle,
          message: eventError?.message || '未知同步錯誤' });
        console.error('Google reconcile event failed:', getSafeErrorInfo(eventError));
      }
    }

    const unmatchedEvents: ReturnType<typeof toUnmatchedEvent>[] = [];
    if (!body.taskId) {
      const listedEvents = await listGoogleEventsInImportWindow(calendar, now);
      const existingEventIds = new Set(
        (tasks || []).map(task => task.google_event_id).filter((eventId): eventId is string => !!eventId),
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
            if (mapping.reason === 'no_project_match' || mapping.reason === 'ambiguous_project_match') {
              unmatchedEvents.push(toUnmatchedEvent(event, mapping.reason, projects));
            } else {
              failures.push({ eventId, title: (event.summary || '').trim() || eventId,
                message: REASON_MESSAGES[mapping.reason] });
            }
            continue;
          }

          const { error: insertError } = await supabase.from('schedule_tasks').insert(mapping.task);
          if (insertError) {
            if (insertError.code === '23505') {
              existingEventIds.add(mapping.task.google_event_id);
              continue;
            }
            throw insertError;
          }
          existingEventIds.add(mapping.task.google_event_id);
          imported += 1;
          matchedImportedOrUpdated += 1;
        } catch (importError: any) {
          failures.push({ eventId, title: (event.summary || '').trim() || eventId,
            message: importError?.message || '未知匯入錯誤' });
          console.error('Google manual event import failed:', getSafeErrorInfo(importError));
        }
      }
    }

    return NextResponse.json({
      success: true, checked, updated, deleted, skipped, imported,
      skipped_system_created, matchedImportedOrUpdated, unmatchedImported,
      skippedThisRun, failed: failures.length, unmatchedEvents, failures,
    });
  } catch (err: any) {
    console.error('Google reconcile failed:', getSafeErrorInfo(err));
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  } finally {
    if (lockKey) runningReconciles.delete(lockKey);
  }
}
