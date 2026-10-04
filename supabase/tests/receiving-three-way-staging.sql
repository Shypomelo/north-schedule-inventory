-- Candidate-only rollback fixture. No business rows or audits persist.
BEGIN;
SET LOCAL statement_timeout='120s';
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
SELECT set_config('test.actor',(SELECT email FROM public.team_members
 WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO public.projects(id,project_name) VALUES
 ('8a000000-0000-4000-8000-000000000001','[THREE-WAY TEST] A');
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment,canonical_identity_key)
VALUES
 ('8a000000-0000-4000-8000-000000000002','[THREE-WAY TEST] plain','[THREE-WAY TEST] plain','unit','material',false,false,'three-way-test-plain'),
 ('8a000000-0000-4000-8000-000000000003','[THREE-WAY TEST] serial','[THREE-WAY TEST] serial','unit','equipment',true,true,'three-way-test-serial'),
 ('8a000000-0000-4000-8000-000000000006','[THREE-WAY TEST] reentry plain','[THREE-WAY TEST] reentry plain','unit','material',false,false,'three-way-test-reentry-plain');
INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by,ordered_at)
 VALUES('8a000000-0000-4000-8000-000000000004','8a000000-0000-4000-8000-000000000001',
 '[THREE-WAY TEST] existing',(SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),now());
INSERT INTO public.project_materials(id,project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES('8a000000-0000-4000-8000-000000000005','8a000000-0000-4000-8000-000000000001',
 '8a000000-0000-4000-8000-000000000004','[THREE-WAY TEST] existing',2,'unit',
 (SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),
 '8a000000-0000-4000-8000-000000000002','SITE');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.actor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE project_id uuid:='8a000000-0000-4000-8000-000000000001';
 plain_id uuid:='8a000000-0000-4000-8000-000000000002';
 serial_id uuid:='8a000000-0000-4000-8000-000000000003';
 reentry_plain_id uuid:='8a000000-0000-4000-8000-000000000006';
 pending_id uuid; arrival jsonb; line_id uuid; match_id uuid;
 routed jsonb; original_receipt uuid; reversal jsonb; entry_id uuid; inv_serial_id uuid;
 second_entry uuid; second_serial uuid; pending3 uuid; route_request uuid;
 before_tx bigint; before_receipt bigint; before_pending numeric; result jsonb;
BEGIN
 pending_id:=(public.create_office_equipment_arrival(gen_random_uuid(),plain_id,7,now(),project_id,'three-way test','[]')->>'id')::uuid;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',plain_id,'quantity',7)),project_id,'three-way test');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 match_id:=(public.match_receiving_arrival_line(gen_random_uuid(),line_id,7,NULL,pending_id)->>'id')::uuid;
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending_id)->>'remaining'='0','arrival consumes pending seven');
 SELECT count(*) INTO before_tx FROM public.inventory_transactions WHERE item_id=plain_id;
 route_request:=gen_random_uuid();
 routed:=public.route_staged_receiving(route_request,'NORMAL',line_id,NULL,'SE',3,'{}',project_id,NULL,false,now(),NULL);
 PERFORM pg_temp.ok((routed->'receipt'->>'source_type')='ARRIVAL_ROUTE'
  AND (SELECT count(*)=before_tx+1 FROM public.inventory_transactions WHERE item_id=plain_id)
  AND (SELECT count(*)=1 FROM public.receiving_inventory_allocations WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid AND route_type='SE')
  AND (SELECT count(*)=1 FROM public.se_supply_records s JOIN public.receiving_inventory_allocations x ON x.se_supply_record_id=s.id
    WHERE x.office_receipt_id=(routed->'receipt'->>'id')::uuid),
  'normal staged SE atomic canonical receipt, IN, allocation and supply');
 PERFORM pg_temp.ok(public.route_staged_receiving(route_request,'NORMAL',line_id,NULL,'SE',3,'{}',project_id,NULL,false,now(),NULL)=routed
  AND (SELECT count(*)=before_tx+1 FROM public.inventory_transactions WHERE item_id=plain_id),
  'route request retry is idempotent');
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending_id)->>'remaining'='0','SE routing does not double fulfil pending');
 SELECT count(*) INTO before_receipt FROM public.material_receipts WHERE route_arrival_line_id=line_id;
 BEGIN
  PERFORM public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SITE',1,'{}',project_id,
   '8a000000-0000-4000-8000-000000000099',false,now(),NULL);
  RAISE EXCEPTION 'Expected invalid SITE requirement failure';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected invalid SITE requirement failure' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.ok((SELECT count(*)=before_receipt FROM public.material_receipts WHERE route_arrival_line_id=line_id),
  'failed SITE route rolls back its Inventory receipt');
 route_request:=gen_random_uuid();
 result:=public.cancel_receiving_physical_stage(route_request,line_id,NULL,4,'{}',
  jsonb_build_array(jsonb_build_object('match_id',match_id,'quantity',4)),'three-way test cancel');
 PERFORM pg_temp.ok((result->>'quantity')::numeric=4
  AND public.get_receiving_pending_fulfilment(NULL,pending_id)->>'remaining'='4'
  AND (SELECT count(*)=1 FROM public.receiving_arrival_stage_cancellations WHERE arrival_line_id=line_id),
  'partial cancel restores only four Pending and retains cancellation history');
 PERFORM pg_temp.ok(public.cancel_receiving_physical_stage(route_request,line_id,NULL,4,'{}',
   jsonb_build_array(jsonb_build_object('match_id',match_id,'quantity',4)),'three-way test cancel')=result
  AND (SELECT count(*)=1 FROM public.receiving_arrival_stage_cancellations WHERE arrival_line_id=line_id),
  'physical cancellation request retry is idempotent');
 BEGIN
  PERFORM public.post_receiving_arrival_line(gen_random_uuid(),line_id,1,'{}',NULL);
  RAISE EXCEPTION 'Expected canceled capacity block';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected canceled capacity block' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.material_receipts WHERE route_arrival_line_id=line_id),
  'canceled staging cannot be posted again');
 BEGIN
  PERFORM public.cancel_receiving_physical_stage(gen_random_uuid(),line_id,NULL,1,'{}','[]','processed amount');
  RAISE EXCEPTION 'Expected processed arrival cancellation block';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected processed arrival cancellation block' THEN RAISE; END IF;
 END;

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('quantity',1,'raw_serials',jsonb_build_array('TWAY0001-AA'))),project_id,'unknown');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 PERFORM public.cancel_receiving_physical_stage(gen_random_uuid(),line_id,NULL,1,ARRAY[entry_id],'[]','unknown cancel');
 PERFORM pg_temp.ok((SELECT retired_at IS NOT NULL FROM public.receiving_serial_entries WHERE id=entry_id)
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE route_arrival_line_id=line_id),
  'UNRESOLVED cancellation has no Inventory receipt');

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('quantity',2,'raw_serials',jsonb_build_array('TWAY0005-AA','TWAY0006-AA'))),project_id,'partial unknown');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id AND normalized_serial='TWAY0005-AA';
 PERFORM public.cancel_receiving_physical_stage(gen_random_uuid(),line_id,NULL,1,ARRAY[entry_id],'[]','partial unknown cancel');
 SELECT count(*) INTO before_tx FROM public.inventory_transactions WHERE item_id=serial_id;
 PERFORM public.complete_receiving_arrival_line(gen_random_uuid(),line_id,serial_id,NULL);
 PERFORM pg_temp.ok((SELECT resolution_state='STAGED' FROM public.receiving_arrival_lines WHERE id=line_id)
  AND (SELECT count(*)=before_tx FROM public.inventory_transactions WHERE item_id=serial_id),
  'partially canceled unknown resolves only remaining identity with zero Inventory effect');

 pending3:=(public.create_office_equipment_arrival(gen_random_uuid(),serial_id,2,now(),project_id,'serial pending','[]')->>'id')::uuid;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',serial_id,'quantity',2,
   'raw_serials',jsonb_build_array('TWAY0007-AA','TWAY0008-AA'))),project_id,'serial pending');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT ids[1],ids[2] INTO entry_id,second_entry FROM (
   SELECT array_agg(id ORDER BY id) AS ids FROM public.receiving_serial_entries WHERE arrival_line_id=line_id
 ) s;
 match_id:=(public.match_receiving_arrival_line(gen_random_uuid(),line_id,2,NULL,pending3,
  ARRAY[entry_id,second_entry])->>'id')::uuid;
 PERFORM public.cancel_receiving_physical_stage(gen_random_uuid(),line_id,NULL,1,ARRAY[entry_id],'[]','serial pending cancel');
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending3)->>'remaining'='1'
  AND (SELECT count(*)=1 FROM public.receiving_arrival_match_serials s
   JOIN public.receiving_arrival_matches m ON m.id=s.match_id
   WHERE m.arrival_line_id=line_id AND m.cancelled_at IS NULL AND s.arrival_entry_id=second_entry)
  AND (SELECT count(*)=0 FROM public.receiving_arrival_match_serials s
   JOIN public.receiving_arrival_matches m ON m.id=s.match_id
   WHERE m.arrival_line_id=line_id AND m.cancelled_at IS NULL AND s.arrival_entry_id=entry_id),
  'serialized partial cancellation releases exactly selected Pending identity');

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',serial_id,'quantity',1,
   'raw_serials',jsonb_build_array('TWAY0002-AA'))),project_id,'serial');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SE',1,ARRAY[entry_id],project_id,NULL,false,now(),NULL);
 original_receipt:=(routed->'receipt'->>'id')::uuid;
 SELECT inventory_serial_id INTO inv_serial_id FROM public.receiving_serial_entries WHERE id=entry_id;
 PERFORM pg_temp.ok(inv_serial_id IS NOT NULL AND (SELECT count(*)=1 FROM public.receiving_inventory_allocations WHERE office_receipt_id=original_receipt),
  'serialized route preserves exact inventory serial identity');

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',plain_id,'quantity',2)),project_id,'SITE');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SITE',1,'{}',project_id,
  '8a000000-0000-4000-8000-000000000005',false,now(),NULL);
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.receiving_inventory_allocations
   WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid AND route_type='SITE'
    AND project_material_id='8a000000-0000-4000-8000-000000000005')
  AND (SELECT count(*)=1 FROM public.material_receipts WHERE source_type='PROJECT_MATERIAL' AND receipt_location='SITE'
    AND project_material_id='8a000000-0000-4000-8000-000000000005')
  AND (SELECT count(*)=1 FROM public.inventory_transactions WHERE id=(routed->'receipt'->>'inventory_transaction_id')::uuid
    AND transaction_type='IN')
  AND (SELECT count(*)=1 FROM public.inventory_transactions t JOIN public.receiving_inventory_allocations a
   ON a.inventory_transaction_id=t.id WHERE a.office_receipt_id=(routed->'receipt'->>'id')::uuid AND t.transaction_type='OUT'),
  'SITE existing requirement has canonical office IN, OUT, site receipt and allocation');
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SITE',1,'{}',project_id,NULL,true,now(),NULL);
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.receiving_inventory_allocations
   WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid AND route_type='SITE'
    AND project_material_id<>'8a000000-0000-4000-8000-000000000005'),
  'SITE create-new requires explicit flag and creates linked allocation');

 -- Re-entry is a separate stage; SE and SITE are both single RPC actions.
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',serial_id,'quantity',2,
   'raw_serials',jsonb_build_array('TWAY0003-AA','TWAY0004-AA'))),project_id,'reentry');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT ids[1],ids[2] INTO entry_id,second_entry FROM (
   SELECT array_agg(id ORDER BY id) AS ids FROM public.receiving_serial_entries WHERE arrival_line_id=line_id
 ) s;
 routed:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,2,ARRAY[entry_id,second_entry],NULL);
 original_receipt:=(routed->'receipt'->>'id')::uuid;
 SELECT inventory_serial_id INTO inv_serial_id FROM public.receiving_serial_entries WHERE id=entry_id;
 SELECT inventory_serial_id INTO second_serial FROM public.receiving_serial_entries WHERE id=second_entry;
 reversal:=public.reverse_receiving_inventory_in(gen_random_uuid(),original_receipt,2,
  ARRAY[entry_id,second_entry],clock_timestamp()+interval '1 second','reentry test');
 routed:=public.route_staged_receiving(gen_random_uuid(),'REENTRY',line_id,
  (reversal->'receipt'->>'id')::uuid,'SE',1,ARRAY[entry_id],project_id,NULL,false,
  clock_timestamp()+interval '2 seconds',NULL);
 PERFORM pg_temp.ok((routed->'receipt'->>'reentry_of_reversal_id')=(reversal->'receipt'->>'id')
  AND (SELECT inventory_serial_id=inv_serial_id FROM public.receiving_serial_entries WHERE id=entry_id)
  AND (SELECT count(*)=1 FROM public.receiving_inventory_allocations WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid),
  'reentry SE keeps original inventory serial ID and allocation');
 routed:=public.route_staged_receiving(gen_random_uuid(),'REENTRY',line_id,
  (reversal->'receipt'->>'id')::uuid,'SITE',1,ARRAY[second_entry],project_id,NULL,true,
  clock_timestamp()+interval '2 seconds',NULL);
 PERFORM pg_temp.ok((SELECT inventory_serial_id=second_serial FROM public.receiving_serial_entries WHERE id=second_entry)
  AND (SELECT count(*)=1 FROM public.receiving_inventory_allocations WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid AND route_type='SITE'),
  'reentry SITE keeps original inventory serial ID and site allocation');

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',serial_id,'quantity',1,
   'raw_serials',jsonb_build_array('TWAY0009-AA'))),project_id,'serial cancel after reversal');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 routed:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,1,ARRAY[entry_id],NULL);
 SELECT inventory_serial_id INTO inv_serial_id FROM public.receiving_serial_entries WHERE id=entry_id;
 reversal:=public.reverse_receiving_inventory_in(gen_random_uuid(),(routed->'receipt'->>'id')::uuid,
  1,ARRAY[entry_id],clock_timestamp()+interval '1 second','serial cancel after reversal');
 PERFORM public.cancel_receiving_physical_stage(gen_random_uuid(),line_id,(reversal->'receipt'->>'id')::uuid,
  1,ARRAY[entry_id],'[]','cancel returned serial');
 PERFORM pg_temp.ok((SELECT retired_at IS NOT NULL AND inventory_serial_id=inv_serial_id
   FROM public.receiving_serial_entries WHERE id=entry_id)
  AND (SELECT status='作廢' FROM public.inventory_serials WHERE id=inv_serial_id)
  AND (SELECT count(*)=1 FROM public.inventory_serials WHERE normalized_full='TWAY0009-AA'),
  'returned serial cancellation retains one canonical identity and retires its physical observation');

 pending3:=(public.create_office_equipment_arrival(gen_random_uuid(),reentry_plain_id,3,now(),project_id,'cancel reentry','[]')->>'id')::uuid;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',reentry_plain_id,'quantity',3)),project_id,'cancel reentry');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 match_id:=(public.match_receiving_arrival_line(gen_random_uuid(),line_id,3,NULL,pending3)->>'id')::uuid;
 routed:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,3,'{}',NULL);
 reversal:=public.reverse_receiving_inventory_in(gen_random_uuid(),(routed->'receipt'->>'id')::uuid,
  3,'{}',clock_timestamp()+interval '1 second','cancel reentry');
 PERFORM public.cancel_receiving_physical_stage(gen_random_uuid(),line_id,(reversal->'receipt'->>'id')::uuid,
  3,'{}',jsonb_build_array(jsonb_build_object('match_id',match_id,'quantity',3)),'cancel returned physical quantity');
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending3)->>'remaining'='3'
  AND (SELECT count(*)=1 FROM public.receiving_arrival_stage_cancellations
   WHERE arrival_line_id=line_id AND reversal_receipt_id=(reversal->'receipt'->>'id')::uuid),
  'returned stage cancel restores Pending without rewriting receipt or reversal');
END $$;
ROLLBACK;
