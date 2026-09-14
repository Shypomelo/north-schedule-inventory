-- Run against a safe migrated Candidate/development database as postgres.
-- All fixtures and writes roll back.
-- supabase db query --linked --file supabase/tests/material-reminder-phase-1.sql
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'admin'
  ) THEN
    RAISE EXCEPTION 'Material RLS test needs an active admin';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'engineer'
  ) THEN
    RAISE EXCEPTION 'Material RLS test needs an active engineer';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'viewer'
  ) THEN
    RAISE EXCEPTION 'Material RLS test needs an active viewer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects) THEN
    RAISE EXCEPTION 'Material RLS test needs an existing project';
  END IF;
END;
$test$;

SELECT set_config('test.admin_id', id::text, true),
       set_config('test.admin_email', email, true)
FROM public.team_members
WHERE is_active AND deleted_at IS NULL AND lower(role) = 'admin'
ORDER BY id LIMIT 1;

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
ORDER BY id LIMIT 1;

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

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.admin_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.material_groups (
  id, name, sort_order, created_by
) VALUES (
  '70000000-0000-4000-8000-000000000001', 'Material RLS group', 9999,
  current_setting('test.admin_id')::uuid
);

INSERT INTO public.material_catalog_items (
  id, group_id, name, default_specification, default_unit,
  default_reminder_enabled, default_reminder_days_before,
  sort_order, created_by
) VALUES (
  '71000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001', 'Material RLS fixture', 'V1', '台',
  true, 21, 9999, current_setting('test.admin_id')::uuid
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM public.material_catalog_items
    WHERE id = '71000000-0000-4000-8000-000000000001'
      AND group_id = '70000000-0000-4000-8000-000000000001'
      AND group_name = 'Material RLS group'
  ),
  'admin creates catalog item and canonical group syncs legacy name'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.material_catalog_items WHERE id = '71000000-0000-4000-8000-000000000001'),
  'active editor reads material catalog'
);
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.material_groups WHERE id = '70000000-0000-4000-8000-000000000001'),
  'active editor reads material groups'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.material_groups (name, created_by) VALUES (''Denied group'', %L)',
  current_setting('test.editor_id')
)), 'non-admin cannot create material groups');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.material_catalog_items (name, default_unit, created_by) VALUES (''Denied catalog'', ''式'', %L)',
  current_setting('test.editor_id')
)), 'non-admin cannot create material catalog');

INSERT INTO public.project_material_batches (
  id, project_id, batch_name, created_by
) VALUES (
  '70500000-0000-4000-8000-000000000001',
  current_setting('test.project_id')::uuid, 'Material RLS batch',
  current_setting('test.editor_id')::uuid
);

INSERT INTO public.project_materials (
  id, project_id, batch_id, catalog_item_id, item_name, specification, quantity, unit,
  procurement_status, reminder_enabled, reminder_days_before, created_by
) VALUES (
  '72000000-0000-4000-8000-000000000001',
  current_setting('test.project_id')::uuid,
  '70500000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  'Material RLS fixture', 'V1', 2, '台', 'NOT_ORDERED', true, 21,
  current_setting('test.editor_id')::uuid
);

SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.project_materials (project_id, batch_id, item_name, quantity, unit, created_by) VALUES (%L, %L, ''Spoof'', 1, ''式'', %L)',
  current_setting('test.project_id'), '70500000-0000-4000-8000-000000000001', current_setting('test.admin_id')
)), 'project material created_by cannot spoof another member');

SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.project_materials (project_id, batch_id, item_name, quantity, unit, procurement_status, created_by) VALUES (%L, %L, ''Bad status'', 1, ''式'', ''INVALID'', %L)',
  current_setting('test.project_id'), '70500000-0000-4000-8000-000000000001', current_setting('test.editor_id')
)), 'project material rejects an invalid procurement status');

UPDATE public.project_materials
SET procurement_status = 'ORDERED', expected_delivery_on = current_date + 14
WHERE id = '72000000-0000-4000-8000-000000000001';

SELECT pg_temp.assert_true(
  (SELECT procurement_status = 'ORDERED' AND expected_delivery_on = current_date + 14
   FROM public.project_materials WHERE id = '72000000-0000-4000-8000-000000000001'),
  'editor updates project material status and delivery date'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.admin_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

UPDATE public.material_groups
SET name = 'Material RLS group renamed'
WHERE id = '70000000-0000-4000-8000-000000000001';

SELECT pg_temp.assert_true(
  (SELECT group_name = 'Material RLS group renamed'
   FROM public.material_catalog_items WHERE id = '71000000-0000-4000-8000-000000000001'),
  'group rename cascades only the legacy compatibility name'
);

UPDATE public.material_catalog_items
SET default_specification = 'V2', default_reminder_days_before = 30
WHERE id = '71000000-0000-4000-8000-000000000001';

SELECT pg_temp.assert_true(
  (SELECT specification = 'V1' AND reminder_days_before = 21
   FROM public.project_materials WHERE id = '72000000-0000-4000-8000-000000000001'),
  'catalog changes do not rewrite project material snapshots'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.viewer_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.project_materials WHERE id = '72000000-0000-4000-8000-000000000001'),
  'active viewer reads project materials'
);
SELECT pg_temp.assert_true(
  pg_temp.affected_rows(
    'UPDATE public.material_groups SET name = ''denied'' WHERE id = ''70000000-0000-4000-8000-000000000001'''
  ) = 0,
  'viewer cannot update material groups'
);
SELECT pg_temp.assert_true(
  pg_temp.affected_rows(
    'UPDATE public.project_materials SET notes = ''denied'' WHERE id = ''72000000-0000-4000-8000-000000000001'''
  ) = 0,
  'viewer cannot update project materials'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.project_materials (project_id, batch_id, item_name, quantity, unit, created_by) VALUES (%L, %L, ''Denied'', 1, ''式'', %L)',
  current_setting('test.project_id'), '70500000-0000-4000-8000-000000000001', current_setting('test.editor_id')
)), 'viewer cannot create project materials');

ROLLBACK;
