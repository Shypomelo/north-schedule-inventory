#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CANDIDATE_REF = 'fssogssryeunkjkdgewx';
const PRODUCTION_REF = 'dghozkqvxlwpjmgleekw';
const token = process.env.SUPABASE_ACCESS_TOKEN ?? '';
if (!token) {
  console.error('schema-parity: SUPABASE_ACCESS_TOKEN is required');
  process.exit(1);
}

const appRelations = new Set([
  'public.activity_logs','public.contractors','public.dashboard_views','public.inventory_batches',
  'public.inventory_initialization_items','public.inventory_initialization_serials','public.inventory_initializations',
  'public.inventory_items','public.inventory_monthly_closing_items','public.inventory_monthly_closings',
  'public.inventory_serials','public.inventory_transaction_serials','public.inventory_transactions',
  'public.member_dashboard_views','public.member_positions','public.member_work_groups','public.positions',
  'public.project_construction_progress','public.project_difficulty_assessments','public.project_milestones',
  'public.project_position_assignments','public.project_workflow_instances','public.project_workflow_phases',
  'public.project_workflow_template_steps','public.project_workflow_templates','public.project_workflow_types',
  'public.projects','public.schedule_task_types','public.schedule_tasks','public.se_supply_records',
  'public.team_members','public.todos','public.work_groups','public.work_items','public.work_zones',
]);

const sql = await readFile(resolve('supabase/review/contract-snapshot.sql'),'utf8');
async function snapshot(ref) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query/read-only`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, read_only: true }),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`snapshot ${ref} failed (${response.status}): ${body}`);
  return JSON.parse(body)[0].schema_snapshot;
}

const [production,candidate] = await Promise.all([snapshot(PRODUCTION_REF),snapshot(CANDIDATE_REF)]);
const details = {};
const summary = {};
function comparable(category,value) {
  if (category !== 'functions') return value;
  if (typeof value === 'string') return value.replace(/\r\n/g,'\n');
  if (Array.isArray(value)) return value.map(item => comparable(category,item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,comparable(category,item)]));
  }
  return value;
}
for (const category of Object.keys(production)) {
  const expected = production[category] ?? {};
  const actual = candidate[category] ?? {};
  const missing = Object.keys(expected).filter(key => !(key in actual));
  const mismatch = Object.keys(expected).filter(
    key => key in actual && JSON.stringify(comparable(category,expected[key])) !== JSON.stringify(comparable(category,actual[key])),
  );
  const extra = Object.keys(actual).filter(key => !(key in expected));
  details[category] = { missing, mismatch, extra };
  summary[category] = {
    production: Object.keys(expected).length,
    candidate: Object.keys(actual).length,
    missing: missing.length,
    mismatch: mismatch.length,
    extra: extra.length,
  };
}

const productionOnlyButAppUnused = Object.keys(production.relations)
  .filter(key => !appRelations.has(key));
const acceptedDeltas = {
  extensions: ['pg_net installation namespace metadata only; version and extension objects are present'],
  table_grants: ['Candidate deliberately omits Production legacy anon and TRUNCATE/TRIGGER/REFERENCES privileges'],
};
const verdict = Object.entries(details).every(([category,value]) => {
  if (category === 'extensions') {
    return value.missing.length === 0 && value.extra.length === 0 && value.mismatch.every(key => key === 'pg_net');
  }
  if (category === 'table_grants') return value.extra.length === 0;
  return value.missing.length === 0 && value.mismatch.length === 0;
}) ? 'REVIEW_READY_WITH_INTENTIONAL_SECURITY_DELTA' : 'DRIFT';

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  candidate_project_ref: CANDIDATE_REF,
  production_project_ref: PRODUCTION_REF,
  production_read_only: true,
  app_relation_count: appRelations.size,
  summary,
  details,
  accepted_deltas: acceptedDeltas,
  production_only_but_app_unused: productionOnlyButAppUnused,
  verdict,
},null,2));
