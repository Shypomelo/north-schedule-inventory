-- Candidate or disposable local V6-A clone only; all fixtures and injections roll back.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_database() NOT IN('receiving_v6a_handoff_20260926','receiving_v6a_handoff_final_20260926') THEN
  IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW')
  THEN RAISE EXCEPTION 'CANDIDATE_OR_DISPOSABLE_LOCAL_ONLY'; END IF;
 END IF;
 PERFORM set_config('test.v6_admin',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
 PERFORM set_config('test.v6_viewer',(SELECT email FROM public.team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v6_admin'),'role','authenticated')::text,true);
END $$;
CREATE TEMP TABLE v6_assertions(label text);
GRANT ALL ON v6_assertions TO authenticated,anon;
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
 INSERT INTO v6_assertions VALUES(label);
END $$;
CREATE FUNCTION pg_temp.reject(q text,pattern text,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN
  IF SQLERRM !~ pattern THEN RAISE EXCEPTION 'FAIL: % unexpected % [%]',label,SQLERRM,SQLSTATE; END IF;
  PERFORM pg_temp.ok(true,label); RETURN;
 END; RAISE EXCEPTION 'FAIL: % did not reject',label;
END $$;
CREATE FUNCTION pg_temp.id(n integer) RETURNS uuid LANGUAGE sql AS $$ SELECT ('86000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
INSERT INTO public.projects(id,project_name) VALUES(pg_temp.id(1),'[TEST V6-A] A'),(pg_temp.id(2),'[TEST V6-A] B');
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) VALUES
 (pg_temp.id(3),'[TEST V6-A] serial','[TEST V6-A] serial','台','設備維修',true,true),
 (pg_temp.id(4),'[TEST V6-A] quantity','[TEST V6-A] quantity','m','一般',false,false);
INSERT INTO public.schedule_tasks(id,title,task_date,task_type,status,project_id,work_group_id)
 VALUES(pg_temp.id(5),'[TEST V6-A] maintenance',current_date,'維修','未完成',pg_temp.id(1)::text,(SELECT id FROM public.work_groups LIMIT 1));
CREATE FUNCTION pg_temp.arrival(qty numeric,names jsonb DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
 SELECT (public.create_receiving_arrival(gen_random_uuid(),'2000-01-01',jsonb_build_array(jsonb_build_object(
 'inventory_item_id',pg_temp.id(CASE WHEN names IS NULL THEN 4 ELSE 3 END),'quantity',qty,'raw_serials',COALESCE(names,'[]'))),NULL,'[TEST V6-A]','2099-03-15')->'lines'->0->>'receipt_id')::uuid
$$;
CREATE FUNCTION pg_temp.route(receipt uuid,kind text,qty numeric,serials uuid[] DEFAULT '{}',req uuid DEFAULT gen_random_uuid()) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.route_receiving_inventory(req,receipt,kind,qty,serials,pg_temp.id(1),NULL,true,'2099-03-16','[TEST V6-A]')
$$;
CREATE FUNCTION pg_temp.balance(i integer) RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT app_private.inventory_effective_balance(pg_temp.id(i))
$$;
CREATE FUNCTION pg_temp.scope(receipt uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.get_receiving_handoff_scope(receipt) $$;
CREATE FUNCTION pg_temp.alloc(receipt uuid,kind text) RETURNS uuid LANGUAGE sql AS $$
 SELECT id FROM public.receiving_inventory_allocations WHERE office_receipt_id=receipt AND route_type=kind AND cancelled_at IS NULL ORDER BY id LIMIT 1
$$;
CREATE FUNCTION pg_temp.retract(alloc uuid,req uuid DEFAULT gen_random_uuid()) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.retract_receiving_handoff(req,alloc,'[TEST V6-A] retract','2099-03-17')
$$;
CREATE FUNCTION pg_temp.stock() RETURNS text LANGUAGE sql AS $$
 SELECT md5(jsonb_build_object('tx',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.inventory_transactions t),
 'serials',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.inventory_serials s),
 'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.material_receipts r))::text)
$$;
CREATE FUNCTION pg_temp.facts(receipt uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('arrival',to_jsonb(a),'line',to_jsonb(l),'receipt',to_jsonb(r)) FROM public.material_receipts r
 JOIN public.receiving_arrival_lines l ON l.id=r.arrival_line_id JOIN public.receiving_arrivals a ON a.id=l.arrival_id WHERE r.id=receipt
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;

SET LOCAL ROLE authenticated;
DO $$
DECLARE r uuid; r2 uuid; ids uuid[]; foreign_serial uuid; se jsonb; site jsonb; result jsonb; req uuid; alloc uuid; other_alloc uuid; facts jsonb; ledger text; before_n bigint; after_n bigint;
BEGIN
 r:=pg_temp.arrival(8,'["V6S00001-AA","V6S00002-AA","V6S00003-AA","V6S00004-AA","V6S00005-AA","V6S00006-AA","V6S00007-AA","V6S00008-AA"]');
 facts:=pg_temp.facts(r);
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=8,'ARRIVAL-RESOLVE-1 receipt scope');
 PERFORM pg_temp.ok((public.get_receiving_source_details('ARRIVAL',(SELECT arrival_line_id FROM public.material_receipts WHERE id=r))->'scope'->>'receipt_id')::uuid=r,'ARRIVAL-RESOLVE-1 source details');
 SELECT array_agg(inventory_serial_id ORDER BY raw_serial) INTO ids FROM public.receiving_serial_entries WHERE active_receipt_id=r;
 r2:=pg_temp.arrival(1,'["V6S00009-AA"]');
 SELECT inventory_serial_id INTO foreign_serial FROM public.receiving_serial_entries WHERE active_receipt_id=r2;
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(%L,''SE'',1,ARRAY[%L]::uuid[])',r,foreign_serial),'SCOPE_CONFLICT','SCOPE-1 another arrival serial');
 ledger:=pg_temp.stock(); req:=gen_random_uuid();
 se:=pg_temp.route(r,'SE',2,ids[1:2],req);
 PERFORM pg_temp.ok(pg_temp.stock()=ledger,'SE-SERIAL-1 no Inventory/receipt write');
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=6 AND (pg_temp.scope(r)->>'se')::numeric=2,'SE-SERIAL-1 8 minus 2 = 6');
 PERFORM pg_temp.ok((SELECT count(*)=2 FROM public.inventory_serials WHERE id=ANY(ids[1:2]) AND status='在庫'),'SE-SERIAL-1 serials remain in stock');
 SELECT count(*) INTO before_n FROM public.activity_logs;
 PERFORM pg_temp.ok(pg_temp.route(r,'SE',2,ids[1:2],req)=se,'IDEMPOTENCY SE same result');
 SELECT count(*) INTO after_n FROM public.activity_logs;
 PERFORM pg_temp.ok(before_n=after_n,'IDEMPOTENCY SE no duplicate audit');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(%L,''SE'',1,ARRAY[%L]::uuid[],%L)',r,ids[3],req),'Request conflict','IDEMPOTENCY SE changed payload');
 PERFORM pg_temp.ok(pg_temp.facts(r)=facts,'SE-SERIAL-1 Arrival facts unchanged');
 req:=gen_random_uuid(); site:=pg_temp.route(r,'SITE',3,ids[3:5],req);
 PERFORM pg_temp.ok((SELECT transaction_type='OUT' AND quantity=3 FROM public.inventory_transactions WHERE id=(site->0->>'inventory_transaction_id')::uuid),'PROJECT-1 exact OUT');
 PERFORM pg_temp.ok((SELECT receipt_location='SITE' AND inventory_linked FROM public.material_receipts WHERE id=(site->0->>'id')::uuid),'PROJECT-1 SITE receipt');
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=3 AND (pg_temp.scope(r)->>'site')::numeric=3,'PROJECT-1 available 3 / SE 2 / SITE 3');
 PERFORM pg_temp.ok(pg_temp.facts(r)=facts,'PROJECT-1 Arrival persists unchanged');
 SELECT count(*) INTO before_n FROM public.activity_logs;
 PERFORM pg_temp.ok(pg_temp.route(r,'SITE',3,ids[3:5],req)=site,'IDEMPOTENCY PROJECT same result');
 PERFORM pg_temp.ok(before_n=(SELECT count(*) FROM public.activity_logs),'IDEMPOTENCY PROJECT no duplicate audit');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(%L,''SITE'',1,ARRAY[%L]::uuid[],%L)',r,ids[6],req),'Request conflict','IDEMPOTENCY PROJECT payload conflict');
 alloc:=pg_temp.alloc(r,'SITE'); req:=gen_random_uuid();
 result:=pg_temp.retract(alloc,req);
 PERFORM pg_temp.ok((SELECT is_voided FROM public.inventory_transactions WHERE id=(site->0->>'inventory_transaction_id')::uuid),'RETRACT-PROJECT-1 OUT voided canonically');
 PERFORM pg_temp.ok((SELECT quantity_received=3 AND event_type='REVERSAL' AND receipt_location='SITE' FROM public.material_receipts WHERE id=(result->>'reversal_receipt_id')::uuid),'RETRACT-PROJECT-1 SITE reversal');
 PERFORM pg_temp.ok((SELECT procurement_status='ORDERED' AND received_at IS NULL FROM public.project_materials WHERE id=(site->0->>'project_material_id')::uuid),'RETRACT-PROJECT-1 Project projection');
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=6,'RETRACT-PROJECT-1 restores all 3 serials');
 PERFORM pg_temp.ok(pg_temp.retract(alloc,req)=result,'IDEMPOTENCY PROJECT retract same result');
 PERFORM pg_temp.reject(format('SELECT public.retract_receiving_handoff(%L,%L,''different'',''2099-03-17'')',req,alloc),'Request conflict','IDEMPOTENCY PROJECT retract conflict');
 PERFORM pg_temp.ok((SELECT count(*)=3 FROM public.receiving_inventory_allocations WHERE site_receipt_id=(site->0->>'id')::uuid AND cancelled_at IS NOT NULL AND reversal_receipt_id IS NOT NULL),'HISTORY all project allocations retained');
 alloc:=pg_temp.alloc(r,'SE'); req:=gen_random_uuid(); result:=pg_temp.retract(alloc,req);
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=7,'RETRACT-SE-1 restored exact serial');
 PERFORM pg_temp.ok(pg_temp.retract(alloc,req)=result,'IDEMPOTENCY SE retract same result');
 PERFORM pg_temp.reject(format('SELECT public.retract_receiving_handoff(%L,%L,''different'',''2099-03-17'')',req,alloc),'Request conflict','IDEMPOTENCY SE retract conflict');
 PERFORM pg_temp.ok(pg_temp.facts(r)=facts,'RETRACT original Arrival receipt facts retained');
 PERFORM set_config('test.v6_serial_receipt',r::text,true);
END $$;

DO $$
DECLARE r uuid; r2 uuid; alloc uuid; new_alloc uuid; seid uuid; req uuid; result jsonb; facts jsonb; ledger text; version timestamptz; site jsonb;
BEGIN
 r:=pg_temp.arrival(50); r2:=pg_temp.arrival(100); facts:=pg_temp.facts(r); ledger:=pg_temp.stock();
 result:=pg_temp.route(r,'SE',10); seid:=(result->0->>'id')::uuid; alloc:=pg_temp.alloc(r,'SE');
 PERFORM pg_temp.ok(pg_temp.stock()=ledger,'SE-NONSERIAL-1 no OUT or receipt mutation');
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=40,'SE-NONSERIAL-1 50 minus 10 = 40');
 PERFORM pg_temp.ok((SELECT inventory_serial_id IS NULL AND quantity=10 FROM public.se_supply_records WHERE id=seid),'SE-NONSERIAL-1 quantity reservation');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(%L,''SE'',41)',r),'CAPACITY_CONFLICT','SE-NONSERIAL-2 over-allocation rejects');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(%L,''SITE'',41)',r),'CAPACITY_CONFLICT','SCOPE-2 cannot take another Arrival quantity');
 PERFORM pg_temp.reject(format('SELECT public.write_inventory_transaction_atomic(''CREATE'',%L::jsonb)',jsonb_build_object('item_id',pg_temp.id(4),'transaction_type','OUT','quantity',141,'unit','m','project_id',pg_temp.id(1),'transaction_date','2099-03-16')::text),'RESERVED_QUANTITY_CONFLICT','SE-NONSERIAL canonical OUT cannot consume reserved quantity');
 SELECT updated_at INTO version FROM public.se_supply_records WHERE id=seid; req:=gen_random_uuid();
 result:=public.change_receiving_se_handoff(req,alloc,15,NULL,pg_temp.id(2),version); new_alloc:=(result->>'id')::uuid;
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=35,'MODIFY nonserial reservation quantity');
 PERFORM pg_temp.ok((SELECT cancelled_at IS NOT NULL AND quantity=10 FROM public.receiving_inventory_allocations WHERE id=alloc),'HISTORY original quantity immutable');
 PERFORM pg_temp.ok((SELECT supersedes_allocation_id=alloc AND quantity=15 FROM public.receiving_inventory_allocations WHERE id=new_alloc),'HISTORY explicit replacement provenance');
 PERFORM pg_temp.ok(public.change_receiving_se_handoff(req,alloc,15,NULL,pg_temp.id(2),version)=result,'IDEMPOTENCY modify retry');
 PERFORM pg_temp.reject(format('SELECT public.change_receiving_se_handoff(%L,%L,60,NULL,%L,%L)',gen_random_uuid(),new_alloc,pg_temp.id(2),(result->'se_record'->>'updated_at')::timestamptz),'CAPACITY_CONFLICT','MODIFY cannot exceed source capacity');
 PERFORM public.change_receiving_se_project(seid,pg_temp.id(1),(result->'se_record'->>'updated_at')::timestamptz);
 PERFORM pg_temp.ok((SELECT project_id=pg_temp.id(1) FROM public.se_supply_records WHERE id=seid),'MODIFY existing project command nonserial');
 PERFORM public.cancel_se_inventory_reservation(seid,(SELECT updated_at FROM public.se_supply_records WHERE id=seid));
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=50,'RETRACT-SE nonserial existing cancel command');
 site:=pg_temp.route(r,'SITE',20); alloc:=pg_temp.alloc(r,'SITE');
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=30 AND (SELECT quantity=20 AND transaction_type='OUT' FROM public.inventory_transactions WHERE id=(site->0->>'inventory_transaction_id')::uuid),'PROJECT-2 quantity OUT + scope');
 PERFORM pg_temp.retract(alloc);
 PERFORM pg_temp.ok((pg_temp.scope(r)->>'available')::numeric=50,'RETRACT-PROJECT nonserial restored');
 PERFORM pg_temp.ok(pg_temp.facts(r)=facts,'NONSERIAL original Arrival unchanged after all commands');
 PERFORM set_config('test.v6_plain_receipt',r::text,true);
END $$;

DO $$
DECLARE r uuid:=current_setting('test.v6_serial_receipt')::uuid; alloc public.receiving_inventory_allocations; new_alloc uuid; rse public.se_supply_records;
 serial uuid; foreign_serial uuid; candidate jsonb; result jsonb; facts jsonb:=pg_temp.facts(r);
BEGIN
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE office_receipt_id=r AND route_type='SE' AND cancelled_at IS NULL;
 SELECT * INTO rse FROM public.se_supply_records WHERE id=alloc.se_supply_record_id;
 SELECT value::uuid INTO serial FROM jsonb_array_elements_text(pg_temp.scope(r)->'available_serial_ids') LIMIT 1;
 SELECT e.inventory_serial_id INTO foreign_serial FROM public.receiving_serial_entries e WHERE e.raw_serial='V6S00009-AA';
 PERFORM pg_temp.reject(format('SELECT public.change_se_inventory_reservation(%L,%L,%L)',rse.id,foreign_serial,rse.updated_at),'SCOPE_CONFLICT','MODIFY serial cannot leave Arrival scope');
 result:=public.change_se_inventory_reservation(rse.id,serial,rse.updated_at);
 SELECT id INTO new_alloc FROM public.receiving_inventory_allocations WHERE se_supply_record_id=rse.id AND cancelled_at IS NULL;
 PERFORM pg_temp.ok((SELECT supersedes_allocation_id=alloc.id AND inventory_serial_id=serial FROM public.receiving_inventory_allocations WHERE id=new_alloc),'MODIFY exact serial replacement provenance');
 PERFORM pg_temp.reject(format('SELECT public.change_receiving_se_project(%L,%L,%L)',rse.id,pg_temp.id(2),rse.updated_at),'VERSION_CONFLICT','MODIFY stale version');
 PERFORM pg_temp.reject(format('UPDATE public.se_supply_records SET quantity=2 WHERE id=%L',rse.id),'供貨追蹤|CONTROLLED_EDIT|permission denied','SECURITY no direct reserved quantity edit');
 PERFORM pg_temp.reject(format('UPDATE public.se_supply_records SET project_id=%L WHERE id=%L',pg_temp.id(2),rse.id),'CONTROLLED_EDIT|permission denied','SECURITY no direct reserved project edit');
 UPDATE public.se_supply_records SET notes='[TEST V6-A] downstream notes',expected_delivery_at='2099-04-01' WHERE id=rse.id;
 PERFORM pg_temp.ok(pg_temp.facts(r)=facts,'HANDOFF no downstream metadata copy to Arrival');
 SELECT x INTO candidate FROM jsonb_array_elements(public.search_maintenance_equipment(pg_temp.id(5)))x WHERE (x->>'se_supply_record_id')::uuid=rse.id;
 result:=public.register_maintenance_equipment_replacement(gen_random_uuid(),pg_temp.id(5),serial,rse.id,now(),'[TEST V6-A]',candidate->>'version',false);
 PERFORM pg_temp.ok((SELECT replace_date IS NOT NULL FROM public.se_supply_records WHERE id=rse.id),'RETRACT-SE-2 real Maintenance use');
 PERFORM pg_temp.reject(format('SELECT pg_temp.retract(%L)',new_alloc),'DOWNSTREAM_CORRECTION_REQUIRED','RETRACT-SE-2 used rejects');
 PERFORM pg_temp.reject(format('SELECT public.change_receiving_se_project(%L,%L,%L)',rse.id,pg_temp.id(2),(SELECT updated_at FROM public.se_supply_records WHERE id=rse.id)),'DOWNSTREAM_CORRECTION_REQUIRED','MODIFY used requires correction');
 PERFORM pg_temp.ok(EXISTS(SELECT 1 FROM jsonb_array_elements(pg_temp.scope(r)->'allocations')x WHERE (x->>'id')::uuid=new_alloc AND x->>'state'='USED'),'HISTORY derives USED');
 PERFORM pg_temp.ok(pg_temp.facts(r)=facts,'USED preserves original Arrival');
END $$;

DO $$
DECLARE r uuid; serial uuid; site jsonb; alloc uuid; snapshot text; result jsonb;
BEGIN
 r:=pg_temp.arrival(1,'["V6S00010-AA"]');
 SELECT inventory_serial_id INTO serial FROM public.receiving_serial_entries WHERE active_receipt_id=r;
 site:=pg_temp.route(r,'SITE',1,ARRAY[serial]); alloc:=pg_temp.alloc(r,'SITE');
 result:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(3),'transaction_type','RETURN','quantity',1,'unit','台','project_id',pg_temp.id(1),'transaction_date','2099-03-17'),jsonb_build_array('V6S00010-AA'));
 snapshot:=pg_temp.stock();
 PERFORM pg_temp.reject(format('SELECT pg_temp.retract(%L)',alloc),'DOWNSTREAM_CORRECTION_REQUIRED','RETRACT-PROJECT-2 later serial RETURN rejects');
 PERFORM pg_temp.ok(pg_temp.stock()=snapshot,'RETRACT-PROJECT-2 no partial correction');
 r:=pg_temp.arrival(10); site:=pg_temp.route(r,'SITE',5); alloc:=pg_temp.alloc(r,'SITE');
 PERFORM public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(4),'transaction_type','OUT','quantity',1,'unit','m','project_id',pg_temp.id(1),'transaction_date','2099-03-17'));
 PERFORM pg_temp.reject(format('SELECT pg_temp.retract(%L)',alloc),'DOWNSTREAM_CORRECTION_REQUIRED','RETRACT-PROJECT-2 later nonserial use rejects');
 r:=pg_temp.arrival(1,'["V6S00011-AA"]'); SELECT inventory_serial_id INTO serial FROM public.receiving_serial_entries WHERE active_receipt_id=r;
 site:=pg_temp.route(r,'SITE',1,ARRAY[serial]);
 PERFORM set_config('test.v6_closed_allocation',pg_temp.alloc(r,'SITE')::text,true);
 PERFORM set_config('test.v6_closed_receipt',r::text,true);
END $$;
RESET ROLE;
INSERT INTO public.inventory_monthly_closings(year,month,status,closed_by,closed_at,notes) VALUES('2099','03','CLOSED','[TEST V6-A]',now(),'[TEST V6-A]');
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject(format('SELECT pg_temp.retract(%L)',current_setting('test.v6_closed_allocation')),'DOWNSTREAM_CORRECTION_REQUIRED','RETRACT-PROJECT-2 closed month rejects');
SELECT pg_temp.ok((SELECT cancelled_at IS NULL FROM public.receiving_inventory_allocations WHERE id=current_setting('test.v6_closed_allocation')::uuid),'closed-month rejection preserves allocation');

-- Public mutations validate actor; private entry points and allocation CRUD are closed.
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v6_viewer'),'role','authenticated')::text,true);
SELECT pg_temp.reject(format('SELECT pg_temp.route(%L,''SE'',1)',current_setting('test.v6_plain_receipt')),'active editor','SECURITY Viewer handoff deny');
SELECT pg_temp.reject(format('SELECT pg_temp.retract(%L)',current_setting('test.v6_closed_allocation')),'active editor','SECURITY Viewer retract deny');
SELECT pg_temp.reject(format('SELECT public.change_receiving_se_handoff(%L,%L,1,NULL,NULL,now())',gen_random_uuid(),current_setting('test.v6_closed_allocation')),'active editor','SECURITY Viewer modify deny');
SELECT pg_temp.ok(public.get_receiving_handoff_scope(current_setting('test.v6_plain_receipt')::uuid) IS NOT NULL,'SECURITY active Viewer may read scope');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v6_admin'),'role','authenticated')::text,true);
SELECT pg_temp.reject('DELETE FROM public.receiving_inventory_allocations','permission denied','SECURITY allocation delete denied');
SELECT pg_temp.reject('UPDATE public.receiving_inventory_allocations SET cancelled_at=now()','permission denied','SECURITY allocation update denied');
SELECT pg_temp.reject('INSERT INTO public.receiving_inventory_allocations DEFAULT VALUES','permission denied','SECURITY allocation insert denied');
SELECT pg_temp.reject('SELECT app_private.receiving_reserved_quantity(pg_temp.id(4))','permission denied','SECURITY private helper denied');
SELECT pg_temp.reject('INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),NULL,ARRAY[]::uuid[])','permission denied','SECURITY private capability denied');
SELECT set_config('app.receiving_handoff','true',true);
SELECT pg_temp.reject(format('UPDATE public.se_supply_records SET cancelled_at=now() WHERE id=(SELECT se_supply_record_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=%L AND route_type=''SE'' AND cancelled_at IS NULL LIMIT 1)',current_setting('test.v6_serial_receipt')),'更正|CONTROLLED_EDIT|permission denied','SECURITY forged GUC does not grant cancellation');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.reject(format('SELECT public.get_receiving_handoff_scope(%L)',current_setting('test.v6_plain_receipt')),'permission denied','SECURITY anon read deny');
SELECT pg_temp.reject(format('SELECT pg_temp.retract(%L)',current_setting('test.v6_closed_allocation')),'permission denied','SECURITY anon retract deny');
RESET ROLE;

-- Legacy PROJECT_MATERIAL has a real OFFICE source, not an ARRIVAL impersonation.
INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by,ordered_at) VALUES(pg_temp.id(6),pg_temp.id(1),'[TEST V6-A] legacy',(app_private.inventory_actor()).id,now());
INSERT INTO public.project_materials(id,project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES(pg_temp.id(7),pg_temp.id(1),pg_temp.id(6),'[TEST V6-A] legacy',10,'m',(app_private.inventory_actor()).id,pg_temp.id(4),'OFFICE');
SET LOCAL ROLE authenticated;
DO $$
DECLARE receipt jsonb; result jsonb; rid uuid; alloc uuid; req uuid;
BEGIN
 receipt:=public.confirm_receiving_into_inventory(gen_random_uuid(),'PROJECT_MATERIAL',pg_temp.id(7),pg_temp.id(4),10,'{}','2099-05-15','[TEST V6-A]');rid:=(receipt->>'id')::uuid;
 PERFORM pg_temp.ok((pg_temp.scope(rid)->>'available')::numeric=10,'ARRIVAL-RESOLVE-2 legacy PROJECT source');
 PERFORM pg_temp.route(rid,'SE',4); alloc:=pg_temp.alloc(rid,'SE');
 PERFORM pg_temp.ok((pg_temp.scope(rid)->>'available')::numeric=6,'ARRIVAL-RESOLVE-2 legacy PROJECT handoff');
 PERFORM pg_temp.reject(format('SELECT public.correct_receiving_inventory(%L,%L,10,''{}'',''2099-05-16'',''test'')',gen_random_uuid(),rid),'DOWNSTREAM_CORRECTION_REQUIRED','CORRECTION legacy receipt cannot reverse reserved quantity');
 req:=gen_random_uuid();result:=public.retract_receiving_handoff(req,alloc,'[TEST V6-A] default time');
 PERFORM pg_temp.ok(public.retract_receiving_handoff(req,alloc,'[TEST V6-A] default time')=result,'IDEMPOTENCY omitted retract time is stable');
END $$;
RESET ROLE;

-- Inject failure after all domain effects, proving each command is one transaction.
CREATE FUNCTION pg_temp.fail_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.action IN('ROUTE_RECEIVING','RETRACT_RECEIVING_HANDOFF','CHANGE_RECEIVING_SE_HANDOFF')
 AND current_setting('test.v6_fail_audit',true)='on' THEN RAISE EXCEPTION 'INJECTED_HANDOFF_AUDIT_FAILURE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER test_v6_handoff_audit BEFORE INSERT ON public.activity_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_handoff_audit();
SET LOCAL ROLE authenticated;
DO $$
DECLARE r uuid; ids uuid[]; ledger text; facts jsonb; se_count bigint; alloc_count bigint; audit_count bigint;
 result jsonb; alloc uuid; se public.se_supply_records; req uuid;
BEGIN
 -- Use May for new Inventory effects because March was deliberately closed above.
 result:=public.create_receiving_arrival(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object('inventory_item_id',pg_temp.id(3),'quantity',2,'raw_serials',jsonb_build_array('V6S00012-AA','V6S00013-AA'))),NULL,'[TEST V6-A]','2099-05-15');
 r:=(result->'lines'->0->>'receipt_id')::uuid;
 SELECT array_agg(inventory_serial_id ORDER BY raw_serial) INTO ids FROM public.receiving_serial_entries WHERE active_receipt_id=r;
 ledger:=pg_temp.stock();facts:=pg_temp.facts(r);SELECT count(*) INTO se_count FROM public.se_supply_records;SELECT count(*) INTO alloc_count FROM public.receiving_inventory_allocations;SELECT count(*) INTO audit_count FROM public.activity_logs;
 PERFORM set_config('test.v6_fail_audit','on',true);
 PERFORM pg_temp.reject(format('SELECT public.route_receiving_inventory(%L,%L,''SE'',1,ARRAY[%L]::uuid[],%L,NULL,true,''2099-05-16'',''test'')',gen_random_uuid(),r,ids[1],pg_temp.id(1)),'INJECTED_HANDOFF_AUDIT_FAILURE','ATOMIC SE handoff audit failure');
 PERFORM pg_temp.reject(format('SELECT public.route_receiving_inventory(%L,%L,''SITE'',1,ARRAY[%L]::uuid[],%L,NULL,true,''2099-05-16'',''test'')',gen_random_uuid(),r,ids[1],pg_temp.id(1)),'INJECTED_HANDOFF_AUDIT_FAILURE','ATOMIC Project handoff audit failure');
 PERFORM pg_temp.ok(pg_temp.stock()=ledger AND pg_temp.facts(r)=facts AND se_count=(SELECT count(*) FROM public.se_supply_records) AND alloc_count=(SELECT count(*) FROM public.receiving_inventory_allocations) AND audit_count=(SELECT count(*) FROM public.activity_logs),'ATOMIC no orphan OUT/SITE/SE/allocation/audit');
 PERFORM set_config('test.v6_fail_audit','off',true);
 result:=public.route_receiving_inventory(gen_random_uuid(),r,'SE',1,ARRAY[ids[1]],pg_temp.id(1),NULL,true,'2099-05-16','test');
 alloc:=pg_temp.alloc(r,'SE');SELECT * INTO se FROM public.se_supply_records WHERE id=(result->0->>'id')::uuid;
 PERFORM set_config('test.v6_fail_audit','on',true);
 PERFORM pg_temp.reject(format('SELECT public.retract_receiving_handoff(%L,%L,''test'',''2099-05-17'')',gen_random_uuid(),alloc),'INJECTED_HANDOFF_AUDIT_FAILURE','ATOMIC SE retract audit failure');
 PERFORM pg_temp.reject(format('SELECT public.change_receiving_se_handoff(%L,%L,1,%L,%L,%L)',gen_random_uuid(),alloc,ids[2],pg_temp.id(2),se.updated_at),'INJECTED_HANDOFF_AUDIT_FAILURE','ATOMIC SE modify audit failure');
 PERFORM pg_temp.ok((SELECT cancelled_at IS NULL AND inventory_serial_id=ids[1] FROM public.receiving_inventory_allocations WHERE id=alloc) AND (SELECT cancelled_at IS NULL AND inventory_serial_id=ids[1] AND updated_at=se.updated_at FROM public.se_supply_records WHERE id=se.id),'ATOMIC SE original state restored');
 PERFORM set_config('test.v6_fail_audit','off',true);
 result:=public.route_receiving_inventory(gen_random_uuid(),r,'SITE',1,ARRAY[ids[2]],pg_temp.id(1),NULL,true,'2099-05-16','test');
 alloc:=pg_temp.alloc(r,'SITE');ledger:=pg_temp.stock();
 PERFORM set_config('test.v6_fail_audit','on',true);
 PERFORM pg_temp.reject(format('SELECT public.retract_receiving_handoff(%L,%L,''test'',''2099-05-17'')',gen_random_uuid(),alloc),'INJECTED_HANDOFF_AUDIT_FAILURE','ATOMIC Project retract audit failure');
 PERFORM pg_temp.ok(pg_temp.stock()=ledger AND (SELECT cancelled_at IS NULL FROM public.receiving_inventory_allocations WHERE id=alloc),'ATOMIC Project OUT/SITE/allocation restored');
 PERFORM set_config('test.v6_fail_audit','off',true);
END $$;
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*)=0 FROM app_private.inventory_routing_context),'no private context leftovers');
SELECT pg_temp.ok((SELECT count(*)=0 FROM public.receiving_inventory_allocations a JOIN public.material_receipts r ON r.id=a.office_receipt_id WHERE a.cancelled_at IS NULL AND r.receipt_location<>'OFFICE'),'no orphan allocations');
SELECT count(*) AS assertions_passed FROM v6_assertions;
ROLLBACK;
