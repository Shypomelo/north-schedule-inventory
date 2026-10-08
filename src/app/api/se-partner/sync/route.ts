import { timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { liveSyncGate, runSePartnerSync, SESyncError, type SESyncMode, type SESyncStore,
  type SESyncReservation } from '@/lib/se-partner-sync';

export const dynamic = 'force-dynamic';
const endpoint = 'https://us-central1-party-worklist-system.cloudfunctions.net/partnerOrders';

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function store(client: SupabaseClient): SESyncStore {
  return {
    async reserve(mode, runId, pageNo) {
      const { data, error } = await client.rpc('se_sync_reserve',
        { p_mode: mode, p_run_id: runId, p_page_no: pageNo });
      if (error || !Array.isArray(data) || data.length !== 1) throw new SESyncError(error?.message || 'SE_RESERVE_FAILED');
      return data[0] as SESyncReservation;
    },
    async apply(runId, payload, pageCount) {
      const { error } = await client.rpc('se_sync_apply',
        { p_run_id: runId, p_payload: payload, p_page_count: pageCount });
      if (error) throw new SESyncError(error.message);
    },
    async fail(runId, code, retryAfterAt) {
      const { error } = code === 'HTTP_429' && retryAfterAt
        ? await client.rpc('se_sync_fail_429', { p_run_id: runId, p_retry_after_at: retryAfterAt })
        : await client.rpc('se_sync_fail', { p_run_id: runId, p_error_code: code });
      if (error) throw new SESyncError(error.message);
    },
  };
}

async function synchronize(request: NextRequest, mode: SESyncMode) {
  // The gate runs before quota reservation or any external request. Preview and localhost stay disabled.
  if (!liveSyncGate(process.env)) return NextResponse.json({ error: 'SE_SYNC_DISABLED' }, { status: 403 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  let client: SupabaseClient;
  if (mode === 'SCHEDULED') {
    const secret = process.env.CRON_SECRET;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret || !serviceKey || !sameSecret(token, secret))
      return NextResponse.json({ error: 'SE_SCHEDULE_FORBIDDEN' }, { status: 401 });
    client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  } else {
    if (!token) return NextResponse.json({ error: 'SE_AUTH_REQUIRED' }, { status: 401 });
    client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return NextResponse.json({ error: 'SE_AUTH_REQUIRED' }, { status: 401 });
    // se_sync_reserve checks the current active ADMIN membership inside the database.
  }
  const { data: previous, error: previousError } = await client.from('se_api_sync_runs')
    .select('state,error_code,retry_after_at').eq('page_no', 1)
    .order('requested_at', { ascending: false }).limit(1).maybeSingle();
  if (previousError) return NextResponse.json({ error: 'SE_SYNC_STATE_UNAVAILABLE' }, { status: 503 });
  if (mode === 'SCHEDULED' && previous?.state === 'FAILED' && previous.error_code === 'HTTP_401')
    return NextResponse.json({ error: 'SE_AUTH_SUSPENDED' }, { status: 423 });
  if (previous?.state === 'FAILED' && previous.error_code === 'HTTP_429'
    && previous.retry_after_at && Date.parse(previous.retry_after_at) > Date.now())
    return NextResponse.json({ error: 'SE_RETRY_AFTER' }, {
      status: 429, headers: { 'Retry-After': String(Math.ceil((Date.parse(previous.retry_after_at) - Date.now()) / 1000)) },
    });
  try {
    const result = await runSePartnerSync(mode, store(client), async (since, cursor) => {
      const apiUrl = new URL(endpoint);
      if (since) apiUrl.searchParams.set('since', since);
      if (cursor) apiUrl.searchParams.set('cursor', cursor);
      return fetch(apiUrl, {
        method: 'GET', headers: { 'X-API-Key': process.env.SE_API_KEY! },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    });
    return NextResponse.json(result);
  } catch (cause) {
    const code = cause instanceof SESyncError ? cause.code : 'SE_SYNC_FAILED';
    const retryAfter = cause instanceof SESyncError ? cause.retryAfter : null;
    return NextResponse.json({ error: code }, {
      status: code === 'HTTP_429' ? 429 : code === 'HTTP_401' ? 401 : 503,
      headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
    });
  }
}

export async function POST(request: NextRequest) { return synchronize(request, 'MANUAL'); }
// Schedule capability only. No cron configuration is enabled in this change.
export async function GET(request: NextRequest) { return synchronize(request, 'SCHEDULED'); }
