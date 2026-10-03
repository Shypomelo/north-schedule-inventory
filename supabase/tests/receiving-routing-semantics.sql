-- Candidate only. Every fixture and audit event is rolled back.
BEGIN;
SET LOCAL statement_timeout='120s';
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.balance(p_item uuid) RETURNS numeric LANGUAGE sql AS $$
 SELECT i.opening_quantity+COALESCE((SELECT sum(CASE WHEN transaction_type IN ('OUT','IN_REVERSAL')
  THEN -quantity ELSE quantity END) FROM public.inventory_transactions t
  WHERE t.item_id=i.id AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL),0)
 FROM public.inventory_items i WHERE i.id=p_item
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
SELECT set_config('test.actor',(SELECT email FROM public.team_members
 WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO public.projects(id,project_name) VALUES
 ('8b100000-0000-4000-8000-000000000001','[ROUTING SEMANTICS TEST] project');
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment,canonical_identity_key)
VALUES
 ('8b100000-0000-4000-8000-000000000002','[ROUTING SEMANTICS] plain','[ROUTING SEMANTICS] plain','unit','material',false,false,'routing-semantics-plain'),
 ('8b100000-0000-4000-8000-000000000003','[ROUTING SEMANTICS] serial','[ROUTING SEMANTICS] serial','unit','equipment',true,true,'routing-semantics-serial'),
 ('8b100000-0000-4000-8000-000000000006','[ROUTING SEMANTICS] prep','[ROUTING SEMANTICS] prep','unit','material',false,false,'routing-semantics-prep');
INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by,ordered_at)
 VALUES('8b100000-0000-4000-8000-000000000004','8b100000-0000-4000-8000-000000000001',
 '[ROUTING SEMANTICS TEST] existing',(SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),now());
INSERT INTO public.project_materials(id,project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES('8b100000-0000-4000-8000-000000000005','8b100000-0000-4000-8000-000000000001',
 '8b100000-0000-4000-8000-000000000004','[ROUTING SEMANTICS TEST] existing',5,'unit',
 (SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),
 '8b100000-0000-4000-8000-000000000006','SITE'),
 ('8b100000-0000-4000-8000-000000000007','8b100000-0000-4000-8000-000000000001',
 '8b100000-0000-4000-8000-000000000004','[ROUTING SEMANTICS TEST] serial prep',1,'unit',
 (SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),
 '8b100000-0000-4000-8000-000000000003','SITE');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.actor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE project_id uuid:='8b100000-0000-4000-8000-000000000001';
 plain_id uuid:='8b100000-0000-4000-8000-000000000002';
 serial_id uuid:='8b100000-0000-4000-8000-000000000003';
 material_id uuid:='8b100000-0000-4000-8000-000000000005';
 pending_id uuid; arrival jsonb; line_id uuid; entry_id uuid; inv_serial_id uuid;
 routed jsonb; receipt_id uuid; allocation_id uuid; record_id uuid; returned jsonb;
 another_allocation uuid; another_record uuid; result jsonb; created_material uuid;
 before_pending numeric; before_inventory numeric; after_inventory numeric;
BEGIN
 -- Serialized Receiving -> SE -> exact atomic return, preserving physical arrival and Pending fulfilment.
 pending_id:=(public.create_office_equipment_arrival(gen_random_uuid(),serial_id,1,now(),project_id,'semantic fixture','[]')->>'id')::uuid;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',serial_id,'quantity',1,'raw_serials',jsonb_build_array('RSEM0001-AA'))),project_id,'semantic fixture');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 PERFORM public.match_receiving_arrival_line(gen_random_uuid(),line_id,1,NULL,pending_id,ARRAY[entry_id]);
 before_pending:=(public.get_receiving_pending_fulfilment(NULL,pending_id)->>'remaining')::numeric;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SE',1,ARRAY[entry_id],project_id,NULL,false,now(),NULL);
 receipt_id:=(routed->'receipt'->>'id')::uuid;
 SELECT a.id,a.se_supply_record_id,a.inventory_serial_id INTO allocation_id,record_id,inv_serial_id
  FROM public.receiving_inventory_allocations a WHERE a.office_receipt_id=receipt_id;
 PERFORM pg_temp.ok(inv_serial_id IS NOT NULL AND (SELECT status='在庫' FROM public.inventory_serials WHERE id=inv_serial_id),
  'serialized SE starts with formal IN and in-stock identity');
 returned:=public.return_receiving_se_to_received(gen_random_uuid(),record_id,'semantic test',NULL);
 PERFORM pg_temp.ok((SELECT cancelled_at IS NOT NULL FROM public.se_supply_records WHERE id=record_id)
  AND (SELECT cancelled_at IS NOT NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id)
  AND (SELECT inventory_serial_id=inv_serial_id AND active_receipt_id IS NULL FROM public.receiving_serial_entries WHERE id=entry_id)
  AND (SELECT status='待入庫' FROM public.inventory_serials WHERE id=inv_serial_id)
  AND (SELECT count(*)=1 FROM public.material_receipts WHERE reversal_of_id=receipt_id AND event_type='REVERSAL')
  AND (SELECT count(*)=1 FROM public.inventory_transactions WHERE id=((returned->'reversal'->'inventory_transaction'->>'id')::uuid)
   AND transaction_type='IN_REVERSAL')
  AND (SELECT voided_at IS NULL FROM public.receiving_arrivals WHERE id=(arrival->'arrival'->>'id')::uuid)
  AND (public.get_receiving_pending_fulfilment(NULL,pending_id)->>'remaining')::numeric=before_pending,
  'serialized SE return cancels linked record/allocation and reverses exact IN without Pending or Arrival change');
 result:=public.reenter_receiving_inventory(gen_random_uuid(),(returned->'reversal'->'receipt'->>'id')::uuid,
  1,ARRAY[entry_id],clock_timestamp()+interval '1 second',NULL);
 PERFORM pg_temp.ok((SELECT inventory_serial_id=inv_serial_id FROM public.receiving_serial_entries WHERE id=entry_id)
  AND (SELECT status='在庫' FROM public.inventory_serials WHERE id=inv_serial_id),
  're-entry keeps the same inventory serial identity');

 -- Quantity return reverses only its allocation; the other allocation remains active.
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',plain_id,'quantity',7)),project_id,'quantity fixture');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 result:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,7,'{}',NULL);
 receipt_id:=(result->'receipt'->>'id')::uuid;
 PERFORM public.route_receiving_inventory(gen_random_uuid(),receipt_id,'SE',3,'{}',project_id,NULL,false,now(),NULL);
 PERFORM public.route_receiving_inventory(gen_random_uuid(),receipt_id,'SE',2,'{}',project_id,NULL,false,now(),NULL);
 SELECT id,se_supply_record_id INTO allocation_id,record_id FROM public.receiving_inventory_allocations
  WHERE office_receipt_id=receipt_id AND quantity=3;
 SELECT id,se_supply_record_id INTO another_allocation,another_record FROM public.receiving_inventory_allocations
  WHERE office_receipt_id=receipt_id AND quantity=2;
 before_inventory:=pg_temp.balance(plain_id);
 returned:=public.return_receiving_se_to_received(gen_random_uuid(),record_id,'partial quantity return',NULL);
 after_inventory:=pg_temp.balance(plain_id);
 PERFORM pg_temp.ok(after_inventory=before_inventory-3
  AND (SELECT cancelled_at IS NOT NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id)
  AND (SELECT cancelled_at IS NULL FROM public.receiving_inventory_allocations WHERE id=another_allocation)
  AND (SELECT cancelled_at IS NULL FROM public.se_supply_records WHERE id=another_record)
  AND (public.get_receiving_handoff_scope(receipt_id)->>'received')::numeric=4
  AND (public.get_receiving_handoff_scope(receipt_id)->>'se')::numeric=2,
  'nonserial partial return leaves another allocation and its stock intact');

 -- A separate item keeps same-transaction fixture timestamps from making an
 -- earlier nonserial reversal look like later consumption of the prep receipt.
 plain_id:='8b100000-0000-4000-8000-000000000006';

 -- A failure after SE retract must roll back both steps.
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',serial_id,'quantity',1,'raw_serials',jsonb_build_array('RSEM0002-AA'))),project_id,'rollback fixture');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SE',1,ARRAY[entry_id],project_id,NULL,false,now(),NULL);
 receipt_id:=(routed->'receipt'->>'id')::uuid;
 SELECT id,se_supply_record_id INTO allocation_id,record_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=receipt_id;
 BEGIN
  PERFORM public.return_receiving_se_to_received(gen_random_uuid(),record_id,'forced atomic failure',
   (SELECT received_at-interval '1 day' FROM public.material_receipts WHERE id=receipt_id));
  RAISE EXCEPTION 'Expected atomic failure';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected atomic failure' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.ok((SELECT cancelled_at IS NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id)
  AND (SELECT cancelled_at IS NULL FROM public.se_supply_records WHERE id=record_id)
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE reversal_of_id=receipt_id),
  'failed reversal leaves SE record, allocation, and Inventory IN untouched');
 PERFORM set_config('test.blocked_record',record_id::text,true);
 PERFORM set_config('test.blocked_receipt',receipt_id::text,true);

 -- Project preparation binds a real requirement while stock stays in North Office.
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',plain_id,'quantity',2)),project_id,'project preparation');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 before_inventory:=pg_temp.balance(plain_id);
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'PROJECT_PREP',2,'{}',project_id,material_id,false,now(),NULL);
 receipt_id:=(routed->'receipt'->>'id')::uuid;
 SELECT id INTO allocation_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=receipt_id;
 PERFORM pg_temp.ok((SELECT route_type='PROJECT_PREP' AND project_material_id=material_id
   AND site_receipt_id IS NULL AND inventory_transaction_id IS NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id)
  AND (SELECT count(*)=1 FROM public.inventory_transactions WHERE id=(SELECT inventory_transaction_id FROM public.material_receipts WHERE id=receipt_id)
   AND transaction_type='IN')
  AND (SELECT count(*)=0 FROM public.inventory_transactions WHERE item_id=plain_id AND transaction_type='OUT')
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE project_material_id=material_id AND receipt_location='SITE')
  AND (SELECT received_at IS NULL FROM public.project_materials WHERE id=material_id)
  AND pg_temp.balance(plain_id)=before_inventory+2
  AND (public.get_receiving_handoff_scope(receipt_id)->>'prep')::numeric=2,
  'existing project material preparation has IN but no OUT, SITE receipt, or false received state');
 BEGIN
  PERFORM public.route_receiving_inventory(gen_random_uuid(),receipt_id,'SE',1,'{}',project_id,NULL,false,now(),NULL);
  RAISE EXCEPTION 'Expected double route block';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected double route block' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%HANDOFF_CAPACITY_CONFLICT%' THEN RAISE; END IF;
 END;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',plain_id,'quantity',4)),project_id,'prepared capacity guard');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 result:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,4,'{}',NULL);
 before_inventory:=pg_temp.balance(plain_id);
 BEGIN
  PERFORM public.route_receiving_inventory(gen_random_uuid(),(result->'receipt'->>'id')::uuid,'SITE',4,'{}',
   project_id,material_id,false,now(),NULL);
  RAISE EXCEPTION 'Expected prepared capacity block';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected prepared capacity block' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%PROJECT_PREP_CAPACITY_CONFLICT%' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.ok((SELECT count(*)=0 FROM public.inventory_transactions WHERE item_id=plain_id AND transaction_type='OUT')
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE project_material_id=material_id AND receipt_location='SITE')
  AND (SELECT cancelled_at IS NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id),
  'actual SITE attempt cannot consume prepared demand or leave partial OUT');
 returned:=public.return_receiving_project_prep_to_received(gen_random_uuid(),allocation_id,'return preparation',NULL);
 PERFORM pg_temp.ok((SELECT cancelled_at IS NOT NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id)
  AND (SELECT count(*)=1 FROM public.material_receipts WHERE reversal_of_id=receipt_id)
  AND (public.get_receiving_handoff_scope(receipt_id)->>'prep')::numeric=0
  AND pg_temp.balance(plain_id)=before_inventory-2,
  'project preparation safely returns to Received staging');

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',plain_id,'quantity',1)),project_id,'new material preparation');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'PROJECT_PREP',1,'{}',project_id,NULL,true,now(),NULL);
 created_material:=(routed->'route'->>'project_material_id')::uuid;
 PERFORM pg_temp.ok(created_material IS NOT NULL AND (SELECT quantity=1 AND procurement_status<>'RECEIVED'
   AND inventory_item_id=plain_id FROM public.project_materials WHERE id=created_material)
  AND (SELECT count(*)=1 FROM public.receiving_inventory_allocations WHERE project_material_id=created_material AND route_type='PROJECT_PREP')
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE project_material_id=created_material AND receipt_location='SITE'),
  'create-new project material is linked as preparation without SITE receipt');

 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',serial_id,'quantity',1,'raw_serials',jsonb_build_array('RSEM0003-AA'))),project_id,'serial prep');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'PROJECT_PREP',1,ARRAY[entry_id],project_id,
  '8b100000-0000-4000-8000-000000000007',false,now(),NULL);
 receipt_id:=(routed->'receipt'->>'id')::uuid;
 SELECT id,inventory_serial_id INTO allocation_id,inv_serial_id FROM public.receiving_inventory_allocations
  WHERE office_receipt_id=receipt_id AND route_type='PROJECT_PREP';
 PERFORM pg_temp.ok((SELECT status='在庫' FROM public.inventory_serials WHERE id=inv_serial_id)
  AND (SELECT count(*)=0 FROM public.inventory_transactions WHERE item_id=serial_id AND transaction_type='OUT')
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE project_material_id='8b100000-0000-4000-8000-000000000007'
   AND receipt_location='SITE'),
  'serialized preparation keeps exact serial in North Office and no SITE effect');
 returned:=public.return_receiving_project_prep_to_received(gen_random_uuid(),allocation_id,'serial prep return',NULL);
 PERFORM pg_temp.ok((SELECT status='待入庫' FROM public.inventory_serials WHERE id=inv_serial_id)
  AND (SELECT inventory_serial_id=inv_serial_id AND active_receipt_id IS NULL FROM public.receiving_serial_entries WHERE id=entry_id)
  AND (SELECT cancelled_at IS NOT NULL FROM public.receiving_inventory_allocations WHERE id=allocation_id),
  'serialized preparation return keeps inventory_serial_id');

 -- The historical SITE command still means actual OUT and SITE receipt.
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object(
  'inventory_item_id',plain_id,'quantity',1)),project_id,'actual SITE regression');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SITE',1,'{}',project_id,material_id,false,now(),NULL);
 receipt_id:=(routed->'receipt'->>'id')::uuid;
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.receiving_inventory_allocations WHERE office_receipt_id=receipt_id AND route_type='SITE')
  AND (SELECT count(*)=1 FROM public.material_receipts WHERE project_material_id=material_id AND receipt_location='SITE' AND event_type='RECEIVE')
  AND (SELECT count(*)=1 FROM public.inventory_transactions t JOIN public.receiving_inventory_allocations a
   ON a.inventory_transaction_id=t.id WHERE a.office_receipt_id=receipt_id AND t.transaction_type='OUT'),
  'legacy SITE still performs actual delivery');
END $$;
RESET ROLE;
INSERT INTO public.inventory_monthly_closings(year,month,status,closed_by,closed_at,notes)
 VALUES(to_char(now() AT TIME ZONE 'Asia/Taipei','YYYY'),to_char(now() AT TIME ZONE 'Asia/Taipei','MM'),
 'CLOSED','[ROUTING SEMANTICS TEST]',now(),'rollback fixture');
SET LOCAL ROLE authenticated;
DO $$
DECLARE record_id uuid:=current_setting('test.blocked_record')::uuid;
 receipt_id uuid:=current_setting('test.blocked_receipt')::uuid;
BEGIN
 BEGIN
  PERFORM public.return_receiving_se_to_received(gen_random_uuid(),record_id,'closed month guard',NULL);
  RAISE EXCEPTION 'Expected closed month block';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Expected closed month block' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%DOWNSTREAM_CORRECTION_REQUIRED%' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.ok((SELECT cancelled_at IS NULL FROM public.se_supply_records WHERE id=record_id)
  AND (SELECT count(*)=0 FROM public.material_receipts WHERE reversal_of_id=receipt_id),
  'closed month blocks SE return without partial commit');
END $$;
ROLLBACK;
