#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CANDIDATE_REF = 'fssogssryeunkjkdgewx';
const PRODUCTION_REF = 'dghozkqvxlwpjmgleekw';
const FORMAL_REVIEW_MEMBER = Object.freeze({
  id: '65916798-f0ec-4d41-8b17-785c4189bd83',
  name: '柚子',
  email: 'shypomelo@gmail.com',
  role: 'admin',
  category: 'engineering',
});
const CANDIDATE_REVIEWER_EMAIL = 'candidate-review@local.invalid';
const PRESERVED_MEMBER_EMAILS = new Set([FORMAL_REVIEW_MEMBER.email]);
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

function stableDigest(identity, purpose) {
  return createHash('sha256').update(`${purpose}:${identity}`).digest('hex');
}

function deterministicEmail(identity, purpose = 'member') {
  return `candidate+${stableDigest(identity, purpose).slice(0, 16)}@example.invalid`;
}

function maskedPhone(identity) {
  const suffix = [...stableDigest(identity, 'phone').slice(0, 3)]
    .map(value => Number.parseInt(value, 16) % 10)
    .join('');
  return `09**-***-${suffix}`;
}

function sanitizeNotes(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email masked]')
    .replace(/(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '[phone masked]')
    .replace(/0\d{1,2}[-\s]?\d{6,8}/g, '[phone masked]');
}

function sanitizeAddress(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const normalized = value.trim();
  const match = normalized.match(/((?:臺|台)?[^縣市\s,，]{1,4}[縣市])([^區鄉鎮市\s,，]{1,4}[區鄉鎮市])?/);
  return match ? `${match[1]}${match[2] ?? ''}` : '地址已去敏';
}

function sanitizeRows(table, rows, preservedMemberEmails) {
  return rows.map(row => {
    const sanitized = { ...row };
    if (Object.hasOwn(sanitized, 'notes')) sanitized.notes = sanitizeNotes(sanitized.notes);

    if (table === 'team_members') {
      const normalizedEmail = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
      sanitized.email = preservedMemberEmails.has(normalizedEmail)
        ? row.email
        : deterministicEmail(row.id, 'team-member');
      sanitized.google_calendar_email = row.google_calendar_email
        ? deterministicEmail(row.id, 'google-calendar')
        : row.google_calendar_email;
    }
    if (table === 'contractors' && row.phone) sanitized.phone = maskedPhone(row.id);
    if (table === 'projects') sanitized.address = sanitizeAddress(row.address);
    if (table === 'schedule_tasks') {
      sanitized.address = sanitizeAddress(row.address);
      sanitized.google_maps_url = null;
      sanitized.google_calendar_id = null;
      sanitized.google_event_id = null;
      sanitized.google_sync_error = null;
    }
    if (table === 'work_groups') sanitized.google_calendar_sync_enabled = false;
    return sanitized;
  });
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

function applyCandidateSafetyShape(snapshot, preservedMemberEmails = new Set()) {
  for (const table of BUSINESS_TABLES) {
    snapshot.set(table, sanitizeRows(table, snapshot.get(table) ?? [], preservedMemberEmails));
  }
  return snapshot;
}

async function candidateAuthState() {
  const result = await query(CANDIDATE_REF, `
    select
      count(*) filter (where lower(btrim(email))=${sqlString(FORMAL_REVIEW_MEMBER.email)})::bigint
        as formal_auth_users,
      count(*) filter (where lower(btrim(email))=${sqlString(CANDIDATE_REVIEWER_EMAIL)})::bigint
        as candidate_reviewer_auth_users
    from auth.users
  `);
  return result?.[0] ?? null;
}

function assertIdentityPreflight(snapshot, authState) {
  const member = (snapshot.get('team_members') ?? []).find(row => row.id === FORMAL_REVIEW_MEMBER.id);
  const exactFormalMember = member
    && member.name === FORMAL_REVIEW_MEMBER.name
    && member.email?.trim().toLowerCase() === FORMAL_REVIEW_MEMBER.email
    && member.role?.trim().toLowerCase() === FORMAL_REVIEW_MEMBER.role
    && member.category?.trim().toLowerCase() === FORMAL_REVIEW_MEMBER.category
    && member.is_active === true
    && member.deleted_at == null;
  if (!exactFormalMember) fail('formal review member identity differs from the approved Production identity');
  if (Number(authState?.formal_auth_users ?? 0) !== 1) {
    fail('formal review login is missing or duplicated in Candidate auth.users');
  }
  if (Number(authState?.candidate_reviewer_auth_users ?? 0) !== 1) {
    fail('Candidate Reviewer auth identity differs from the approved preflight state');
  }
}

async function authFingerprint() {
  const result = await query(CANDIDATE_REF, `
    select count(*)::bigint as user_count,
      md5(coalesce(string_agg(id::text || ':' || coalesce(email,''), ',' order by id),'')) as id_email_fingerprint
    from auth.users
  `);
  return result?.[0] ?? null;
}

async function authLinkStatus() {
  const result = await query(CANDIDATE_REF, `
    select
      count(*) filter (where lower(btrim(auth_user.email))=${sqlString(FORMAL_REVIEW_MEMBER.email)})::bigint
        as formal_auth_users,
      count(member.id) filter (where lower(btrim(auth_user.email))=${sqlString(FORMAL_REVIEW_MEMBER.email)})::bigint
        as formal_member_matches,
      count(*) filter (where lower(btrim(auth_user.email))=${sqlString(CANDIDATE_REVIEWER_EMAIL)})::bigint
        as candidate_reviewer_auth_users,
      count(member.id) filter (where lower(btrim(auth_user.email))=${sqlString(CANDIDATE_REVIEWER_EMAIL)})::bigint
        as candidate_reviewer_member_matches
    from auth.users auth_user
    left join public.team_members member
      on lower(btrim(member.email))=lower(btrim(auth_user.email))
     and member.deleted_at is null
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

async function fixtureMarkerCount(projectRef = CANDIDATE_REF) {
  const tables = ['activity_logs', ...BUSINESS_TABLES];
  const counts = await mapWithConcurrency(tables, 4, async table => {
    const result = await query(projectRef, `
      select count(*)::bigint as marker_count
      from public.${quoteIdentifier(table)} row_data
      where to_jsonb(row_data)::text ~*
        '(CANDIDATE_|REVIEW_FIXTURE|Candidate Reviewer|協作測試員|c0000000-0000-4000-8000-)'
    `);
    return Number(result?.[0]?.marker_count ?? 0);
  });
  return counts.reduce((sum, count) => sum + count, 0);
}

async function reviewOpinionCount(projectRef) {
  const result = await query(projectRef, `
    select
      (select count(*)::bigint from public.project_milestones
       where milestone_key='REVIEW_OPINION_RECEIVED')
      +
      (select count(*)::bigint from public.project_workflow_template_steps
       where step_key='REVIEW_OPINION_RECEIVED') as row_count
  `);
  return Number(result?.[0]?.row_count ?? 0);
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
         and pg_get_functiondef(routine.oid) ~* '(net\\.http|http_post|http_get|webhook|https?://)') as external_network_routines,
      (select count(*)::bigint
       from pg_trigger trigger
       join pg_class relation on relation.oid=trigger.tgrelid
       join pg_namespace namespace on namespace.oid=relation.relnamespace
       join pg_proc routine on routine.oid=trigger.tgfoid
       where not trigger.tgisinternal and namespace.nspname='public'
         and (pg_get_triggerdef(trigger.oid) || pg_get_functiondef(routine.oid))
           ~* '(net\\.http|http_post|http_get|webhook|https?://)') as external_mutation_triggers
  `);
  return result?.[0] ?? null;
}

async function loadForeignKeys(projectRef) {
  return query(projectRef, `
    select constraint_def.conname as constraint_name,
      child.relname as child_table,
      parent.relname as parent_table,
      jsonb_agg(child_column.attname order by key_pair.ordinality) as child_columns,
      jsonb_agg(parent_column.attname order by key_pair.ordinality) as parent_columns
    from pg_constraint constraint_def
    join pg_class child on child.oid=constraint_def.conrelid
    join pg_namespace child_namespace on child_namespace.oid=child.relnamespace
    join pg_class parent on parent.oid=constraint_def.confrelid
    join pg_namespace parent_namespace on parent_namespace.oid=parent.relnamespace
    cross join lateral unnest(constraint_def.conkey, constraint_def.confkey)
      with ordinality as key_pair(child_attnum,parent_attnum,ordinality)
    join pg_attribute child_column
      on child_column.attrelid=child.oid and child_column.attnum=key_pair.child_attnum
    join pg_attribute parent_column
      on parent_column.attrelid=parent.oid and parent_column.attnum=key_pair.parent_attnum
    where constraint_def.contype='f'
      and child_namespace.nspname='public'
      and parent_namespace.nspname='public'
      and child.relname in (${tableListSql})
    group by constraint_def.conname, child.relname, parent.relname
    order by child.relname, constraint_def.conname
  `);
}

function assertForeignKeyPreflight(sourceForeignKeys, targetForeignKeys) {
  if (JSON.stringify(sourceForeignKeys) !== JSON.stringify(targetForeignKeys)) {
    fail('Production and Candidate foreign-key graphs differ for the business allowlist');
  }
  const outsideAllowlist = sourceForeignKeys.filter(foreignKey =>
    !BUSINESS_TABLES.includes(foreignKey.child_table)
    || !BUSINESS_TABLES.includes(foreignKey.parent_table)
  );
  if (outsideAllowlist.length) {
    fail(`business foreign-key graph requires ${outsideAllowlist.length} table(s) outside the allowlist`);
  }
}

async function verifyOrphanRelations(projectRef = CANDIDATE_REF) {
  const foreignKeys = await loadForeignKeys(projectRef);
  if (!foreignKeys.length) return [];
  const checks = foreignKeys.map(foreignKey => {
    const joins = foreignKey.child_columns.map((column, index) =>
      `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(foreignKey.parent_columns[index])}`
    ).join(' and ');
    const nonNull = foreignKey.child_columns
      .map(column => `child.${quoteIdentifier(column)} is not null`).join(' and ');
    const missingParent = `parent.${quoteIdentifier(foreignKey.parent_columns[0])} is null`;
    const label = sqlString(`${foreignKey.child_table}.${foreignKey.constraint_name}`);
    return `select ${label} as relation, count(*)::bigint as orphan_count
      from public.${quoteIdentifier(foreignKey.child_table)} child
      left join public.${quoteIdentifier(foreignKey.parent_table)} parent on ${joins}
      where ${nonNull} and ${missingParent}`;
  });
  const result = await query(projectRef, checks.join('\nunion all\n'));
  return result.filter(row => Number(row.orphan_count) > 0);
}

async function verifyData() {
  const [sourceMetadata, targetMetadata, authState, sourceForeignKeys, targetForeignKeys] = await Promise.all([
    loadMetadata(PRODUCTION_REF),
    loadMetadata(CANDIDATE_REF),
    candidateAuthState(),
    loadForeignKeys(PRODUCTION_REF),
    loadForeignKeys(CANDIDATE_REF),
  ]);
  assertMetadataParity(sourceMetadata, targetMetadata);
  assertForeignKeyPreflight(sourceForeignKeys, targetForeignKeys);
  const [source, target, sourceReviewOpinions, targetReviewOpinions] = await Promise.all([
    exportSnapshot(PRODUCTION_REF).then(snapshot => applyCandidateSafetyShape(snapshot, PRESERVED_MEMBER_EMAILS)),
    exportSnapshot(CANDIDATE_REF),
    reviewOpinionCount(PRODUCTION_REF),
    reviewOpinionCount(CANDIDATE_REF),
  ]);
  assertIdentityPreflight(source, authState);
  const comparison = compareSnapshots(source, target);
  const [safety, authLinks, orphanRelations, fixtureMarkers] = await Promise.all([
    verifyCandidateSafety(),
    authLinkStatus(),
    verifyOrphanRelations(),
    fixtureMarkerCount(),
  ]);
  return {
    comparison,
    safety,
    authLinks,
    orphanRelations,
    fixtureMarkers,
    reviewOpinions: { source: sourceReviewOpinions, target: targetReviewOpinions },
  };
}

async function refresh() {
  const [
    sourceMetadata,
    targetMetadata,
    authBefore,
    authState,
    fixtureRowsBefore,
    sourceForeignKeys,
    targetForeignKeys,
    sourceOrphans,
  ] = await Promise.all([
    loadMetadata(PRODUCTION_REF),
    loadMetadata(CANDIDATE_REF),
    authFingerprint(),
    candidateAuthState(),
    fixtureMarkerCount(),
    loadForeignKeys(PRODUCTION_REF),
    loadForeignKeys(CANDIDATE_REF),
    verifyOrphanRelations(PRODUCTION_REF),
  ]);
  assertMetadataParity(sourceMetadata, targetMetadata);
  assertForeignKeyPreflight(sourceForeignKeys, targetForeignKeys);
  if (sourceOrphans.length) fail('Production business snapshot contains orphan foreign-key relations');

  const snapshot = applyCandidateSafetyShape(
    await exportSnapshot(PRODUCTION_REF),
    PRESERVED_MEMBER_EMAILS,
  );
  assertIdentityPreflight(snapshot, authState);
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
  if (verification.fixtureMarkers !== 0) fail(`Candidate fixture markers remain after refresh: ${verification.fixtureMarkers}`);
  if (Number(verification.safety?.active_cron_jobs ?? -1) !== 0) fail('Candidate has active cron jobs');
  if (Number(verification.safety?.google_enabled_work_groups ?? -1) !== 0) fail('Candidate has Google-enabled work groups');
  if (Number(verification.safety?.external_network_routines ?? -1) !== 0) fail('Candidate has an external network database routine');
  if (Number(verification.safety?.external_mutation_triggers ?? -1) !== 0) fail('Candidate has an external mutation trigger');
  if (Number(verification.authLinks?.formal_auth_users ?? 0) !== 1
    || Number(verification.authLinks?.formal_member_matches ?? 0) !== 1) {
    fail('formal review login no longer maps to the approved Production member');
  }
  if (Number(verification.authLinks?.candidate_reviewer_auth_users ?? 0) !== 1
    || Number(verification.authLinks?.candidate_reviewer_member_matches ?? -1) !== 0) {
    fail('Candidate Reviewer auth/business entitlement state is not the approved state');
  }
  if (verification.orphanRelations.length !== 0) fail('Candidate has orphan business relations');
  if (verification.reviewOpinions.source !== verification.reviewOpinions.target) {
    fail('REVIEW_OPINION_RECEIVED canonical workflow rows were not preserved');
  }

  return {
    action: 'refresh',
    sourceProjectRef: PRODUCTION_REF,
    targetProjectRef: CANDIDATE_REF,
    productionReadOnly: true,
    fixturesRemoved: fixtureRowsBefore,
    fixtureMarkersRemaining: verification.fixtureMarkers,
    authUsersCopied: false,
    authUsersUnchanged: true,
    tables: Object.fromEntries(BUSINESS_TABLES.map(table => [table, snapshot.get(table).length])),
    exactDataMatch: true,
    uuidAndForeignKeysPreserved: true,
    deterministicSanitization: true,
    authLinks: verification.authLinks,
    orphanRelations: verification.orphanRelations,
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
