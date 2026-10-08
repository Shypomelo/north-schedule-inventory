const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./test-load-ts.cjs');
const { runSePartnerSync, liveSyncGate, SESyncError } = load(path.resolve(__dirname, 'se-partner-sync.ts'));
const { seOrderMockResponse } = load(path.resolve(__dirname, 'se-order-mock.ts'));

function harness(pages) {
  const events = [], applied = [], failed = [];
  const store = {
    async reserve(mode, runId, pageNo) {
      events.push(`reserve:${pageNo}`);
      return { request_id: `request-${pageNo}`, run_id: runId || 'run-1', since_at: '2026-10-01T00:00:00.000Z' };
    },
    async apply(runId, payload, pageCount) { events.push('apply'); applied.push({ runId, payload, pageCount }); },
    async fail(runId, code, retryAfterAt) { events.push(`fail:${code}`); failed.push({ runId, code, retryAfterAt }); },
  };
  const fetchPage = async (since, cursor) => {
    events.push(`fetch:${cursor || 'first'}`);
    assert.equal(since, '2026-10-01T00:00:00.000Z');
    return pages.shift();
  };
  return { store, fetchPage, events, applied, failed };
}
const page = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('live gate excludes local, preview, Candidate and missing key', () => {
  const base = { SE_SYNC_MODE: 'LIVE', VERCEL_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://dghozkqvxlwpjmgleekw.supabase.co', SE_API_KEY: 'present-only-in-test' };
  assert.equal(liveSyncGate({}), false);
  assert.equal(liveSyncGate({ ...base, VERCEL_ENV: 'preview' }), false);
  assert.equal(liveSyncGate({ ...base, VERCEL_ENV: undefined }), false);
  assert.equal(liveSyncGate({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'https://fssogssryeunkjkdgewx.supabase.co' }), false);
  assert.equal(liveSyncGate({ ...base, SE_API_KEY: undefined }), false);
  assert.equal(liveSyncGate(base), true);
});

test('Mock pagination reserves each GET and applies only after all pages', async () => {
  const first = { ...seOrderMockResponse, orders: seOrderMockResponse.orders.slice(0, 2),
    count: 2, hasMore: true, nextCursor: 'next' };
  const second = { ...seOrderMockResponse, orders: seOrderMockResponse.orders.slice(2),
    count: 1, removed: [], hasMore: false, nextCursor: null };
  const h = harness([page(first), page(second)]);
  const result = await runSePartnerSync('SCHEDULED', h.store, h.fetchPage);
  assert.deepEqual(h.events, ['reserve:1', 'fetch:first', 'reserve:2', 'fetch:next', 'apply']);
  assert.deepEqual(result, { runId: 'run-1', pages: 2, orders: 3, removed: 2 });
  assert.equal(h.applied[0].payload.orders[0].items.length, 2);
  assert.equal(h.applied[0].payload.orders[1].status, 'partner_review');
  assert.equal(h.failed.length, 0);
});

test('page failure never applies or advances a watermark; 429 retains Retry-After', async () => {
  const first = { ...seOrderMockResponse, count: 0, orders: [], removed: [], hasMore: true, nextCursor: 'next' };
  const h = harness([page(first), new Response('', { status: 429, headers: { 'Retry-After': '3600' } })]);
  await assert.rejects(runSePartnerSync('MANUAL', h.store, h.fetchPage), error =>
    error instanceof SESyncError && error.code === 'HTTP_429' && error.retryAfter === '3600');
  assert.deepEqual(h.events, ['reserve:1', 'fetch:first', 'reserve:2', 'fetch:next', 'fail:HTTP_429']);
  assert.equal(h.applied.length, 0);
  assert(Date.parse(h.failed[0].retryAfterAt) > Date.now() + 3500 * 1000);
});

test('401 and 500 stop without retrying', async () => {
  for (const status of [401, 500]) {
    const h = harness([new Response('', { status })]);
    await assert.rejects(runSePartnerSync('SCHEDULED', h.store, h.fetchPage));
    assert.deepEqual(h.events, ['reserve:1', 'fetch:first', `fail:HTTP_${status}`]);
  }
});

test('page limit and repeated cursor fail before snapshot apply', async () => {
  const next = cursor => page({ ...seOrderMockResponse, orders: [], count: 0, removed: [],
    hasMore: true, nextCursor: cursor });
  const repeat = harness([next('same'), next('same')]);
  await assert.rejects(runSePartnerSync('MANUAL', repeat.store, repeat.fetchPage), { code: 'SE_CURSOR_INVALID' });
  assert.equal(repeat.applied.length, 0);
  const limit = harness([next('1'), next('2'), next('3'), next('4')]);
  await assert.rejects(runSePartnerSync('MANUAL', limit.store, limit.fetchPage), { code: 'SE_PAGE_LIMIT' });
  assert.equal(limit.applied.length, 0);
  assert.equal(limit.events.filter(value => value.startsWith('fetch:')).length, 4);
});
