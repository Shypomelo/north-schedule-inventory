#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CANDIDATE_REF = 'fssogssryeunkjkdgewx';
const PRODUCTION_REF = 'dghozkqvxlwpjmgleekw';
const action = process.argv[2] ?? 'verify';
const projectRef = process.env.SUPABASE_PROJECT_REF ?? '';
const accessToken = process.env.SUPABASE_ACCESS_TOKEN ?? '';

const files = {
  bootstrap: 'supabase/review/schema-bootstrap.sql',
  fixtures: 'supabase/review/fixtures.sql',
  cleanup: 'supabase/review/cleanup.sql',
  verify: 'supabase/review/contract-verification.sql',
};

function fail(message) {
  console.error(`candidate-review: ${message}`);
  process.exit(1);
}

if (!(action in files)) fail(`unknown action "${action}" (bootstrap|fixtures|cleanup|verify)`);
if (!projectRef) fail('SUPABASE_PROJECT_REF is required');
if (projectRef === PRODUCTION_REF) fail('production project is forbidden');
if (projectRef !== CANDIDATE_REF) fail(`project ${projectRef} is not an allowed review project`);
if (!accessToken) fail('SUPABASE_ACCESS_TOKEN is required');

const mutating = action !== 'verify';
const baseUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};

async function query(sql, readOnly) {
  const response = await fetch(readOnly ? `${baseUrl}/read-only` : baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: sql, read_only: readOnly }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase SQL failed (${response.status}): ${body}`);
  return body ? JSON.parse(body) : null;
}

const guard = await query(
  `select exists (
     select 1 from supabase_migrations.schema_migrations
     where name = 'candidate_review_production_shape_baseline'
   ) as candidate_baseline`,
  true,
);
if (!guard?.[0]?.candidate_baseline) fail('remote candidate migration fingerprint is missing');

const sql = await readFile(resolve(files[action]), 'utf8');
const result = await query(sql, !mutating);
console.log(JSON.stringify({ action, projectRef, result }, null, 2));
