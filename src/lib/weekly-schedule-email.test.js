const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const load = require('./test-load-ts.cjs');

const { handleWeeklyScheduleEmail, weeklyEmailContent, parseWeekStart, MAX_WEEKLY_PNG_BYTES } = load(
  path.join(__dirname, 'server/weekly-schedule-email.ts'),
  { '@/lib/server/supabase-auth': { requireActiveTeamMember: async () => ({ context: null, error: Response.json({}, { status: 401 }) }) } },
);

const CANDIDATE_URL = 'https://fssogssryeunkjkdgewx.supabase.co';
const PRODUCTION_URL = 'https://dghozkqvxlwpjmgleekw.supabase.co';
const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function request(overrides = {}) {
  const form = new FormData();
  form.set('recipient', overrides.recipient ?? 'one@example.com');
  form.set('weekStart', overrides.weekStart ?? '2026-10-05');
  form.set('workGroupId', overrides.workGroupId ?? GROUP_ID);
  form.set('image', overrides.image ?? new File([PNG], 'schedule.png', { type: 'image/png' }));
  return new Request('http://localhost/api/schedule/weekly-email', {
    method: 'POST',
    headers: { Authorization: 'Bearer test' },
    body: form,
  });
}

function member(role = 'ENGINEER', active = true, canReadGroup = true) {
  if (!active) return async () => ({ context: null, error: Response.json({}, { status: 403 }) });
  const supabase = {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          return { data: table === 'work_groups' ? { id: GROUP_ID } : canReadGroup ? { work_group_id: GROUP_ID } : null, error: null };
        },
      };
      return query;
    },
  };
  return async () => ({ context: { member: { id: 'member-1', role }, supabase }, error: null });
}

const preview = { VERCEL_ENV: 'preview', NEXT_PUBLIC_SUPABASE_URL: CANDIDATE_URL };
const production = { VERCEL_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL };

async function execute(overrides = {}, options = {}) {
  const calls = [];
  const response = await handleWeeklyScheduleEmail(request(overrides), {
    requireMember: options.requireMember ?? member(),
    env: options.env ?? preview,
    send: async (...args) => { calls.push(args); return options.providerResponse ?? Response.json({ id: 'mock-id' }); },
  });
  return { status: response.status, body: await response.json(), calls };
}

test('A: unauthenticated request is 401', async () => {
  const result = await execute({}, { requireMember: async () => ({ context: null, error: Response.json({}, { status: 401 }) }) });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'UNAUTHORIZED');
});

test('B and C: procurement and inactive member are denied', async () => {
  for (const requireMember of [member('PROCUREMENT'), member('ENGINEER', false)]) {
    const result = await execute({}, { requireMember });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'FORBIDDEN');
  }
});

test('D: invalid or multiple recipient is rejected', async () => {
  for (const recipient of ['invalid', 'a@example.com,b@example.com']) {
    const result = await execute({ recipient });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_EMAIL');
  }
});

test('E: non-PNG and forged PNG are rejected', async () => {
  for (const image of [
    new File(['text'], 'schedule.txt', { type: 'text/plain' }),
    new File(['fake'], 'schedule.png', { type: 'image/png' }),
  ]) {
    const result = await execute({ image });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_IMAGE');
  }
});

test('F: PNG over 4 MB is 413', async () => {
  const result = await execute({ image: new File([PNG, new Uint8Array(MAX_WEEKLY_PNG_BYTES)], 'large.png', { type: 'image/png' }) });
  assert.equal(result.status, 413);
  assert.equal(result.body.error, 'IMAGE_TOO_LARGE');
});

test('G: work group outside membership is 403', async () => {
  const result = await execute({}, { requireMember: member('VIEWER', true, false) });
  assert.equal(result.status, 403);
});

test('VIEWER with membership and ADMIN without membership may send', async () => {
  assert.equal((await execute({}, { requireMember: member('VIEWER') })).status, 200);
  assert.equal((await execute({}, { requireMember: member('ADMIN', true, false) })).status, 200);
});

test('H: Preview completes validation and payload assembly without provider call', async () => {
  const result = await execute();
  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, true);
  assert.equal(result.calls.length, 0);
});

test('candidate project or explicit external-side-effect guard never calls provider', async () => {
  for (const env of [
    { ...production, NEXT_PUBLIC_SUPABASE_URL: CANDIDATE_URL, WEEKLY_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-key', WEEKLY_EMAIL_FROM: 'sender@example.com' },
    { ...production, DISABLE_EXTERNAL_SIDE_EFFECTS: 'true', WEEKLY_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-key', WEEKLY_EMAIL_FROM: 'sender@example.com' },
  ]) {
    const result = await execute({}, { env });
    assert.equal(result.body.dryRun, true);
    assert.equal(result.calls.length, 0);
  }
});

test('I and J: Production disabled or missing configuration cannot send', async () => {
  const disabled = await execute({}, { env: production });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.error, 'EMAIL_DISABLED');
  assert.equal(disabled.calls.length, 0);
  const missing = await execute({}, { env: { ...production, WEEKLY_EMAIL_ENABLED: 'true' } });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, 'EMAIL_NOT_CONFIGURED');
  assert.equal(missing.calls.length, 0);
});

test('K: Production mocked provider receives fixed text, recipient and PNG', async () => {
  const result = await execute({}, { env: { ...production, WEEKLY_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-key', WEEKLY_EMAIL_FROM: 'sender@example.com' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, false);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0][0], 'https://api.resend.com/emails');
  const payload = JSON.parse(result.calls[0][1].body);
  assert.equal(payload.to, 'one@example.com');
  assert.equal(payload.from, 'sender@example.com');
  assert.equal(payload.subject, '北部工程週排程｜2026/10/05 - 2026/10/10');
  assert.equal(payload.text, '附件為本週工程排程，請查收。');
  assert.equal(payload.attachments[0].filename, '北部工程週排程_2026-10-05.png');
  assert.deepEqual(Buffer.from(payload.attachments[0].content, 'base64'), Buffer.from(PNG));
});

test('L: provider failure does not return provider details', async () => {
  const result = await execute({}, { env: { ...production, WEEKLY_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'secret-key', WEEKLY_EMAIL_FROM: 'sender@example.com' }, providerResponse: Response.json({ message: 'private provider detail' }, { status: 400 }) });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'EMAIL_PROVIDER_FAILED');
  assert.doesNotMatch(JSON.stringify(result.body), /private provider detail|secret-key/);
});

test('visible week dates support +3 and -4 navigation and reject wrong week start', () => {
  const monday = new Date('2026-10-05T00:00:00Z');
  for (const [offset, expected] of [[3, '2026-10-26'], [-4, '2026-09-07']]) {
    const viewed = new Date(monday);
    viewed.setUTCDate(viewed.getUTCDate() + offset * 7);
    assert.equal(weeklyEmailContent(parseWeekStart(viewed.toISOString().slice(0, 10))).filename, `北部工程週排程_${expected}.png`);
  }
  assert.equal(parseWeekStart('2026-10-06'), null);
  assert.equal(parseWeekStart('2026-02-30'), null);
});
