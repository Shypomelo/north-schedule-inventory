-- Candidate ONLY; synthetic fixtures are transaction-scoped and always rolled back.
BEGIN;
SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='8s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW') THEN RAISE EXCEPTION 'CANDIDATE_ONLY'; END IF;
 PERFORM set_config('test.admin_email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
 PERFORM set_config('test.viewer_email',(SELECT email FROM public.team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
 PERFORM set_config('test.actor_id',(SELECT id::text FROM public.team_members WHERE email=current_setting('test.admin_email')),true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.admin_email'),'role','authenticated')::text,true);
END $$;
CREATE TEMP TABLE v6b_assertions(label text);
GRANT ALL ON v6b_assertions TO authenticated,anon;
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; INSERT INTO v6b_assertions VALUES(label); END $$;
CREATE FUNCTION pg_temp.reject(q text,pattern text,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN
 IF SQLERRM !~ pattern THEN RAISE EXCEPTION 'FAIL: % unexpected %',label,SQLERRM; END IF;
 PERFORM pg_temp.ok(true,label); RETURN; END; RAISE EXCEPTION 'FAIL: % did not reject',label; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
SET LOCAL ROLE authenticated;
DO $$
DECLARE serial_item uuid; plain_item uuid; pa uuid:=gen_random_uuid(); pb uuid:=gen_random_uuid(); batch uuid:=gen_random_uuid(); material uuid:=gen_random_uuid();
 a jsonb; again jsonb; names jsonb; receipt uuid; plain_receipt uuid; ids uuid[]; result jsonb; site uuid; alloc uuid; new_material uuid; req uuid; before_count bigint; actor uuid:=current_setting('test.actor_id')::uuid;
BEGIN
 a:=public.get_or_create_inventory_item(' [TEST V6B] Device-123 ','台',true);
 serial_item:=(a->'item'->>'id')::uuid;
 PERFORM pg_temp.ok((a->>'created')::boolean AND a->'item'->>'canonical_identity_key'='[test v6b] device-123','ITEM new explicit normalized key');
 again:=public.get_or_create_inventory_item('[test v6b]   DEVICE-123','台',true);
 PERFORM pg_temp.ok((again->'item'->>'id')::uuid=serial_item AND NOT(again->>'created')::boolean,'ITEM same key reuses');
 PERFORM pg_temp.reject($q$SELECT public.get_or_create_inventory_item('[TEST V6B] Device-123','台',false)$q$,'INVENTORY_ITEM_DEFINITION_CONFLICT','ITEM serial definition conflict');
 PERFORM pg_temp.reject($q$SELECT public.get_or_create_inventory_item('[TEST V6B] Device-123','m',true)$q$,'INVENTORY_ITEM_DEFINITION_CONFLICT','ITEM unit conflict');
 PERFORM pg_temp.reject($q$SELECT public.get_or_create_inventory_item('MC4防塵塞','pcs',false)$q$,'AMBIGUOUS_EXISTING_ITEMS','ITEM legacy same-name candidates');
 a:=public.get_or_create_inventory_item(' r800 ','顆',true);
 PERFORM pg_temp.ok(NOT(a->>'created')::boolean AND a->'item'->>'canonical_identity_key' IS NULL,'ITEM exact legacy code reuses without backfill');
 PERFORM pg_temp.reject($q$INSERT INTO public.inventory_items(code,name,unit,category,canonical_identity_key) VALUES('[TEST V6B] direct','test','台','設備維修','[test v6b] direct')$q$,'permission denied','ITEM client direct insert denied');
 PERFORM pg_temp.reject(format('UPDATE public.inventory_items SET canonical_identity_key=''changed'' WHERE id=%L',serial_item),'IDENTITY_IMMUTABLE|permission denied','ITEM key immutable');
 a:=public.get_or_create_inventory_item('[TEST V6B] Cable.123','m',false); plain_item:=(a->'item'->>'id')::uuid;
 PERFORM pg_temp.ok(a->'item'->>'unit'='m' AND NOT(a->'item'->>'requires_serial')::boolean,'ITEM nonserialized unit');
 INSERT INTO public.projects(id,project_name) VALUES(pa,'[TEST V6B] A'),(pb,'[TEST V6B] B');
 PERFORM pg_temp.ok((SELECT count(*)=2 FROM public.projects WHERE id IN(pa,pb) AND deleted_at IS NULL),'PROJECT real projects source');
 INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by,ordered_at,planned_receipt_at) VALUES(batch,pa,'[TEST V6B] Requirement',actor,'2099-03-15','2099-03-16');
 INSERT INTO public.project_materials(id,project_id,batch_id,item_name,specification,quantity,unit,procurement_status,created_by,delivery_destination,inventory_item_id,include_in_purchase_request)
 VALUES(material,pa,batch,'[TEST V6B] Device-123','[TEST V6B] Device-123',20,'台','ORDERED',actor,'SITE',serial_item,false);
 SELECT jsonb_agg('V6B0'||lpad(n::text,4,'0')||'-AA') INTO names FROM generate_series(1,13)n;
 a:=public.create_receiving_arrival(gen_random_uuid(),'2000-01-01',jsonb_build_array(jsonb_build_object('inventory_item_id',serial_item,'quantity',13,'raw_serials',names)),NULL,'[TEST V6B]','2099-03-15');
 receipt:=(a->'lines'->0->>'receipt_id')::uuid;
 SELECT array_agg(inventory_serial_id ORDER BY raw_serial) INTO ids FROM public.receiving_serial_entries WHERE active_receipt_id=receipt;
 result:=public.get_receiving_project_requirements(pa,serial_item);
 PERFORM pg_temp.ok(jsonb_array_length(result)=1 AND (result->0->>'id')::uuid=material,'PROJECT one compatible requirement');
 PERFORM public.route_receiving_inventory(gen_random_uuid(),receipt,'SITE',8,ids[1:8],pa,material,false,'2099-03-16 01:00+08');
 result:=public.get_receiving_project_requirements(pa,serial_item);
 PERFORM pg_temp.ok((result->0->>'received')::numeric=8,'PROJECT received 8');
 req:=gen_random_uuid(); result:=public.route_receiving_inventory(req,receipt,'SITE',3,ids[9:11],pa,material,false,'2099-03-16 02:00+08'); site:=(result->0->>'id')::uuid;
 PERFORM pg_temp.ok(public.route_receiving_inventory(req,receipt,'SITE',3,ids[9:11],pa,material,false,'2099-03-16 02:00+08')=result,'PROJECT handoff retry idempotent');
 result:=public.get_receiving_project_requirements(pa,serial_item);
 PERFORM pg_temp.ok((result->0->>'received')::numeric=11 AND (result->0->>'quantity')::numeric=20,'PROJECT existing 8 + 3 = 11 of 20');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.project_materials WHERE project_id=pa AND inventory_item_id=serial_item),'PROJECT no duplicate material');
 -- Same project_id material/batch/receipt sources used by ProjectMaterials modal.
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.project_materials m JOIN public.project_material_batches b ON b.id=m.batch_id WHERE m.project_id=pa AND m.id=material),'PROJECT modal material query visible');
 PERFORM pg_temp.ok((SELECT sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END)=11 FROM public.material_receipts WHERE project_material_id=material),'PROJECT modal receipt projection 11');
 PERFORM pg_temp.ok((SELECT count(*)=3 FROM public.material_receipts r JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id JOIN public.inventory_transaction_serials ts ON ts.transaction_id=t.id WHERE r.id=site AND r.receipt_location='SITE' AND t.transaction_type='OUT' AND ts.serial_id=ANY(ids[9:11])),'PROJECT exact three serials via SITE OUT');
 PERFORM pg_temp.ok((SELECT count(*)=3 FROM public.inventory_transaction_serials ts JOIN public.material_receipts r ON r.inventory_transaction_id=ts.transaction_id WHERE r.id=site),'PROJECT no foreign batch serial');
 SELECT id INTO alloc FROM public.receiving_inventory_allocations WHERE site_receipt_id=site LIMIT 1;
 PERFORM public.retract_receiving_handoff(gen_random_uuid(),alloc,'[TEST V6B] retract','2099-03-17');
 result:=public.get_receiving_project_requirements(pa,serial_item);
 PERFORM pg_temp.ok((result->0->>'received')::numeric=8,'PROJECT retract restores existing 8');
 PERFORM pg_temp.ok((public.get_receiving_handoff_scope(receipt)->>'available')::numeric=5,'PROJECT retract restores available 5');
 PERFORM pg_temp.ok(EXISTS(SELECT 1 FROM public.project_materials WHERE id=material),'PROJECT requirement remains after retract');
 PERFORM pg_temp.ok(EXISTS(SELECT 1 FROM public.receiving_arrival_lines WHERE receipt_id=receipt AND quantity=13),'PROJECT Receiving persists');
 PERFORM pg_temp.ok(jsonb_array_length(public.get_receiving_project_requirements(pb,serial_item))=0,'PROJECT no existing requirement');
 result:=public.route_receiving_inventory(gen_random_uuid(),receipt,'SITE',3,ids[9:11],pb,NULL,true,'2099-03-18');
 new_material:=(result->0->>'project_material_id')::uuid;
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.project_materials m JOIN public.project_material_batches b ON b.id=m.batch_id WHERE m.id=new_material AND m.project_id=pb AND m.quantity=3 AND m.inventory_item_id=serial_item),'PROJECT new material visible in project source');
 PERFORM pg_temp.ok((SELECT sum(quantity_received)=3 FROM public.material_receipts WHERE project_material_id=new_material AND receipt_location='SITE'),'PROJECT new SITE receipt');
 INSERT INTO public.project_materials(project_id,batch_id,item_name,specification,quantity,unit,procurement_status,created_by,delivery_destination,inventory_item_id,include_in_purchase_request)
 VALUES(pa,batch,'[TEST V6B] Device-123','[TEST V6B] Device-123',5,'台','ORDERED',actor,'SITE',serial_item,false);
 PERFORM pg_temp.ok(jsonb_array_length(public.get_receiving_project_requirements(pa,serial_item))=2,'PROJECT all multiple candidates returned');
 a:=public.create_receiving_arrival(gen_random_uuid(),'2000-01-01',jsonb_build_array(jsonb_build_object('inventory_item_id',plain_item,'quantity',10)),NULL,'[TEST V6B]','2099-03-15'); plain_receipt:=(a->'lines'->0->>'receipt_id')::uuid;
 result:=public.route_receiving_inventory(gen_random_uuid(),plain_receipt,'SITE',3,'{}',pb,NULL,true,'2099-03-16'); site:=(result->0->>'id')::uuid; new_material:=(result->0->>'project_material_id')::uuid;
 PERFORM pg_temp.ok((SELECT sum(quantity_received)=3 FROM public.material_receipts WHERE project_material_id=new_material AND receipt_location='SITE'),'PROJECT nonserialized quantity');
 SELECT id INTO alloc FROM public.receiving_inventory_allocations WHERE site_receipt_id=site LIMIT 1;
 PERFORM public.retract_receiving_handoff(gen_random_uuid(),alloc,'[TEST V6B] plain retract','2099-03-17');
 PERFORM pg_temp.ok((SELECT sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END)=0 FROM public.material_receipts WHERE project_material_id=new_material),'PROJECT new requirement retract leaves 0 history');
 PERFORM pg_temp.ok(EXISTS(SELECT 1 FROM public.project_materials WHERE id=new_material),'PROJECT new requirement never hard deleted');
 PERFORM pg_temp.ok((public.get_receiving_handoff_scope(plain_receipt)->>'available')::numeric=10,'PROJECT nonserial retract restores 10');
 PERFORM pg_temp.reject(format('SELECT public.route_receiving_inventory(gen_random_uuid(),%L,''SITE'',11,''{}'',%L,NULL,true,''2099-03-18'')',plain_receipt,pb),'CAPACITY_CONFLICT','PROJECT quantity bounded by source');
END $$;
RESET ROLE;
DO $$ BEGIN PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.viewer_email'),'role','authenticated')::text,true); END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject($q$SELECT public.get_or_create_inventory_item('[TEST V6B] viewer','台',true)$q$,'active editor','ITEM Viewer denied');
RESET ROLE; SET LOCAL ROLE anon;
SELECT pg_temp.reject($q$SELECT public.get_or_create_inventory_item('[TEST V6B] anon','台',true)$q$,'permission denied','ITEM anon denied');
RESET ROLE;
SELECT count(*) AS assertions,jsonb_agg(label ORDER BY label) AS passed FROM v6b_assertions;
ROLLBACK;
