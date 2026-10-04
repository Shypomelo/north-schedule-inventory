-- Candidate-only UX contract fixture; every write is rolled back.
BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard
  WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW')
 THEN RAISE EXCEPTION 'CANDIDATE_ONLY'; END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',
  (SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),
  'role','authenticated')::text,true);
END $$;
DO $$
DECLARE actor uuid; fixture_project_id uuid:=gen_random_uuid(); plain_id uuid:=gen_random_uuid();
 serial_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid(); result jsonb; batches jsonb;
 first_arrival uuid; second_arrival uuid; first_line uuid; second_line uuid; third_line uuid;
 before_count integer; before_inventory integer;
BEGIN
 SELECT id INTO actor FROM public.team_members WHERE email=current_setting('request.jwt.claims')::jsonb->>'email';
 IF actor IS NULL THEN RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED'; END IF;
 INSERT INTO public.projects(id,project_name) VALUES(fixture_project_id,'[RECEIVING UX BATCH TEST]');
 INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment,canonical_identity_key)
 VALUES(plain_id,'UX-BATCH-PLAIN','[TEST] plain','pcs','General',false,false,'UX_BATCH_PLAIN_'||plain_id::text),
 (other_id,'UX-BATCH-OTHER','[TEST] other','pcs','General',false,false,'UX_BATCH_OTHER_'||other_id::text),
 (serial_id,'UX-BATCH-SERIAL','[TEST] serial','pcs','General',true,true,'UX_BATCH_SERIAL_'||serial_id::text);
 SELECT count(*) INTO before_inventory FROM public.inventory_transactions
  WHERE item_id IN (plain_id,other_id,serial_id);

 result:=public.create_receiving_pending_batch(gen_random_uuid(),fixture_project_id,'[RECEIVING UX BATCH TEST]',
  jsonb_build_array(
   jsonb_build_object('item_id',plain_id,'quantity',3,'expected_at','2026-10-03T00:00:00+08:00','serials','[]'::jsonb),
   jsonb_build_object('item_id',other_id,'quantity',5,'expected_at','2026-10-04T00:00:00+08:00','serials','[]'::jsonb),
   jsonb_build_object('item_id',serial_id,'quantity',2,'expected_at','2026-10-06T00:00:00+08:00',
    'serials',jsonb_build_array('UXBP0001-AA'))));
 IF jsonb_array_length(result)<>3
  OR (SELECT count(*) FROM public.se_supply_records WHERE project_id=fixture_project_id AND receiving_only)<>3
  OR (SELECT count(*) FROM public.receiving_serial_entries WHERE se_supply_record_id=(result->2->>'id')::uuid)<>1
  OR (SELECT count(*) FROM public.inventory_transactions WHERE item_id IN (plain_id,other_id,serial_id))<>before_inventory
 THEN RAISE EXCEPTION 'PENDING_BATCH_CREATE_FAILED'; END IF;
 SELECT count(*) INTO before_count FROM public.se_supply_records WHERE project_id=fixture_project_id;
 BEGIN
  PERFORM public.create_receiving_pending_batch(gen_random_uuid(),fixture_project_id,NULL,
   jsonb_build_array(jsonb_build_object('item_id',plain_id,'quantity',1,'expected_at','2026-10-03T00:00:00+08:00'),
    jsonb_build_object('item_id',other_id,'quantity',0,'expected_at','2026-10-03T00:00:00+08:00')));
  RAISE EXCEPTION 'PENDING_BATCH_PARTIAL_COMMIT';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='PENDING_BATCH_PARTIAL_COMMIT' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.se_supply_records WHERE project_id=fixture_project_id)<>before_count
 THEN RAISE EXCEPTION 'PENDING_BATCH_NOT_ATOMIC'; END IF;

 batches:=public.create_receiving_batches(gen_random_uuid(),now(),fixture_project_id,jsonb_build_array(
  jsonb_build_object('kind','BOX','lines',jsonb_build_array(
   jsonb_build_object('quantity',1,'raw_serials',jsonb_build_array('UXBA0001-AA')),
   jsonb_build_object('quantity',1,'raw_serials',jsonb_build_array('UXBA0002-AA')),
   jsonb_build_object('quantity',1,'raw_serials',jsonb_build_array('UXBA0003-AA')))),
  jsonb_build_object('kind','BOX','lines',jsonb_build_array(
   jsonb_build_object('quantity',1,
    'raw_serials',jsonb_build_array('UXBA0004-AA')),
   jsonb_build_object('inventory_item_id',plain_id,'quantity',2)))));
 first_arrival:=(batches->0->'arrival'->>'id')::uuid;
 second_arrival:=(batches->1->'arrival'->>'id')::uuid;
 first_line:=(batches->0->'lines'->0->>'id')::uuid;
 second_line:=(batches->0->'lines'->1->>'id')::uuid;
 third_line:=(batches->1->'lines'->0->>'id')::uuid;
 IF jsonb_array_length(batches)<>2 OR first_arrival=second_arrival
  OR (SELECT count(*) FROM public.receiving_arrivals
   WHERE id IN (first_arrival,second_arrival) AND batch_kind='BOX' AND batch_position IN (1,2))<>2
  OR (SELECT count(*) FROM public.receiving_arrival_lines WHERE arrival_id=first_arrival)<>3
  OR (SELECT count(*) FROM public.receiving_arrival_lines WHERE arrival_id=second_arrival)<>2
  OR (SELECT count(*) FROM public.inventory_transactions WHERE item_id IN (plain_id,other_id,serial_id))<>before_inventory
 THEN RAISE EXCEPTION 'PHYSICAL_BOX_IDENTITY_FAILED'; END IF;

 SELECT count(*) INTO before_count FROM public.receiving_arrivals WHERE project_id=fixture_project_id;
 BEGIN
  PERFORM public.create_receiving_batches(gen_random_uuid(),now(),fixture_project_id,jsonb_build_array(
   jsonb_build_object('kind','BOX','lines',jsonb_build_array(
    jsonb_build_object('inventory_item_id',plain_id,'quantity',1))),
   jsonb_build_object('kind','BOX','lines',jsonb_build_array(
    jsonb_build_object('inventory_item_id',serial_id,'quantity',1)))));
  RAISE EXCEPTION 'PHYSICAL_BATCH_PARTIAL_COMMIT';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='PHYSICAL_BATCH_PARTIAL_COMMIT' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.receiving_arrivals WHERE project_id=fixture_project_id)<>before_count
 THEN RAISE EXCEPTION 'PHYSICAL_BATCH_NOT_ATOMIC'; END IF;

 BEGIN
  PERFORM public.complete_receiving_arrival_lines(gen_random_uuid(),ARRAY[first_line,third_line],serial_id);
  RAISE EXCEPTION 'CROSS_BOX_RESOLVE_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'ARRIVAL_BATCH_RESOLVE_SCOPE' THEN RAISE; END IF;
 END;
 IF (SELECT resolution_state FROM public.receiving_arrival_lines WHERE id=first_line)<>'UNRESOLVED'
 THEN RAISE EXCEPTION 'BATCH_RESOLVE_NOT_ATOMIC'; END IF;
 result:=public.complete_receiving_arrival_lines(gen_random_uuid(),ARRAY[first_line,second_line],serial_id);
 IF jsonb_array_length(result)<>2
  OR (SELECT count(*) FROM public.receiving_arrival_lines WHERE id IN (first_line,second_line) AND resolution_state='STAGED')<>2
  OR (SELECT count(*) FROM public.receiving_serial_entries WHERE arrival_line_id IN (first_line,second_line)
   AND inventory_item_id=serial_id AND inventory_serial_id IS NULL)<>2
  OR (SELECT count(*) FROM public.receiving_arrival_lines WHERE arrival_id=first_arrival AND resolution_state='UNRESOLVED')<>1
  OR (SELECT count(*) FROM public.inventory_transactions WHERE item_id IN (plain_id,other_id,serial_id))<>before_inventory
 THEN RAISE EXCEPTION 'BATCH_RESOLVE_FAILED'; END IF;
 RAISE NOTICE 'RECEIVING UX BATCHES PASS';
END $$;
ROLLBACK;
