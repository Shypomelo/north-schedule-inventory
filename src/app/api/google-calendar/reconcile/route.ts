import { NextResponse } from 'next/server';
import { GOOGLE_CALENDAR_ID } from '@/lib/google-calendar';
import {
  reconcileGoogleCalendarCore,
  type GoogleCalendarReconcileBody,
} from '@/lib/server/google-calendar-reconcile';
import { requireActiveTeamMember } from '@/lib/server/supabase-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { context, error: authResponse } = await requireActiveTeamMember(req);
  if (authResponse) return authResponse;
  if (context.member.role?.toUpperCase() === 'VIEWER') {
    return NextResponse.json({ success: false, error: 'Forbidden for VIEWER role' }, { status: 403 });
  }
  if (!GOOGLE_CALENDAR_ID) {
    return NextResponse.json({ success: false, error: 'Missing GOOGLE_CALENDAR_ID' }, { status: 500 });
  }

  const body = await req.json().catch(() => ({})) as GoogleCalendarReconcileBody;
  return reconcileGoogleCalendarCore(context.supabase, body);
}
