#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CANDIDATE_REF = 'fssogssryeunkjkdgewx';
const PRODUCTION_REF = 'dghozkqvxlwpjmgleekw';
const action = process.argv[2] ?? 'verify';
const targetRef = process.env.SUPABASE_PROJECT_REF ?? '';
const accessToken = process.env.SUPABASE_ACCESS_TOKEN ?? '';

export const BUSINESS_TABLES = [
  'contractors',
  'dashboard_views',
  'inventory_batches',
  'inventory_initialization_items',
  'inventory_initialization_serials',
  'inventory_initializations',
  'inventory_items',
  'inventory_monthly_closing_items',
  'inventory_monthly_closings',
  'inventory_serials',
  'inventory_transaction_serials',
  'inventory_transactions',
  'member_dashboard_views',
  'member_positions',
  'member_work_groups',
  'positions',
  'project_construction_progress',
  'project_difficulty_assessments',
  'project_milestones',
  'project_position_assignments',
  'project_workflow_instances',
  'project_workflow_phases',
  'project_workflow_template_steps',
  'project_workflow_templates',
  'project_workflow_types',
  'projects',
  'schedule_task_types',
  'schedule_tasks',
  'se_supply_records',
  'team_members',
  'todos',
  'work_groups',
  'work_items',
  'work_zones',
];

const files = {
  bootstrap: 'supabase/review/schema-bootstrap.sql',
  cleanup: 'supabase/review/cleanup.sql',
  verify: 'supabase/review/contract-verification.sql',
};

function fail(message) {
  console.error(`candidate-review: ${message}`);
  process.exit(1);
}

function assertRuntimeGuards() {
  const actions = [...Object.keys(files), 'refresh', 'verify-data'];
  if (!actions.includes(action)) fail(`unknown action "${action}" (${actions.join('|')})`);
  if (!targetRef) fail('SUPABASE_PROJECT_REF is required');
  if (targetRef === PRODUCTION_REF) fail('production project is forbidden as a mutation target');
  if (targetRef !== CANDIDATE_REF) fail(`project ${targetRef} is not the allowed review project`);
  if (!accessToken) fail('SUPABASE_ACCESS_TOKEN is required');
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) fail(`unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function query(projectRef, sql, { readOnly = true } = {}) {
  if (projectRef === PRODUCTION_REF && !readOnly) {
    fail('attempted a non-read-only Production query');
  }
  const suffix = readOnly ? '/read-only' : '';
  const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query${suffix}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase SQL failed for ${projectRef} (${response.status}): ${body}`);
  return body ? JSON.parse(body) : null;
}

async function assertCandidateDatabaseGuard() {
  const result = await query(CANDIDATE_REF, `
    select
      exists (
        select 1 from supabase_migrations.schema_migrations
        where name = 'candidate_review_production_shape_baseline'
      ) as candidate_baseline,
      exists (
        select 1 from review_private.environment_guard
        where singleton and project_ref = '${CANDIDATE_REF}' and purpose = 'CANDIDATE_REVIEW'
      ) as environment_guard
  `);
  if (!result?.[0]?.candidate_baseline || !result?.[0]?.environment_guard) {
    fail('remote Candidate migration/environment fingerprint is missing');
  }
}

const tableListSql = BUSINESS_TABLES.map(sqlString).join(',');

async function loadMetadata(projectRef) {
  const result = await query(projectRef, `
    select c.relname as table_name,
      jsonb_agg(jsonb_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid,a.atttypmod),
        'generated', a.attgenerated,
        'identity', a.attidentity
      ) order by a.attnum) as columns
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${tableListSql})
    group by c.relname
    order by c.relname
  `);
  return new Map(result.map(row => [row.table_name, row.columns]));
}

function assertMetadataParity(source, target) {
  for (const table of BUSINESS_TABLES) {
    const sourceColumns = source.get(table);
    const targetColumns = target.get(table);
    if (!sourceColumns || !targetColumns) fail(`missing required table metadata: public.${table}`);
    const byName = columns => [...columns].sort((left, right) => left.name.localeCompare(right.name));
    if (JSON.stringify(byName(sourceColumns)) !== JSON.stringify(byName(targetColumns))) {
      fail(`schema parity mismatch for public.${table}`);
    }
    const sensitive = sourceColumns.filter(column => /(secret|password|credential|token|api.?key)/i.test(column.name));
    if (sensitive.length) fail(`sensitive-looking columns found in public.${table}`);
  }
}

async function exportTable(projectRef, table) {
  const result = await query(projectRef, `
    select coalesce(jsonb_agg(to_jsonb(row_data) order by to_jsonb(row_data)::text),'[]'::jsonb) as rows
    from public.${quoteIdentifier(table)} row_data
  `);
  return result?.[0]?.rows ?? [];
}

async function mapWithConcurrency(values, limit, mapper) {
  const result = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return result;
}

async function exportSnapshot(projectRef) {
  const rows = await mapWithConcurrency(BUSINESS_TABLES, 4, table => exportTable(projectRef, table));
  return new Map(BUSINESS_TABLES.map((table, index) => [table, rows[index]]));
}

function applyCandidateSafetyShape(snapshot) {
  const workGroups = snapshot.get('work_groups') ?? [];
  snapshot.set('work_groups', workGroups.map(row => ({ ...row, google_calendar_sync_enabled: false })));
  return snapshot;
}

async function authFingerprint() {
  const result = await query(CANDIDATE_REF, `
    select count(*)::bigint as user_count,
      md5(coalesce(string_agg(id::text, ',' order by id),'')) as id_fingerprint
    from auth.users
  `);
  return result?.[0] ?? null;
}

async function fixtureCount() {
  const result = await query(CANDIDATE_REF, `
    select sum(count_value)::bigint as fixture_count from (
      select count(*) count_value from public.activity_logs where target_id like 'c0000000-0000-4000-8000-%' or message='REVIEW_FIXTURE baseline ready'
      union all select count(*) from public.contractors where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.inventory_batches where id::text like 'c0000000-0000-4000-8000-%' or source_transaction_id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.inventory_items where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.inventory_serials where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.inventory_transaction_serials where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.inventory_transactions where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.member_positions where member_id::text like 'c0000000-0000-4000-8000-%' or position_id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.member_work_groups where member_id::text like 'c0000000-0000-4000-8000-%' or work_group_id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.positions where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_construction_progress where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_milestones where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_position_assignments where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_workflow_instances where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_workflow_phases where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_workflow_template_steps where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_workflow_templates where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.project_workflow_types where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.projects where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.schedule_tasks where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.se_supply_records where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.team_members where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.todos where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.work_groups where id::text like 'c0000000-0000-4000-8000-%'
      union all select count(*) from public.work_items where id::text like 'c0000000-0000-4000-8000-%'
    ) fixture_rows
  `);
  return Number(result?.[0]?.fixture_count ?? 0);
}

function dollarQuote(value, index) {
  const tag = `$candidate_snapshot_${index}$`;
  if (value.includes(tag)) fail('snapshot data collided with SQL dollar quote tag');
  return `${tag}${value}${tag}`;
}

async function buildRefreshSql(snapshot, metadata) {
  const safetyOverrides = await readFile(resolve('supabase/review/candidate-safety-overrides.sql'), 'utf8');
  const deletes = ['activity_logs', ...BUSINESS_TABLES]
    .map(table => `DELETE FROM public.${quoteIdentifier(table)};`)
    .join('\n');
  const inserts = BUSINESS_TABLES.map((table, index) => {
    const rows = snapshot.get(table) ?? [];
    if (!rows.length) return `-- public.${table}: 0 rows`;
    const columns = metadata.get(table).filter(column => !column.generated).map(column => column.name);
    const identifiers = columns.map(quoteIdentifier).join(',');
    const selectList = columns.map(column => `record.${quoteIdentifier(column)}`).join(',');
    const json = dollarQuote(JSON.stringify(rows), index);
    return `INSERT INTO public.${quoteIdentifier(table)} (${identifiers}) OVERRIDING SYSTEM VALUE\n` +
      `SELECT ${selectList} FROM jsonb_populate_recordset(NULL::public.${quoteIdentifier(table)}, ${json}::jsonb) record;`;
  }).join('\n');

  return `BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '180s';
SET LOCAL session_replication_role = replica;
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM review_private.environment_guard
    WHERE singleton AND project_ref='${CANDIDATE_REF}' AND purpose='CANDIDATE_REVIEW'
  ) THEN RAISE EXCEPTION 'candidate review guard failed'; END IF;
END
$guard$;
${deletes}
${inserts}
${safetyOverrides}
NOTIFY pgrst, 'reload schema';
COMMIT;`;
}

function compareSnapshots(expected, actual) {
  const byTable = {};
  let allExact = true;
  for (const table of BUSINESS_TABLES) {
    const expectedRows = expected.get(table) ?? [];
    const actualRows = actual.get(table) ?? [];
    const exact = JSON.stringify(expectedRows) === JSON.stringify(actualRows);
    byTable[table] = { expected: expectedRows.length, actual: actualRows.length, exact };
    allExact &&= exact;
  }
  return { exact: allExact, byTable };
}

async function verifyCandidateSafety() {
  const result = await query(CANDIDATE_REF, `
    select
      (select count(*)::bigint from cron.job where active) as active_cron_jobs,
      (select count(*)::bigint from public.work_groups where google_calendar_sync_enabled) as google_enabled_work_groups,
      (select count(*)::bigint
       from pg_proc routine join pg_namespace namespace on namespace.oid=routine.pronamespace
       where namespace.nspname in ('public','app_private') and routine.prokind='f'
         and pg_get_functiondef(routine.oid) ~* '(net\\.http|http_post|http_get|webhook|https?://)') as external_network_routines
  `);
  return result?.[0] ?? null;
}

async function verifyData() {
  const [sourceMetadata, targetMetadata] = await Promise.all([
    loadMetadata(PRODUCTION_REF),
    loadMetadata(CANDIDATE_REF),
  ]);
  assertMetadataParity(sourceMetadata, targetMetadata);
  const [source, target] = await Promise.all([
    exportSnapshot(PRODUCTION_REF).then(applyCandidateSafetyShape),
    exportSnapshot(CANDIDATE_REF),
  ]);
  const comparison = compareSnapshots(source, target);
  const safety = await verifyCandidateSafety();
  return { comparison, safety };
}

async function refresh() {
  const [sourceMetadata, targetMetadata, authBefore, fixturesBefore] = await Promise.all([
    loadMetadata(PRODUCTION_REF),
    loadMetadata(CANDIDATE_REF),
    authFingerprint(),
    fixtureCount(),
  ]);
  assertMetadataParity(sourceMetadata, targetMetadata);

  const snapshot = applyCandidateSafetyShape(await exportSnapshot(PRODUCTION_REF));
  const refreshSql = await buildRefreshSql(snapshot, targetMetadata);
  await query(CANDIDATE_REF, refreshSql, { readOnly: false });

  const [verification, authAfter, fixturesAfter] = await Promise.all([
    verifyData(),
    authFingerprint(),
    fixtureCount(),
  ]);
  if (!verification.comparison.exact) fail('Candidate data differs from the safety-shaped Production snapshot');
  if (JSON.stringify(authBefore) !== JSON.stringify(authAfter)) fail('Candidate auth.users changed during refresh');
  if (fixturesAfter !== 0) fail(`Candidate fixture rows remain after refresh: ${fixturesAfter}`);
  if (Number(verification.safety?.active_cron_jobs ?? -1) !== 0) fail('Candidate has active cron jobs');
  if (Number(verification.safety?.google_enabled_work_groups ?? -1) !== 0) fail('Candidate has Google-enabled work groups');
  if (Number(verification.safety?.external_network_routines ?? -1) !== 0) fail('Candidate has an external network database routine');

  return {
    action: 'refresh',
    sourceProjectRef: PRODUCTION_REF,
    targetProjectRef: CANDIDATE_REF,
    productionReadOnly: true,
    fixturesRemoved: fixturesBefore,
    authUsersCopied: false,
    authUsersUnchanged: true,
    tables: Object.fromEntries(BUSINESS_TABLES.map(table => [table, snapshot.get(table).length])),
    exactDataMatch: true,
    uuidAndForeignKeysPreserved: true,
    safety: verification.safety,
  };
}

async function main() {
  assertRuntimeGuards();
  await assertCandidateDatabaseGuard();

  if (action === 'refresh') {
    console.log(JSON.stringify(await refresh(), null, 2));
    return;
  }
  if (action === 'verify-data') {
    console.log(JSON.stringify({ action, ...(await verifyData()) }, null, 2));
    return;
  }

  const sql = await readFile(resolve(files[action]), 'utf8');
  const result = await query(CANDIDATE_REF, sql, { readOnly: action === 'verify' });
  console.log(JSON.stringify({ action, projectRef: CANDIDATE_REF, result }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
