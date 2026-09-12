import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./candidate-review.mjs', import.meta.url), 'utf8');
const safety = await readFile(new URL('../supabase/review/candidate-safety-overrides.sql', import.meta.url), 'utf8');

test('Production can only be queried through the read-only endpoint', () => {
  assert.match(source, /projectRef === PRODUCTION_REF && !readOnly/);
  assert.match(source, /database\/query\$\{suffix\}/);
  assert.match(source, /const suffix = readOnly \? '\/read-only' : ''/);
});

test('refresh targets only Candidate and never includes auth or activity logs', () => {
  assert.match(source, /targetRef !== CANDIDATE_REF/);
  assert.doesNotMatch(source.match(/export const BUSINESS_TABLES = \[[\s\S]*?\];/)?.[0] ?? '', /auth|activity_logs/);
  assert.match(source, /from auth\.users/);
  assert.match(source, /authUsersCopied: false/);
});

test('refresh uses a transaction without truncate and applies safety overrides', () => {
  assert.match(source, /BEGIN;/);
  assert.match(source, /session_replication_role = replica/);
  assert.doesNotMatch(source, /TRUNCATE/i);
  assert.match(source, /candidate-safety-overrides\.sql/);
  assert.match(safety, /active cron job exists/);
  assert.match(safety, /external network routine exists/);
});
