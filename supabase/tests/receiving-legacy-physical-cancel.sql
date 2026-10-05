-- Candidate only. Fixture rows, audit rows and legacy-shape conversions roll back.
BEGIN;
SET LOCAL statement_timeout='120s';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM review_private.environment_guard
  WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW')
 THEN RAISE EXCEPTION 'CANDIDATE ONLY'; END IF;
END $$;
CREATE FUNCTION pg_temp.ok(v boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.reject(q text, label text, expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE q;
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM<>expected THEN RAISE EXCEPTION 'FAIL: %, got %',label,SQLERRM; END IF;
  RETURN;
 END;
 RAISE EXCEPTION 'FAIL: % accepted',label;
END $$;
CREATE FUNCTION pg_temp.balance(p_item uuid) RETURNS numeric LANGUAGE sql AS $$
 SELECT i.opening_quantity+COALESCE((SELECT sum(CASE WHEN transaction_type IN ('OUT','IN_REVERSAL')
  THEN -quantity ELSE quantity END) FROM public.inventory_transactions t
  WHERE t.item_id=i.id AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL),0)
 FROM public.inventory_items i WHERE i.id=p_item
$$;
CREATE TEMP TABLE physical_cases (
 kind text PRIMARY KEY, line_id uuid, receipt_id uuid, reversal_id uuid,
 item_id uuid, entry_id uuid, serial_id uuid, pending_id uuid, match_id uuid
) ON COMMIT DROP;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
GRANT SELECT,INSERT,UPDATE ON physical_cases TO authenticated;
SELECT set_config('test.actor',(SELECT email FROM public.team_members
 WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment,canonical_identity_key)
VALUES
 ('8c100000-0000-4000-8000-000000000001','[LPC TEST] plain','[LPC TEST] plain','unit','material',false,false,'lpc-test-plain'),
 ('8c100000-0000-4000-8000-000000000002','[LPC TEST] serial','[LPC TEST] serial','unit','equipment',true,true,'lpc-test-serial'),
 ('8c100000-0000-4000-8000-000000000006','[LPC TEST] legacy plain','[LPC TEST] legacy plain','unit','material',false,false,'lpc-test-legacy-plain');
INSERT INTO public.projects(id,project_name) VALUES
 ('8c100000-0000-4000-8000-000000000003','[LPC TEST] project');
INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by,ordered_at)
 VALUES('8c100000-0000-4000-8000-000000000004','8c100000-0000-4000-8000-000000000003',
 '[LPC TEST] batch',(SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),now());
INSERT INTO public.project_materials(id,project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES('8c100000-0000-4000-8000-000000000005','8c100000-0000-4000-8000-000000000003',
 '8c100000-0000-4000-8000-000000000004','[LPC TEST] material',1,'unit',
 (SELECT id FROM public.team_members WHERE email=current_setting('test.actor')),
 '8c100000-0000-4000-8000-000000000001','SITE');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.actor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE kind text; item_id uuid; qty numeric; arrival jsonb; line_id uuid;
 pending_id uuid; match_id uuid; entry_id uuid; receipt jsonb; serial_id uuid;
BEGIN
 FOREACH kind IN ARRAY ARRAY['route','legacy','serial'] LOOP
  item_id:=CASE kind
   WHEN 'serial' THEN '8c100000-0000-4000-8000-000000000002'::uuid
   WHEN 'legacy' THEN '8c100000-0000-4000-8000-000000000006'::uuid
   ELSE '8c100000-0000-4000-8000-000000000001'::uuid END;
  qty:=CASE WHEN kind='serial' THEN 1 ELSE 3 END;
  pending_id:=(public.create_office_equipment_arrival(gen_random_uuid(),item_id,qty,now(),NULL,
   '[LPC TEST] pending','[]')->>'id')::uuid;
  arrival:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(
   jsonb_build_object('inventory_item_id',item_id,'quantity',qty,'raw_serials',
    CASE WHEN kind='serial' THEN jsonb_build_array('LPC00001-AA') ELSE '[]'::jsonb END)),NULL,'[LPC TEST] arrival');
  line_id:=(arrival->'lines'->0->>'id')::uuid;
  IF kind='serial' THEN
   SELECT id INTO entry_id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id;
  ELSE entry_id:=NULL; END IF;
  match_id:=(public.match_receiving_arrival_line(gen_random_uuid(),line_id,qty,NULL,pending_id,
   CASE WHEN entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[entry_id] END)->>'id')::uuid;
  receipt:=public.post_receiving_arrival_line(gen_random_uuid(),line_id,qty,
   CASE WHEN entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[entry_id] END,NULL);
  IF entry_id IS NOT NULL THEN
   SELECT inventory_serial_id INTO serial_id FROM public.receiving_serial_entries WHERE id=entry_id;
  ELSE serial_id:=NULL; END IF;
  INSERT INTO physical_cases VALUES(kind,line_id,(receipt->'receipt'->>'id')::uuid,NULL,
   item_id,entry_id,serial_id,pending_id,match_id);
 END LOOP;
END $$;
RESET ROLE;
-- Recreate the persisted V5 ARRIVAL receipt/line shape without changing its IN ledger.
UPDATE public.material_receipts r SET source_type='ARRIVAL',arrival_line_id=c.line_id,route_arrival_line_id=NULL
 FROM physical_cases c WHERE c.kind IN ('legacy','serial') AND r.id=c.receipt_id;
UPDATE public.receiving_arrival_lines l SET receipt_id=c.receipt_id
 FROM physical_cases c WHERE c.kind IN ('legacy','serial') AND l.id=c.line_id;
SET LOCAL ROLE authenticated;
DO $$
DECLARE c physical_cases%ROWTYPE; reversal jsonb; reentered jsonb;
BEGIN
 FOR c IN SELECT * FROM physical_cases LOOP
  reversal:=public.reverse_receiving_inventory_in(gen_random_uuid(),c.receipt_id,
   CASE WHEN c.kind='serial' THEN 1 ELSE 3 END,
   CASE WHEN c.entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[c.entry_id] END,
   clock_timestamp()+interval '1 second','[LPC TEST] reverse');
  UPDATE physical_cases SET reversal_id=(reversal->'receipt'->>'id')::uuid WHERE kind=c.kind;
  IF c.kind<>'serial' THEN
   reentered:=public.reenter_receiving_inventory(gen_random_uuid(),
    (reversal->'receipt'->>'id')::uuid,1,'{}',clock_timestamp()+interval '2 seconds',
    '[LPC TEST] partial reentry');
   PERFORM pg_temp.ok((reentered->'receipt'->>'reentry_of_reversal_id')=(reversal->'receipt'->>'id'),
    c.kind||' partial reentry linked');
  END IF;
 END LOOP;
END $$;
RESET ROLE;
-- A wrong-source receipt with otherwise plausible reversal fields must fail at the source gate.
INSERT INTO public.material_receipts(source_type,se_supply_record_id,event_type,reversal_of_id,
 quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
SELECT 'SE_SUPPLY',c.pending_id,'REVERSAL',c.receipt_id,1,r.received_by,r.received_at,
 '[LPC TEST] wrong source','OFFICE',true,r.inventory_transaction_id
FROM physical_cases c JOIN public.material_receipts r ON r.id=c.reversal_id WHERE c.kind='route';
INSERT INTO public.material_receipts(source_type,project_material_id,event_type,reversal_of_id,
 quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
SELECT 'PROJECT_MATERIAL','8c100000-0000-4000-8000-000000000005',
 'REVERSAL',c.receipt_id,1,r.received_by,r.received_at,
 '[LPC TEST] wrong project source','OFFICE',true,r.inventory_transaction_id
FROM physical_cases c JOIN public.material_receipts r ON r.id=c.reversal_id WHERE c.kind='route';
SET LOCAL ROLE authenticated;
DO $$
DECLARE c physical_cases%ROWTYPE; wrong_source uuid; wrong_project_source uuid; wrong_line uuid; result jsonb;
 before_tx bigint; before_receipts bigint; before_audit bigint; before_balance numeric;
 receipt_hash text; reversal_hash text; before_serials bigint;
BEGIN
 SELECT id INTO wrong_source FROM public.material_receipts WHERE notes='[LPC TEST] wrong source';
 SELECT id INTO wrong_project_source FROM public.material_receipts
  WHERE notes='[LPC TEST] wrong project source';
 FOR c IN SELECT * FROM physical_cases WHERE kind IN ('route','legacy') ORDER BY kind LOOP
  SELECT line_id INTO wrong_line FROM physical_cases
   WHERE kind=CASE WHEN c.kind='route' THEN 'legacy' ELSE 'route' END;
  PERFORM pg_temp.reject(format(
   'SELECT public.cancel_receiving_physical_stage(gen_random_uuid(),%L::uuid,%L::uuid,1,''{}''::uuid[],''[]''::jsonb,''wrong line'')',
    wrong_line,c.reversal_id),c.kind||' wrong line','PHYSICAL_CANCEL_REVERSAL_CONFLICT');
  SELECT count(*) INTO before_tx FROM public.inventory_transactions WHERE item_id=c.item_id;
  SELECT count(*) INTO before_receipts FROM public.material_receipts
   WHERE id IN (c.receipt_id,c.reversal_id) OR reentry_of_reversal_id=c.reversal_id;
  SELECT count(*) INTO before_audit FROM public.activity_logs WHERE action='PHYSICAL_ARRIVAL_STAGING_CANCELLED';
  before_balance:=pg_temp.balance(c.item_id);
  SELECT md5(to_jsonb(r)::text) INTO receipt_hash FROM public.material_receipts r WHERE id=c.receipt_id;
  SELECT md5(to_jsonb(r)::text) INTO reversal_hash FROM public.material_receipts r WHERE id=c.reversal_id;
  IF c.kind='route' THEN
   PERFORM pg_temp.reject(format(
    'SELECT public.cancel_receiving_physical_stage(gen_random_uuid(),%L::uuid,%L::uuid,1,''{}''::uuid[],''[]''::jsonb,''wrong source'')',
     c.line_id,wrong_source),'SE source blocked','PHYSICAL_CANCEL_REVERSAL_CONFLICT');
   PERFORM pg_temp.reject(format(
    'SELECT public.cancel_receiving_physical_stage(gen_random_uuid(),%L::uuid,%L::uuid,1,''{}''::uuid[],''[]''::jsonb,''wrong project source'')',
     c.line_id,wrong_project_source),'PROJECT source blocked','PHYSICAL_CANCEL_REVERSAL_CONFLICT');
  END IF;
  result:=public.cancel_receiving_physical_stage(gen_random_uuid(),c.line_id,c.reversal_id,2,
   '{}',jsonb_build_array(jsonb_build_object('match_id',c.match_id,'quantity',2)),
   '[LPC TEST] cancel staged');
  PERFORM pg_temp.ok((result->>'quantity')::numeric=2
   AND (SELECT count(*)=1 FROM public.receiving_arrival_stage_cancellations
    WHERE id=(result->>'id')::uuid AND arrival_line_id=c.line_id AND reversal_receipt_id=c.reversal_id)
   AND (SELECT quantity=3 FROM public.receiving_arrival_lines WHERE id=c.line_id),
   c.kind||' append-only cancellation and physical arrival history');
  PERFORM pg_temp.ok((public.get_receiving_pending_fulfilment(NULL,c.pending_id)->>'remaining')::numeric=2
   AND (SELECT cancelled_at IS NOT NULL FROM public.receiving_arrival_matches WHERE id=c.match_id)
   AND (SELECT count(*)=1 FROM public.receiving_arrival_matches
    WHERE arrival_line_id=c.line_id AND cancelled_at IS NULL AND quantity=1),
   c.kind||' exact match reduction and Pending release');
  PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions WHERE item_id=c.item_id)
   AND pg_temp.balance(c.item_id)=before_balance
   AND (SELECT count(*)=before_receipts FROM public.material_receipts
    WHERE id IN (c.receipt_id,c.reversal_id) OR reentry_of_reversal_id=c.reversal_id)
   AND (SELECT md5(to_jsonb(r)::text)=receipt_hash FROM public.material_receipts r WHERE id=c.receipt_id)
   AND (SELECT md5(to_jsonb(r)::text)=reversal_hash FROM public.material_receipts r WHERE id=c.reversal_id),
   c.kind||' Inventory unchanged and receipt/reversal history retained');
  PERFORM pg_temp.ok((SELECT count(*)=before_audit+1 FROM public.activity_logs
    WHERE action='PHYSICAL_ARRIVAL_STAGING_CANCELLED')
   AND (SELECT count(*)=1 FROM public.activity_logs
    WHERE action='PHYSICAL_ARRIVAL_STAGING_CANCELLED' AND target_id=result->>'id'),
   c.kind||' audit appended once');
  PERFORM pg_temp.reject(format(
   'SELECT public.cancel_receiving_physical_stage(gen_random_uuid(),%L::uuid,%L::uuid,1,''{}''::uuid[],''[]''::jsonb,''over cancel'')',
    c.line_id,c.reversal_id),c.kind||' reentered quantity cannot be cancelled',
   'PHYSICAL_CANCEL_STAGED_SCOPE_CONFLICT');
 END LOOP;
 SELECT * INTO c FROM physical_cases WHERE kind='serial';
 SELECT count(*) INTO before_tx FROM public.inventory_transactions WHERE item_id=c.item_id;
 SELECT count(*) INTO before_receipts FROM public.material_receipts WHERE id IN (c.receipt_id,c.reversal_id);
 SELECT count(*) INTO before_serials FROM public.inventory_serials WHERE item_id=c.item_id;
 SELECT count(*) INTO before_audit FROM public.activity_logs WHERE action='PHYSICAL_ARRIVAL_STAGING_CANCELLED';
 before_balance:=pg_temp.balance(c.item_id);
 SELECT md5(to_jsonb(r)::text) INTO receipt_hash FROM public.material_receipts r WHERE id=c.receipt_id;
 SELECT md5(to_jsonb(r)::text) INTO reversal_hash FROM public.material_receipts r WHERE id=c.reversal_id;
 result:=public.cancel_receiving_physical_stage(gen_random_uuid(),c.line_id,c.reversal_id,1,
  ARRAY[c.entry_id],'[]','[LPC TEST] cancel serial');
 PERFORM pg_temp.ok((SELECT inventory_serial_id=c.serial_id AND active_receipt_id IS NULL
   AND retired_at IS NOT NULL FROM public.receiving_serial_entries WHERE id=c.entry_id)
  AND (SELECT inventory_serial_id=c.serial_id FROM public.material_receipt_serials
   WHERE receipt_id=c.reversal_id AND entry_id=c.entry_id)
  AND (SELECT count(*)=before_serials FROM public.inventory_serials WHERE item_id=c.item_id),
  'serialized legacy reversal keeps one canonical serial identity');
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions WHERE item_id=c.item_id)
  AND pg_temp.balance(c.item_id)=before_balance
  AND (SELECT count(*)=before_receipts FROM public.material_receipts WHERE id IN (c.receipt_id,c.reversal_id))
  AND (SELECT md5(to_jsonb(r)::text)=receipt_hash FROM public.material_receipts r WHERE id=c.receipt_id)
  AND (SELECT md5(to_jsonb(r)::text)=reversal_hash FROM public.material_receipts r WHERE id=c.reversal_id)
  AND (SELECT count(*)=1 FROM public.receiving_arrival_stage_cancellations
   WHERE id=(result->>'id')::uuid AND entry_ids=ARRAY[c.entry_id])
  AND (SELECT count(*)=before_audit+1 FROM public.activity_logs
   WHERE action='PHYSICAL_ARRIVAL_STAGING_CANCELLED'),
  'serialized cancellation retains ledger/history and appends cancellation/audit');
END $$;
ROLLBACK;
SELECT count(*) AS cleanup FROM public.inventory_items WHERE code LIKE '[LPC TEST]%';
