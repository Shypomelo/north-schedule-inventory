const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const load = file => require('./test-load-ts.cjs')(path.join(__dirname, file));
const {
  buildOAuthRedirectUrl,
  getSafeNextPath,
  initializeAuth,
  resolveAuthSession,
  resolveAuthStateChange,
  selectLoginNextPath,
  withAuthFailureTimeout,
} = load('auth-lifecycle.ts');

const user = (overrides = {}) => ({
  id: 'member',
  name: 'Member',
  short_name: 'M',
  email: 'member@example.test',
  role: 'ENGINEER',
  is_active: true,
  created_at: '',
  updated_at: '',
  ...overrides,
});
const session = { user: { email: ' MEMBER@example.test ' } };

test('no session settles logged-out without member lookup', async () => {
  let lookups = 0;
  const result = await initializeAuth(
    async () => ({ data: { session: null }, error: null }),
    async () => { lookups += 1; return [user()]; },
  );
  assert.equal(result.status, 'logged-out');
  assert.equal(result.currentUser, null);
  assert.equal(lookups, 0);
});

test('valid session settles authenticated after member lookup success', async () => {
  const result = await initializeAuth(
    async () => ({ data: { session }, error: null }),
    async () => [user()],
  );
  assert.equal(result.status, 'authenticated');
  assert.equal(result.currentUser.id, 'member');
});

test('invalid stored session error terminates and requests local cleanup', async () => {
  const result = await initializeAuth(
    async () => ({ data: { session: null }, error: { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' } }),
    async () => [],
  );
  assert.equal(result.status, 'error');
  assert.equal(result.shouldClearLocalSession, true);
});

test('ordinary getSession error terminates in explicit error state', async () => {
  const result = await initializeAuth(
    async () => ({ data: { session: null }, error: new Error('network unavailable') }),
    async () => [],
  );
  assert.equal(result.status, 'error');
  assert.equal(result.shouldClearLocalSession, false);
});

test('member lookup with no matching active member terminates and requests cleanup', async () => {
  const missing = await resolveAuthSession(session, async () => [user({ email: 'other@example.test' })]);
  const inactive = await resolveAuthSession(session, async () => [user({ is_active: false })]);
  assert.equal(missing.status, 'error');
  assert.equal(missing.shouldClearLocalSession, true);
  assert.equal(inactive.status, 'error');
  assert.equal(inactive.shouldClearLocalSession, true);
});

test('member lookup error terminates without pretending session is valid', async () => {
  const result = await resolveAuthSession(session, async () => { throw new Error('RLS denied'); });
  assert.equal(result.status, 'error');
  assert.equal(result.currentUser, null);
  assert.equal(result.shouldClearLocalSession, false);
});

test('SIGNED_OUT settles logged-out immediately', async () => {
  const result = await resolveAuthStateChange('SIGNED_OUT', null, async () => { throw new Error('must not load'); });
  assert.equal(result.status, 'logged-out');
});

test('SIGNED_IN resolves the active member', async () => {
  const result = await resolveAuthStateChange('SIGNED_IN', session, async () => [user()]);
  assert.equal(result.status, 'authenticated');
});

test('pending getSession exits loading through explicit timeout error', async () => {
  const result = await initializeAuth(() => new Promise(() => {}), async () => [], 5);
  assert.equal(result.status, 'error');
  assert.match(result.error, /逾時/);
});

test('pending member lookup exits loading through explicit timeout error', async () => {
  const result = await resolveAuthSession(session, () => new Promise(() => {}), 5);
  assert.equal(result.status, 'error');
  assert.match(result.error, /逾時/);
});

test('pending interactive auth operation rejects instead of leaving loading active', async () => {
  await assert.rejects(
    withAuthFailureTimeout(new Promise(() => {}), 5, '登入服務回應逾時'),
    /登入服務回應逾時/,
  );
});

test('login next redirect is preserved and external paths are rejected', () => {
  assert.equal(selectLoginNextPath('/schedule?view=week', '/'), '/schedule?view=week');
  assert.equal(selectLoginNextPath('/', '/projects'), '/projects');
  assert.equal(getSafeNextPath('//evil.example'), '/');
  assert.equal(buildOAuthRedirectUrl('http://localhost:3002', '/schedule'), 'http://localhost:3002/login?next=%2Fschedule');
  assert.equal(buildOAuthRedirectUrl('http://127.0.0.1:3002', '/schedule'), 'http://127.0.0.1:3002/login?next=%2Fschedule');
});

test('AuthGuard redirects unauthenticated routes only after loading settles', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'AuthGuard.tsx'), 'utf8');
  assert.match(source, /!isLoading && !currentUser && pathname !== '\/login'/);
  assert.match(source, /\/login\?next=\$\{encodeURIComponent\(currentPath\)\}/);
});

test('provider handles resolved OAuth errors and local invalid-session cleanup without bypass', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'UserContext.tsx'), 'utf8');
  assert.match(source, /signOut\(\{ scope: 'local' \}\)/);
  assert.match(source, /withAuthFailureTimeout\([\s\S]*supabase\.auth\.signInWithOAuth/);
  assert.doesNotMatch(source, /fake|hardcode.*email|skip.*AuthGuard/i);
});
