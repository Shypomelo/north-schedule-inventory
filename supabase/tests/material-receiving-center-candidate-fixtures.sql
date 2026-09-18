-- Candidate-only manual UI fixtures. Deterministic IDs make cleanup exact.
DO $fixtures$
DECLARE
  v_editor_id uuid;
  v_project_id uuid;
BEGIN
  SELECT id INTO v_editor_id
  FROM public.team_members
  WHERE is_active AND deleted_at IS NULL AND lower(role) IN ('admin', 'engineer')
  ORDER BY CASE WHEN lower(role) = 'engineer' THEN 0 ELSE 1 END, id
  LIMIT 1;

  SELECT id INTO v_project_id
  FROM public.projects
  WHERE deleted_at IS NULL
    AND project_name = '天泰智慧-日鑫電纜(二)'
  ORDER BY id
  LIMIT 1;

  IF v_editor_id IS NULL OR v_project_id IS NULL THEN
    RAISE EXCEPTION 'Candidate fixtures need one active editor and one active project';
  END IF;

  INSERT INTO public.project_material_batches (
    id, project_id, batch_name, ordered_at, planned_receipt_at, notes, created_by
  ) VALUES (
    '84000000-0000-4000-8000-000000000001',
    v_project_id,
    '[TEST] Phase A.2 北辦到貨',
    now(),
    date_trunc('hour', now()) + interval '2 days',
    '[TEST] Phase A.2 deterministic fixture',
    v_editor_id
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.project_materials (
    id, project_id, batch_id, item_name, specification, quantity, unit,
    procurement_status, expected_delivery_at, reminder_enabled,
    reminder_days_before, delivery_destination, notes, created_by
  ) VALUES (
    '84000000-0000-4000-8000-000000000002',
    v_project_id,
    '84000000-0000-4000-8000-000000000001',
    '[TEST] 北辦盤體',
    'OFFICE-DEMO',
    10,
    '台',
    'ORDERED',
    date_trunc('hour', now()) + interval '2 days',
    true,
    7,
    'OFFICE',
    '[TEST] should appear in receiving center',
    v_editor_id
  ), (
    '84000000-0000-4000-8000-000000000003',
    v_project_id,
    '84000000-0000-4000-8000-000000000001',
    '[TEST] 直送案場 XLPE',
    'SITE-EXCLUDED',
    100,
    '米',
    'ORDERED',
    date_trunc('hour', now()) + interval '2 days',
    true,
    7,
    'SITE',
    '[TEST] must not appear in receiving center',
    v_editor_id
  ), (
    '84000000-0000-4000-8000-000000000005',
    v_project_id,
    '84000000-0000-4000-8000-000000000001',
    '[TEST] 北辦其他日期',
    'OFFICE-SIBLING',
    1,
    '台',
    'ORDERED',
    date_trunc('hour', now()) + interval '4 days',
    true,
    7,
    'OFFICE',
    '[TEST] same project, different receiving group',
    v_editor_id
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.se_supply_records (
    id, new_model, quantity, unit, expected_delivery_at, requested_by,
    procurement_status, receive_method, notes
  ) VALUES (
    '84000000-0000-4000-8000-000000000004',
    '[TEST] SE P401',
    2,
    '台',
    date_trunc('hour', now()) + interval '3 days',
    v_editor_id,
    'ORDERED',
    'SE 寄件到北辦',
    '[TEST] Phase A.2 deterministic fixture'
  ), (
    '84000000-0000-4000-8000-000000000006',
    '[TEST] SE 其他日期',
    1,
    '台',
    date_trunc('hour', now()) + interval '5 days',
    v_editor_id,
    'ORDERED',
    'SE 寄件到北辦',
    '[TEST] same requester, different receiving group'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.material_receipts (
    id, source_type, project_material_id, se_supply_record_id,
    event_type, quantity_received, received_by, received_at, notes
  ) VALUES (
    '84000000-0000-4000-8000-000000000007',
    'PROJECT_MATERIAL',
    '84000000-0000-4000-8000-000000000002',
    NULL,
    'RECEIVE',
    10,
    v_editor_id,
    date_trunc('hour', now()) - interval '2 hours',
    '[TEST] received project archive fixture'
  ), (
    '84000000-0000-4000-8000-000000000008',
    'SE_SUPPLY',
    NULL,
    '84000000-0000-4000-8000-000000000004',
    'RECEIVE',
    2,
    v_editor_id,
    date_trunc('hour', now()) - interval '1 hour',
    '[TEST] received SE archive fixture'
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.project_materials
  SET procurement_status = 'RECEIVED',
      received_at = date_trunc('hour', now()) - interval '2 hours'
  WHERE id = '84000000-0000-4000-8000-000000000002';

  UPDATE public.se_supply_records
  SET procurement_status = 'RECEIVED',
      received_at = date_trunc('hour', now()) - interval '1 hour',
      received_by = v_editor_id
  WHERE id = '84000000-0000-4000-8000-000000000004';
END;
$fixtures$;
