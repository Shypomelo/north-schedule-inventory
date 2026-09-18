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

GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.statement_fails(text) TO authenticated;

DO $fixtures$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'engineer'
  ) THEN
    RAISE EXCEPTION 'Phase A.2 RLS test needs an active engineer';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active AND deleted_at IS NULL AND lower(role) = 'viewer'
  ) THEN
    RAISE EXCEPTION 'Phase A.2 RLS test needs an active viewer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Phase A.2 RLS test needs an active project';
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

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'project_materials'
      AND column_name = 'delivery_destination'
  ),
  'project material delivery destination exists'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'material_receipts'
      AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
  ),
  'receipt history read policy is authenticated and active-member scoped'
);

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.project_material_batches (
  id, project_id, batch_name, ordered_at, planned_receipt_at, created_by
) VALUES (
  '81000000-0000-4000-8000-000000000001',
  current_setting('test.project_id')::uuid,
  '[TEST] Phase A.2 office batch',
  '2026-09-16T01:00:00Z',
  '2026-09-20T06:00:00Z',
  current_setting('test.editor_id')::uuid
);

INSERT INTO public.project_materials (
  id, project_id, batch_id, item_name, quantity, unit,
  procurement_status, delivery_destination, created_by
) VALUES (
  '82000000-0000-4000-8000-000000000001',
  current_setting('test.project_id')::uuid,
  '81000000-0000-4000-8000-000000000001',
  '[TEST] OFFICE 盤體', 10, '台', 'ORDERED', 'OFFICE',
  current_setting('test.editor_id')::uuid
);

INSERT INTO public.se_supply_records (
  id, new_model, quantity, unit, expected_delivery_at,
  requested_by, procurement_status, notes
) VALUES (
  '83000000-0000-4000-8000-000000000001',
  '[TEST] SE P401', 2, '台', '2026-09-21T01:00:00Z',
  current_setting('test.editor_id')::uuid, 'ORDERED', 'rollback-only fixture'
);

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(
    'INSERT INTO public.material_receipts (source_type, project_material_id, quantity_received, received_by) VALUES (''PROJECT_MATERIAL'', ''82000000-0000-4000-8000-000000000001'', 1, ''' || current_setting('test.editor_id') || ''')'
  ),
  'client cannot directly forge append-only receipt rows'
);

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(
    'UPDATE public.se_supply_records SET received_by = ''' || current_setting('test.editor_id') || ''' WHERE id = ''83000000-0000-4000-8000-000000000001'''
  ),
  'client cannot directly forge SE receiver identity'
);

SELECT public.confirm_material_receipt(
  'PROJECT_MATERIAL',
  '82000000-0000-4000-8000-000000000001',
  6,
  '2026-09-20T06:32:00Z',
  'first carton'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'PARTIAL_RECEIVED'
      AND received_at IS NULL
    FROM public.project_materials
    WHERE id = '82000000-0000-4000-8000-000000000001'
  ),
  'first project receipt is partial and keeps the source pending'
);

SELECT pg_temp.assert_true(
  (
    SELECT received_by = current_setting('test.editor_id')::uuid
      AND quantity_received = 6
    FROM public.material_receipts
    WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
  ),
  'receipt identity and quantity are server recorded'
);

SELECT public.confirm_material_receipt(
  'PROJECT_MATERIAL',
  '82000000-0000-4000-8000-000000000001',
  4,
  '2026-09-20T07:00:00Z',
  'remaining carton'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'RECEIVED'
      AND received_at = '2026-09-20T07:00:00Z'::timestamptz
    FROM public.project_materials
    WHERE id = '82000000-0000-4000-8000-000000000001'
  )
  AND (
    SELECT received_at = '2026-09-20T07:00:00Z'::timestamptz
    FROM public.project_material_batches
    WHERE id = '81000000-0000-4000-8000-000000000001'
  ),
  'full project receipt completes both material and batch'
);

SELECT public.reverse_material_receipt(
  (
    SELECT id FROM public.material_receipts
    WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
      AND event_type = 'RECEIVE'
    ORDER BY received_at DESC, id DESC LIMIT 1
  ),
  4,
  '2026-09-20T07:30:00Z',
  'mistaken receipt'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'PARTIAL_RECEIVED' AND received_at IS NULL
    FROM public.project_materials
    WHERE id = '82000000-0000-4000-8000-000000000001'
  )
  AND (
    SELECT received_at IS NULL
    FROM public.project_material_batches
    WHERE id = '81000000-0000-4000-8000-000000000001'
  )
  AND (
    SELECT sum(CASE WHEN event_type = 'REVERSAL' THEN -quantity_received ELSE quantity_received END) = 6
    FROM public.material_receipts
    WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
  ),
  'project reversal returns four units to pending and reopens the batch'
);

SELECT public.reverse_material_receipt(
  (
    SELECT id FROM public.material_receipts
    WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
      AND event_type = 'RECEIVE'
    ORDER BY received_at, id LIMIT 1
  ),
  6,
  '2026-09-20T07:40:00Z',
  'full correction'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'ORDERED' AND received_at IS NULL
    FROM public.project_materials
    WHERE id = '82000000-0000-4000-8000-000000000001'
  )
  AND (
    SELECT sum(CASE WHEN event_type = 'REVERSAL' THEN -quantity_received ELSE quantity_received END) = 0
    FROM public.material_receipts
    WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
  ),
  'full reversal restores the original ordered state without deleting history'
);

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(
    'SELECT public.reverse_material_receipt((SELECT id FROM public.material_receipts WHERE project_material_id = ''82000000-0000-4000-8000-000000000001'' AND event_type = ''RECEIVE'' ORDER BY received_at LIMIT 1), 1, now(), NULL)'
  ),
  'a reversal cannot exceed the original receipt remaining quantity'
);

SELECT public.confirm_material_receipt(
  'SE_SUPPLY',
  '83000000-0000-4000-8000-000000000001',
  1,
  '2026-09-21T02:00:00Z',
  'first SE carton'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'PARTIAL_RECEIVED'
      AND received_at IS NULL
    FROM public.se_supply_records
    WHERE id = '83000000-0000-4000-8000-000000000001'
  ),
  'partial SE receipt remains pending'
);

SELECT public.confirm_material_receipt(
  'SE_SUPPLY',
  '83000000-0000-4000-8000-000000000001',
  1,
  '2026-09-21T03:00:00Z',
  'remaining SE carton'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'RECEIVED'
      AND received_by = current_setting('test.editor_id')::uuid
      AND received_at = '2026-09-21T03:00:00Z'::timestamptz
    FROM public.se_supply_records
    WHERE id = '83000000-0000-4000-8000-000000000001'
  ),
  'full SE receipt synchronizes status, receiver, and time'
);

SELECT public.reverse_material_receipt(
  (
    SELECT id FROM public.material_receipts
    WHERE se_supply_record_id = '83000000-0000-4000-8000-000000000001'
      AND event_type = 'RECEIVE'
    ORDER BY received_at DESC, id DESC LIMIT 1
  ),
  1,
  '2026-09-21T03:30:00Z',
  'SE correction'
);

SELECT pg_temp.assert_true(
  (
    SELECT procurement_status = 'PARTIAL_RECEIVED'
      AND received_at IS NULL
      AND received_by IS NULL
    FROM public.se_supply_records
    WHERE id = '83000000-0000-4000-8000-000000000001'
  ),
  'SE reversal uses the same correction semantics'
);

UPDATE public.project_materials
SET receiving_archived_at = '2026-09-17T00:00:00Z'
WHERE id = '82000000-0000-4000-8000-000000000001';

UPDATE public.se_supply_records
SET receiving_archived_at = '2026-09-17T00:00:00Z'
WHERE id = '83000000-0000-4000-8000-000000000001';

SELECT pg_temp.assert_true(
  (
    SELECT receiving_archived_at = '2026-09-17T00:00:00Z'::timestamptz
      AND procurement_status = 'ORDERED'
    FROM public.project_materials
    WHERE id = '82000000-0000-4000-8000-000000000001'
  )
  AND (
    SELECT receiving_archived_at = '2026-09-17T00:00:00Z'::timestamptz
      AND procurement_status = 'PARTIAL_RECEIVED'
    FROM public.se_supply_records
    WHERE id = '83000000-0000-4000-8000-000000000001'
  )
  AND (
    SELECT count(*) = 7
    FROM public.material_receipts
    WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
       OR se_supply_record_id = '83000000-0000-4000-8000-000000000001'
  ),
  'editor archive hides only the receiving projection and preserves source state and history'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.viewer_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 7 FROM public.material_receipts
   WHERE project_material_id = '82000000-0000-4000-8000-000000000001'
      OR se_supply_record_id = '83000000-0000-4000-8000-000000000001'),
  'active viewer can read append-only receipt history'
);

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(
    'SELECT public.confirm_material_receipt(''SE_SUPPLY'', ''83000000-0000-4000-8000-000000000001'', 1, now(), NULL)'
  ),
  'viewer cannot confirm a receipt'
);

SELECT pg_temp.assert_true(
  pg_temp.statement_fails(
    'SELECT public.reverse_material_receipt((SELECT id FROM public.material_receipts WHERE event_type = ''RECEIVE'' LIMIT 1), 1, now(), NULL)'
  ),
  'viewer cannot correct a receipt'
);

UPDATE public.se_supply_records
SET receiving_archived_at = now()
WHERE id = '83000000-0000-4000-8000-000000000001';

SELECT pg_temp.assert_true(
  (
    SELECT receiving_archived_at = '2026-09-17T00:00:00Z'::timestamptz
    FROM public.se_supply_records
    WHERE id = '83000000-0000-4000-8000-000000000001'
  ),
  'viewer update is filtered by RLS and cannot archive a receiving source'
);

ROLLBACK;
