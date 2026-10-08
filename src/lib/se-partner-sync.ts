import { parseSEPartnerResponse, type SEPartnerOrderV1, type SEPartnerRemovedV1 } from './se-partner-contract';

export type SESyncMode = 'MANUAL' | 'SCHEDULED';
export interface SESyncReservation { request_id: string; run_id: string; since_at: string | null }
export interface SESyncStore {
  reserve(mode: SESyncMode, runId: string | null, pageNo: number): Promise<SESyncReservation>;
  apply(runId: string, payload: { orders: SEPartnerOrderV1[]; removed: SEPartnerRemovedV1[] }, pageCount: number): Promise<void>;
  fail(runId: string, code: string, retryAfterAt: string | null): Promise<void>;
}
export class SESyncError extends Error {
  constructor(public readonly code: string, public readonly retryAfter: string | null = null) { super(code); }
}

function retryAfterAt(raw: string | null): string {
  const seconds = raw && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  const supplied = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw || '');
  // An absent or invalid header suspends further requests conservatively.
  return new Date(Number.isFinite(supplied) && supplied > Date.now()
    ? supplied : Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

/** Every request is reserved durably before fetch; only complete pagination applies a snapshot. */
export async function runSePartnerSync(mode: SESyncMode, store: SESyncStore,
  fetchPage: (since: string | null, cursor: string | null) => Promise<Response>) {
  let runId: string | null = null;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  const orders: SEPartnerOrderV1[] = [], removed: SEPartnerRemovedV1[] = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const reservation = await store.reserve(mode, runId, page);
      runId = reservation.run_id;
      const response = await fetchPage(reservation.since_at, cursor);
      if (!response.ok) throw new SESyncError(`HTTP_${response.status}`,
        response.status === 429 ? response.headers.get('Retry-After') : null);
      const body = parseSEPartnerResponse(await response.json());
      orders.push(...body.orders);
      if (page === 1) removed.push(...body.removed);
      if (!body.hasMore) {
        await store.apply(runId, { orders, removed }, page);
        return { runId, pages: page, orders: orders.length, removed: removed.length };
      }
      if (!body.nextCursor || seenCursors.has(body.nextCursor)) throw new SESyncError('SE_CURSOR_INVALID');
      seenCursors.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    throw new SESyncError('SE_PAGE_LIMIT');
  } catch (cause) {
    if (runId) await store.fail(runId, cause instanceof SESyncError ? cause.code : 'SE_SYNC_FAILED',
      cause instanceof SESyncError && cause.code === 'HTTP_429' ? retryAfterAt(cause.retryAfter) : null);
    throw cause;
  }
}

export function liveSyncGate(env: Record<string, string | undefined>): boolean {
  return env.SE_SYNC_MODE === 'LIVE' && env.VERCEL_ENV === 'production'
    && env.NEXT_PUBLIC_SUPABASE_URL === 'https://dghozkqvxlwpjmgleekw.supabase.co'
    && Boolean(env.SE_API_KEY);
}
