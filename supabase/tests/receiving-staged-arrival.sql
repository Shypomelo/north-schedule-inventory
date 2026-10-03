-- Candidate staging gate. Every fixture and audit event rolls back.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE FUNCTION pg_temp.ok(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
SELECT set_config('test.staging_actor',
 (SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment,canonical_identity_key)
VALUES
 ('89000000-0000-4000-8000-000000000001','[STAGING TEST] plain','[STAGING TEST] plain','unit','material',false,false,'staging-test-plain'),
 ('89000000-0000-4000-8000-000000000002','[STAGING TEST] serial','[STAGING TEST] serial','unit','equipment',true,true,'staging-test-serial');
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
SELECT set_config('request.jwt.claims',
 jsonb_build_object('email',current_setting('test.staging_actor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE plain uuid:='89000000-0000-4000-8000-000000000001';
 serial_item uuid:='89000000-0000-4000-8000-000000000002';
 pending uuid; arrival jsonb; line_id uuid; receipt jsonb; receipt2 jsonb;
 observed uuid; serial_id uuid; reversed jsonb; reentered jsonb;
 legacy_before text;
 before_tx bigint; before_receipts bigint; before_serials bigint;
BEGIN
 SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'')) INTO legacy_before
 FROM public.material_receipts r WHERE r.source_type='ARRIVAL';
 pending:=(public.create_office_equipment_arrival(gen_random_uuid(),plain,7,now(),NULL,'staging test','[]')->>'id')::uuid;
 SELECT count(*) INTO before_tx FROM public.inventory_transactions;
 SELECT count(*) INTO before_receipts FROM public.material_receipts;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',plain,'quantity',3)),NULL,'staging test');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 PERFORM pg_temp.ok((SELECT resolution_state='STAGED' AND receipt_id IS NULL
  FROM public.receiving_arrival_lines WHERE id=line_id),'known physical line staged');
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions)
  AND (SELECT count(*)=before_receipts FROM public.material_receipts),'physical arrival has zero inventory and receipts');
 PERFORM public.match_receiving_arrival_line(gen_random_uuid(),line_id,3,NULL,pending);
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending)->>'remaining'='4',
  'physical match consumes only three of seven Pending');
 receipt:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,2,'{}','2099-03-15');
 PERFORM pg_temp.ok((receipt->'receipt'->>'source_type')='ARRIVAL_ROUTE'
  AND (receipt->'receipt'->>'route_arrival_line_id')::uuid=line_id
  AND (SELECT resolution_state='STAGED' FROM public.receiving_arrival_lines WHERE id=line_id),
  'partial post creates route receipt and leaves staging');
 receipt2:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,1,'{}','2099-03-15');
 PERFORM pg_temp.ok((SELECT resolution_state='POSTED' FROM public.receiving_arrival_lines WHERE id=line_id),
  'final post completes line');
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending)->>'remaining'='4',
  'Inventory Receipt does not consume Pending again');
 PERFORM pg_temp.ok((SELECT count(*)=2 FROM public.material_receipts WHERE route_arrival_line_id=line_id
  AND event_type='RECEIVE') AND (SELECT count(*)=2 FROM public.inventory_transactions
  WHERE item_id=plain AND transaction_type='IN' AND NOT is_voided),
  'each post has exactly one canonical IN');

 -- Unknown physical arrival is an observation only, with no canonical item.
 SELECT count(*) INTO before_tx FROM public.inventory_transactions;
 SELECT count(*) INTO before_receipts FROM public.material_receipts;
 SELECT count(*) INTO before_serials FROM public.inventory_serials;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('quantity',1,
   'raw_serials',jsonb_build_array('STAG0002-AA'))),NULL,'staging unknown');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 PERFORM pg_temp.ok((SELECT resolution_state='UNRESOLVED' AND inventory_item_id IS NULL
  AND receipt_id IS NULL FROM public.receiving_arrival_lines WHERE id=line_id),
  'unknown physical line remains unresolved');
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions)
  AND (SELECT count(*)=before_receipts FROM public.material_receipts)
  AND (SELECT count(*)=before_serials FROM public.inventory_serials),
  'unknown physical arrival has zero Inventory IN and no receipt');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.receiving_serial_entries
  WHERE arrival_line_id=line_id AND inventory_item_id IS NULL
   AND inventory_serial_id IS NULL AND active_receipt_id IS NULL),
  'unknown serial observation has no inventory ownership');
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,pending)->>'remaining'='4',
  'unknown physical arrival does not alter unrelated Pending fulfilment');

 SELECT count(*) INTO before_serials FROM public.inventory_serials;
 arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',serial_item,'quantity',1,
   'raw_serials',jsonb_build_array('STAG0001-AA'))),NULL,'staging serial');
 line_id:=(arrival->'lines'->0->>'id')::uuid;
 PERFORM pg_temp.ok((SELECT count(*)=before_serials FROM public.inventory_serials),
  'physical serial observation has no inventory ownership');
 SELECT id INTO observed FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
 receipt:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,1,ARRAY[observed],'2099-03-15');
 SELECT inventory_serial_id INTO serial_id FROM public.receiving_serial_entries WHERE id=observed;
 PERFORM pg_temp.ok(serial_id IS NOT NULL AND (SELECT active_receipt_id=(receipt->'receipt'->>'id')::uuid
  FROM public.receiving_serial_entries WHERE id=observed),'post owns exact observed serial');
 reversed:=public.reverse_receiving_inventory_in(gen_random_uuid(),
  (receipt->'receipt'->>'id')::uuid,1,ARRAY[observed],'2099-03-16','staging test');
 PERFORM pg_temp.ok((SELECT resolution_state='STAGED' FROM public.receiving_arrival_lines WHERE id=line_id)
  AND (SELECT inventory_serial_id=serial_id AND active_receipt_id IS NULL
   FROM public.receiving_serial_entries WHERE id=observed),'IN_REVERSAL returns exact serial to staging');
 reentered:=public.reenter_receiving_inventory(gen_random_uuid(),
  (reversed->'receipt'->>'id')::uuid,1,ARRAY[observed],'2099-03-17','staging test');
 PERFORM pg_temp.ok((SELECT resolution_state='POSTED' FROM public.receiving_arrival_lines WHERE id=line_id)
  AND (SELECT inventory_serial_id=serial_id AND active_receipt_id=(reentered->'receipt'->>'id')::uuid
   FROM public.receiving_serial_entries WHERE id=observed),'Re-IN preserves serial identity');
 PERFORM pg_temp.ok(legacy_before=(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,''))
  FROM public.material_receipts r WHERE r.source_type='ARRIVAL'),
  'legacy ARRIVAL receipt history unchanged');
END $$;
ROLLBACK;
