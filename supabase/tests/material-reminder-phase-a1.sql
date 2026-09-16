-- Run only against a safe migrated Candidate/development database as postgres.
-- All fixtures and writes roll back.
BEGIN;
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION pg_temp.assert_true(value boolean, label text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
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

GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.statement_fails(text) TO authenticated;

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_material_batches'
      AND column_name = 'planned_receipt_at' AND data_type = 'timestamp with time zone'
  ),
  'batch planned receipt timestamp exists'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_material_batches'
      AND column_name = 'received_at' AND data_type = 'timestamp with time zone'
  ),
  'batch receipt completion timestamp exists'
);

SELECT set_config('test.editor_id', id::text, true), set_config('test.editor_email', email, true)
FROM public.team_members
WHERE is_active AND deleted_at IS NULL AND lower(role) = 'engineer'
ORDER BY id LIMIT 1;

SELECT set_config('test.viewer_email', email, true)
FROM public.team_members
WHERE is_active AND deleted_at IS NULL AND lower(role) = 'viewer'
ORDER BY id LIMIT 1;

SELECT set_config('test.project_id', id::text, true)
FROM public.projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1;

SELECT set_config('test.work_group_id', id::text, true)
FROM public.work_groups WHERE is_active ORDER BY id LIMIT 1;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.project_material_batches (
  id, project_id, batch_name, planned_receipt_at, created_by
) VALUES (
  '73700000-0000-4000-8000-000000000001', current_setting('test.project_id')::uuid,
  'TEST Phase A.1 receipt plan', '2026-09-20 14:00:00+08', current_setting('test.editor_id')::uuid
);

INSERT INTO public.project_materials (
  id, project_id, batch_id, item_name, quantity, unit, procurement_status,
  expected_delivery_at, reminder_enabled, reminder_days_before, created_by
) VALUES
  ('73800000-0000-4000-8000-000000000001', current_setting('test.project_id')::uuid,
   '73700000-0000-4000-8000-000000000001', 'TEST A', 1, '式', 'ORDERED',
   '2026-09-20 14:00:00+08', true, 7, current_setting('test.editor_id')::uuid),
  ('73800000-0000-4000-8000-000000000002', current_setting('test.project_id')::uuid,
   '73700000-0000-4000-8000-000000000001', 'TEST B', 1, '式', 'PARTIAL_RECEIVED',
   '2026-09-20 14:00:00+08', true, 7, current_setting('test.editor_id')::uuid);

INSERT INTO public.schedule_tasks (
  id, work_group_id, title, task_type, task_date, start_time, status,
  project_id, project_name, primary_member_id, source_material_batch_id
) VALUES (
  '73900000-0000-4000-8000-000000000001', current_setting('test.work_group_id')::uuid,
  '收料', '收料', '2026-09-20', '14:00', '', current_setting('test.project_id'),
  'TEST Phase A.1 project', current_setting('test.editor_id'),
  '73700000-0000-4000-8000-000000000001'
);

SELECT public.update_material_receipt_plan(
  '73700000-0000-4000-8000-000000000001', '2026-09-22 10:00:00+08'
);

SELECT pg_temp.assert_true(
  (SELECT planned_receipt_at = '2026-09-22 10:00:00+08' FROM public.project_material_batches
   WHERE id = '73700000-0000-4000-8000-000000000001')
  AND (SELECT bool_and(expected_delivery_at = '2026-09-22 10:00:00+08') FROM public.project_materials
       WHERE batch_id = '73700000-0000-4000-8000-000000000001')
  AND (SELECT task_date = '2026-09-22' AND start_time = '10:00' FROM public.schedule_tasks
       WHERE id = '73900000-0000-4000-8000-000000000001'),
  'canonical plan atomically updates batch, pending materials, and receipt schedule'
);

SELECT public.complete_material_receipt_schedule(
  '73900000-0000-4000-8000-000000000001', '2026-09-22 10:30:00+08'
);

SELECT pg_temp.assert_true(
  (SELECT status = '完成' FROM public.schedule_tasks
   WHERE id = '73900000-0000-4000-8000-000000000001')
  AND (SELECT received_at = '2026-09-22 10:30:00+08' FROM public.project_material_batches
       WHERE id = '73700000-0000-4000-8000-000000000001')
  AND (SELECT bool_and(procurement_status = 'RECEIVED' AND received_at = '2026-09-22 10:30:00+08')
       FROM public.project_materials
       WHERE batch_id = '73700000-0000-4000-8000-000000000001'),
  'completing the receipt schedule completes the inbound batch and every material'
);

RESET ROLE;

INSERT INTO public.project_material_batches (
  id, project_id, batch_name, planned_receipt_at, created_by
) VALUES (
  '73700000-0000-4000-8000-000000000002', current_setting('test.project_id')::uuid,
  'TEST Phase A.1 viewer guard', '2026-09-25 09:00:00+08', current_setting('test.editor_id')::uuid
);

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.viewer_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(
    $$SELECT public.update_material_receipt_plan(
      '73700000-0000-4000-8000-000000000002', '2026-09-26 09:00:00+08'
    )$$
  ),
  'viewer cannot change a material receipt plan through the invoker RPC'
);

ROLLBACK;
