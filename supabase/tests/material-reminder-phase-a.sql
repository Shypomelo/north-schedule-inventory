-- Run only against a safe migrated Candidate/development database as postgres.
-- All fixtures and writes roll back.
BEGIN;
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION pg_temp.assert_true(value boolean, label text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RAISE NOTICE 'PASS: %', label;
END;
$function$;

CREATE FUNCTION pg_temp.statement_fails(statement text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $function$
BEGIN
  EXECUTE statement;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END;
$function$;

CREATE FUNCTION pg_temp.affected_rows(statement text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $function$
DECLARE affected integer;
BEGIN
  EXECUTE statement;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.statement_fails(text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.affected_rows(text) TO authenticated;

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'schedule_tasks'
      AND column_name = 'source_material_batch_id'
      AND data_type = 'uuid'
      AND is_nullable = 'YES'
  ),
  'schedule relation is a nullable uuid'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM public.schedule_task_types
    WHERE lower(btrim(replace(name, chr(12288), ' '))) = lower('收料')
      AND is_active
  ),
  'canonical receiving task type exists and is active'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_class AS index_relation
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_index AS index_metadata
      ON index_metadata.indexrelid = index_relation.oid
    JOIN pg_class AS table_relation
      ON table_relation.oid = index_metadata.indrelid
    WHERE index_namespace.nspname = 'public'
      AND table_relation.relname = 'schedule_tasks'
      AND index_relation.relname = 'schedule_tasks_active_material_receipt_group_unique_idx'
      AND index_metadata.indisunique
      AND pg_get_indexdef(index_relation.oid)
        ILIKE '%(source_material_batch_id, source_material_receipt_at)%'
      AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        ILIKE '%source_material_batch_id IS NOT NULL%'
      AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        ILIKE '%source_material_receipt_at IS NOT NULL%'
      AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        ILIKE '%status IS DISTINCT FROM%取消%'
      AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        ILIKE '%status IS DISTINCT FROM%完成%'
      AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        ILIKE '%deleted_at IS NULL%'
  ),
  'active material receipt-time group schedule relation is unique'
);

DO $fixtures$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'engineer'
  ) THEN
    RAISE EXCEPTION 'Phase A RLS test needs an active engineer';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'viewer'
  ) THEN
    RAISE EXCEPTION 'Phase A RLS test needs an active viewer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Phase A RLS test needs an active project';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_groups WHERE is_active) THEN
    RAISE EXCEPTION 'Phase A RLS test needs an active work group';
  END IF;
END;
$fixtures$;

SELECT set_config('test.editor_id', id::text, true),
       set_config('test.editor_email', email, true)
FROM public.team_members
WHERE is_active AND deleted_at IS NULL AND lower(role) = 'engineer'
ORDER BY id LIMIT 1;

SELECT set_config('test.viewer_email', email, true)
FROM public.team_members
WHERE is_active AND deleted_at IS NULL AND lower(role) = 'viewer'
ORDER BY id LIMIT 1;

SELECT set_config('test.project_id', id::text, true)
FROM public.projects
WHERE deleted_at IS NULL
ORDER BY id LIMIT 1;

SELECT set_config('test.work_group_id', id::text, true)
FROM public.work_groups
WHERE is_active
ORDER BY id LIMIT 1;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.project_material_batches (
  id, project_id, batch_name, notes, created_by
) VALUES (
  '73500000-0000-4000-8000-000000000001',
  current_setting('test.project_id')::uuid,
  'TEST Phase A relation batch',
  'TEST rollback-only fixture',
  current_setting('test.editor_id')::uuid
);

INSERT INTO public.schedule_tasks (
  id, work_group_id, title, task_type, task_date, status,
  project_id, project_name, primary_member_id, source_material_batch_id,
  source_material_receipt_at
) VALUES (
  '73600000-0000-4000-8000-000000000001',
  current_setting('test.work_group_id')::uuid,
  '收料', '收料', current_date, '',
  current_setting('test.project_id'), 'TEST Phase A project',
  current_setting('test.editor_id'),
  '73500000-0000-4000-8000-000000000001',
  '2099-01-15 01:00:00+00'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM public.schedule_tasks
    WHERE id = '73600000-0000-4000-8000-000000000001'
      AND source_material_batch_id = '73500000-0000-4000-8000-000000000001'
      AND source_material_receipt_at = '2099-01-15 01:00:00+00'
  ),
  'editor creates a receiving schedule through existing schedule RLS'
);

SELECT pg_temp.assert_true(
  NOT pg_temp.statement_fails(format(
    'INSERT INTO public.schedule_tasks (work_group_id, title, task_type, task_date, status, source_material_batch_id, source_material_receipt_at) VALUES (%L, ''收料'', ''收料'', current_date, '''', %L, %L::timestamptz)',
    current_setting('test.work_group_id'),
    '73500000-0000-4000-8000-000000000001',
    '2099-01-15 02:00:00+00'
  )),
  'the same batch can have active schedules for different receipt-time groups'
);

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(format(
    'INSERT INTO public.schedule_tasks (work_group_id, title, task_type, task_date, status, source_material_batch_id, source_material_receipt_at) VALUES (%L, ''收料'', ''收料'', current_date, '''', %L, %L::timestamptz)',
    current_setting('test.work_group_id'),
    '73500000-0000-4000-8000-000000000001',
    '2099-01-15 01:00:00+00'
  )),
  'duplicate active schedules for the same receipt-time group are rejected'
);

UPDATE public.schedule_tasks
SET status = '取消'
WHERE id = '73600000-0000-4000-8000-000000000001';

SELECT pg_temp.assert_true(
  NOT pg_temp.statement_fails(format(
    'INSERT INTO public.schedule_tasks (work_group_id, title, task_type, task_date, status, source_material_batch_id, source_material_receipt_at) VALUES (%L, ''收料'', ''收料'', current_date, '''', %L, %L::timestamptz)',
    current_setting('test.work_group_id'),
    '73500000-0000-4000-8000-000000000001',
    '2099-01-15 01:00:00+00'
  )),
  'a cancelled receipt-time group schedule can be deliberately recreated'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.viewer_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(format(
    'INSERT INTO public.schedule_tasks (work_group_id, title, task_type, task_date, status, source_material_batch_id, source_material_receipt_at) VALUES (%L, ''Denied'', ''收料'', current_date, '''', %L, %L::timestamptz)',
    current_setting('test.work_group_id'),
    '73500000-0000-4000-8000-000000000001',
    '2099-01-15 03:00:00+00'
  )),
  'viewer cannot create a receiving schedule'
);

ROLLBACK;
