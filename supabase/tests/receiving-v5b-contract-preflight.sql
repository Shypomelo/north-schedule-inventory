-- Candidate-only contract probe for V5-B. No schema changes and no committed fixtures.
-- PASS means the documented UI blockers were reproduced, not that V5-B is complete.
BEGIN;
SET LOCAL statement_timeout = '45s';
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  table_name text;
  snapshot jsonb;
  before_state jsonb := '{}';
  after_state jsonb := '{}';
  tables text[] := ARRAY[
    'public.inventory_items', 'public.inventory_transactions', 'public.inventory_serials',
    'public.material_receipts', 'public.material_receipt_serials', 'public.se_supply_records',
    'public.project_materials', 'public.project_material_batches', 'public.activity_logs',
    'public.receiving_arrivals', 'public.receiving_arrival_lines',
    'public.receiving_arrival_matches', 'public.receiving_arrival_match_serials',
    'public.receiving_serial_entries', 'app_private.receiving_requests'
  ];
  item_id uuid := gen_random_uuid();
  batch_id uuid := gen_random_uuid();
  material_id uuid := gen_random_uuid();
  project_id uuid;
  actor_id uuid;
  actor_email text;
  source_type text;
  source_id uuid;
  arrival jsonb;
  line_id uuid;
  fulfilment jsonb;
  rejected boolean;
  hide_only boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM review_private.environment_guard
    WHERE project_ref = 'fssogssryeunkjkdgewx' AND purpose = 'CANDIDATE_REVIEW'
  ) THEN RAISE EXCEPTION 'CANDIDATE ONLY'; END IF;

  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('SELECT jsonb_build_object(''count'', count(*), ''hash'', md5(COALESCE(string_agg(row_data, E''\n'' ORDER BY row_data), ''''))) FROM (SELECT to_jsonb(t)::text row_data FROM %s t) rows', table_name)
      INTO snapshot;
    before_state := before_state || jsonb_build_object(table_name, snapshot);
  END LOOP;

  -- The deliberately raised exception rolls back this entire fixture subtransaction.
  BEGIN
    SELECT id, email INTO STRICT actor_id, actor_email FROM public.team_members
      WHERE role = 'admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1;
    SELECT id INTO STRICT project_id FROM public.projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
    PERFORM set_config('request.jwt.claims', jsonb_build_object('email', actor_email, 'role', 'authenticated')::text, true);
    INSERT INTO public.inventory_items(id, code, name, unit, category, requires_serial)
      VALUES(item_id, '[TEST V5B PREFLIGHT]', '[TEST V5B PREFLIGHT]', '個', '一般', false);
    INSERT INTO public.project_material_batches(id, project_id, batch_name, created_by)
      VALUES(batch_id, project_id, '[TEST V5B PREFLIGHT]', actor_id);
    INSERT INTO public.project_materials(id, project_id, item_name, quantity, unit, created_by, inventory_item_id, delivery_destination, batch_id)
      VALUES(material_id, project_id, '[TEST V5B PREFLIGHT]', 20, '個', actor_id, item_id, 'OFFICE', batch_id);

    SET LOCAL ROLE authenticated;
    FOREACH source_type IN ARRAY ARRAY['SE_SUPPLY', 'PROJECT_MATERIAL'] LOOP
      IF source_type = 'SE_SUPPLY' THEN
        source_id := (public.create_office_equipment_arrival(gen_random_uuid(), item_id, 20, now(), NULL, '[TEST V5B PREFLIGHT]', '[]')->>'id')::uuid;
      ELSE source_id := material_id;
      END IF;
      arrival := public.create_receiving_arrival(gen_random_uuid(), now(),
        jsonb_build_array(jsonb_build_object('inventory_item_id', item_id, 'quantity', 8)),
        NULL, '[TEST V5B PREFLIGHT]', '2099-03-15');
      line_id := (arrival->'lines'->0->>'id')::uuid;
      PERFORM public.match_receiving_arrival_line(gen_random_uuid(), line_id, 8,
        CASE WHEN source_type = 'PROJECT_MATERIAL' THEN source_id END,
        CASE WHEN source_type = 'SE_SUPPLY' THEN source_id END);
      fulfilment := public.get_receiving_pending_fulfilment(
        CASE WHEN source_type = 'PROJECT_MATERIAL' THEN source_id END,
        CASE WHEN source_type = 'SE_SUPPLY' THEN source_id END);
      IF fulfilment <> '{"quantity":20,"fulfilled":8,"remaining":12}'::jsonb THEN
        RAISE EXCEPTION 'Unexpected first fulfilment: %', fulfilment;
      END IF;

      FOREACH hide_only IN ARRAY ARRAY[false, true] LOOP
        rejected := false;
        BEGIN
          PERFORM public.cancel_receiving_arrival(gen_random_uuid(), source_type, source_id,
            '[TEST V5B PREFLIGHT] cancel only the remaining 12', hide_only);
        EXCEPTION WHEN SQLSTATE 'PT409' THEN
          IF SQLERRM <> 'MATCHED_PENDING_CORRECTION_REQUIRED' THEN RAISE; END IF;
          rejected := true;
        END;
        IF NOT rejected THEN RAISE EXCEPTION 'Expected cancellation blocker for %, hide=%', source_type, hide_only; END IF;
      END LOOP;

      -- A matched arrival cannot have its optional project filled in afterward either.
      rejected := false;
      BEGIN
        PERFORM public.update_receiving_arrival_metadata(gen_random_uuid(),
          (arrival->'arrival'->>'id')::uuid,
          (SELECT version FROM public.receiving_arrivals WHERE id = (arrival->'arrival'->>'id')::uuid),
          project_id, '[TEST V5B PREFLIGHT] add optional project');
      EXCEPTION WHEN SQLSTATE 'PT409' THEN
        IF SQLERRM <> 'MATCHED_ARRIVAL_PROJECT_CORRECTION_REQUIRED' THEN RAISE; END IF;
        rejected := true;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'Expected matched metadata blocker'; END IF;

      arrival := public.create_receiving_arrival(gen_random_uuid(), now(),
        jsonb_build_array(jsonb_build_object('inventory_item_id', item_id, 'quantity', 5)),
        NULL, '[TEST V5B PREFLIGHT]', '2099-03-15');
      PERFORM public.match_receiving_arrival_line(gen_random_uuid(), (arrival->'lines'->0->>'id')::uuid, 5,
        CASE WHEN source_type = 'PROJECT_MATERIAL' THEN source_id END,
        CASE WHEN source_type = 'SE_SUPPLY' THEN source_id END);
      fulfilment := public.get_receiving_pending_fulfilment(
        CASE WHEN source_type = 'PROJECT_MATERIAL' THEN source_id END,
        CASE WHEN source_type = 'SE_SUPPLY' THEN source_id END);
      IF fulfilment <> '{"quantity":20,"fulfilled":13,"remaining":7}'::jsonb THEN
        RAISE EXCEPTION 'Unexpected second fulfilment: %', fulfilment;
      END IF;
      IF (SELECT count(DISTINCT arrival_line_id) FROM public.receiving_arrival_matches
        WHERE project_material_id = source_id OR se_supply_record_id = source_id) <> 2 THEN
        RAISE EXCEPTION 'Expected two distinct arrival lines';
      END IF;
    END LOOP;
    RESET ROLE;
    RAISE EXCEPTION 'Rollback V5-B preflight fixtures' USING ERRCODE = 'ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;

  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('SELECT jsonb_build_object(''count'', count(*), ''hash'', md5(COALESCE(string_agg(row_data, E''\n'' ORDER BY row_data), ''''))) FROM (SELECT to_jsonb(t)::text row_data FROM %s t) rows', table_name)
      INTO snapshot;
    after_state := after_state || jsonb_build_object(table_name, snapshot);
  END LOOP;
  IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Fixture rollback mismatch'; END IF;
END $$;
ROLLBACK;
SELECT 'BLOCKERS REPRODUCED: SE and OFFICE project Pending 20 -> 8/20; cancel/hide rejected; matched optional project edit rejected; second arrival gives 13/20 with two identities. All 15 table counts and content hashes unchanged after fixture rollback.' AS result;
