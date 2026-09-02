import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { reconcileGoogleCalendarCore } from '@/lib/server/google-calendar-reconcile';

export const dynamic = 'force-dynamic';

const safeSecretMatches = (provided: string | null, expected: string) => {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
};

export async function POST(req: Request) {
  const cronSecret = process.env.GOOGLE_CALENDAR_CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'Cron endpoint is not configured' }, { status: 503 });
  }
  if (!safeSecretMatches(req.headers.get('authorization'), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ success: false, error: 'Server-side database access is not configured' }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return reconcileGoogleCalendarCore(supabase);
}
