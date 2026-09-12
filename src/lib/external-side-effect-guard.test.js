const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

test('external mutation guard only permits the production project ref', () => {
  const guard = read('server/external-side-effect-guard.ts');
  assert.match(guard, /dghozkqvxlwpjmgleekw/);
  assert.match(guard, /fssogssryeunkjkdgewx/);
  assert.match(guard, /projectRef !== PRODUCTION_PROJECT_REF/);
  assert.match(guard, /DISABLE_EXTERNAL_SIDE_EFFECTS/);
});

test('every Google mutation route checks the external side-effect guard first', () => {
  for (const relativePath of [
    '../app/api/google-calendar/sync/route.ts',
    '../app/api/google-calendar/reconcile/route.ts',
    '../app/api/google-calendar/reconcile/cron/route.ts',
  ]) {
    const source = read(relativePath);
    const guard = source.indexOf('getExternalSideEffectGuard()');
    const googleMutation = Math.min(...[
      source.indexOf('getGoogleCalendarClient()'),
      source.indexOf('reconcileGoogleCalendarCore('),
    ].filter(index => index >= 0));
    assert.ok(guard >= 0, `${relativePath} must invoke the guard`);
    assert.ok(googleMutation >= 0 && guard < googleMutation, `${relativePath} must guard before Google mutation`);
  }
});
