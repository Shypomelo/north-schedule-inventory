-- Candidate-only test transaction. All fixtures, audit, and injection trigger roll back.
BEGIN;
SET LOCAL statement_timeout='60s';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW') THEN RAISE EXCEPTION 'CANDIDATE ONLY'; END IF; END $$;
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.reject(q text,label text,pattern text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN
  IF pattern IS NOT NULL AND SQLERRM !~ pattern THEN RAISE EXCEPTION 'FAIL % unexpected %',label,SQLERRM; END IF; RETURN;
 END; RAISE EXCEPTION 'FAIL % not rejected',label;
END $$;
CREATE FUNCTION pg_temp.id(n integer) RETURNS uuid LANGUAGE sql AS $$ SELECT ('88000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
SELECT set_config('test.v5_admin',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.v5_viewer',(SELECT email FROM public.team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.v5_project',(SELECT id::text FROM public.projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.v5_other_project',(SELECT id::text FROM public.projects WHERE deleted_at IS NULL AND id<>current_setting('test.v5_project')::uuid ORDER BY id LIMIT 1),true);
CREATE TEMP TABLE v5_before AS SELECT
 (SELECT count(*) FROM public.material_receipts) receipts,
 -- LEGACY-1 compares legacy receipts only, including when V5 arrivals pre-exist.
 (SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'')) FROM public.material_receipts r WHERE arrival_line_id IS NULL) receipt_hash;
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment)
 VALUES(pg_temp.id(1),'[TEST V5A] plain','[TEST V5A] plain','個','一般',false,false),
 (pg_temp.id(2),'[TEST V5A] serial','[TEST V5A] serial','台','設備維修',true,true),
 (pg_temp.id(3),'[TEST V5A] other','[TEST V5A] other','台','設備維修',true,true);
CREATE FUNCTION pg_temp.make(n integer,item integer,qty numeric,serials jsonb DEFAULT '[]',project uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$ SELECT public.create_receiving_arrival(pg_temp.id(n),'2000-01-01',jsonb_build_array(jsonb_build_object('inventory_item_id',CASE WHEN item IS NULL THEN NULL ELSE pg_temp.id(item) END,'quantity',qty,'raw_serials',serials)),project,'[TEST V5A]','2099-03-15') $$;
CREATE FUNCTION pg_temp.pending(n integer,item integer,qty numeric,project uuid DEFAULT NULL,serials jsonb DEFAULT '[]')
RETURNS uuid LANGUAGE sql AS $$ SELECT (public.create_office_equipment_arrival(pg_temp.id(n),pg_temp.id(item),qty,now(),project,'[TEST V5A]',serials)->>'id')::uuid $$;
CREATE FUNCTION pg_temp.line(r jsonb) RETURNS uuid LANGUAGE sql AS $$ SELECT (r->'lines'->0->>'id')::uuid $$;
CREATE FUNCTION pg_temp.entries(line_id uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT COALESCE(array_agg(id ORDER BY id),'{}') FROM public.receiving_serial_entries WHERE arrival_line_id=line_id $$;
CREATE FUNCTION pg_temp.inject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.action='ARRIVAL_CREATED' AND current_setting('test.v5_fail',true)='yes' THEN RAISE EXCEPTION 'V5_INJECTED_AFTER_POSTING'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER v5a_test_inject BEFORE INSERT ON public.activity_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.inject();
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
GRANT SELECT ON v5_before TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v5_admin'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE r jsonb; r2 jsonb; u jsonb; result jsonb; first_post jsonb; source uuid; source2 uuid; serial_id uuid; tx jsonb;
 l uuid; before_tx bigint; before_receipts bigint; before_serials bigint; before_arrivals bigint; before_audit bigint; before_entries bigint; before_lines bigint;
BEGIN
 r:=pg_temp.make(10,1,8);
 PERFORM pg_temp.ok((SELECT resolution_state='POSTED' AND quantity=8 FROM public.receiving_arrival_lines WHERE id=pg_temp.line(r)),'ARRIVAL-1 known nonserial');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.material_receipts WHERE arrival_line_id=pg_temp.line(r) AND source_type='ARRIVAL' AND project_material_id IS NULL AND se_supply_record_id IS NULL AND receipt_location='OFFICE'),'ARRIVAL-1 no fake pending');
 PERFORM pg_temp.ok((SELECT t.quantity=8 AND t.transaction_type='IN' AND t.transaction_date='2099-03-15' FROM public.material_receipts m JOIN public.inventory_transactions t ON t.id=m.inventory_transaction_id WHERE m.arrival_line_id=pg_temp.line(r)),'IN and explicit posting date');
 PERFORM pg_temp.ok(r->'arrival'->>'actual_received_at' LIKE '2000-01-01%','actual time separate from posting date');
 PERFORM pg_temp.ok(pg_temp.make(10,1,8)=r,'ARRIVAL-6 same request retry');
 PERFORM pg_temp.reject('SELECT pg_temp.make(10,1,9)','ARRIVAL-7 payload conflict','Request conflict');

 r2:=pg_temp.make(11,2,1,'["V5A00001-AA"]');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.inventory_serials WHERE serial_number='V5A00001-AA'),'ARRIVAL-2 SERIAL-1');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.material_receipt_serials rs JOIN public.receiving_serial_entries e ON e.id=rs.entry_id WHERE e.arrival_line_id=pg_temp.line(r2)),'receipt serial link');
 u:=pg_temp.make(12,NULL,1,'["7515CA50-A4"]');
 l:=pg_temp.line(u);
 SELECT count(*) INTO before_tx FROM public.inventory_transactions;
 PERFORM pg_temp.ok((SELECT resolution_state='UNRESOLVED' AND inventory_item_id IS NULL AND receipt_id IS NULL FROM public.receiving_arrival_lines WHERE id=l),'ARRIVAL-3/4 persisted unknown');
 PERFORM pg_temp.ok((SELECT inventory_serial_id IS NULL AND inventory_item_id IS NULL AND active_receipt_id IS NULL FROM public.receiving_serial_entries WHERE arrival_line_id=l),'unknown has no canonical ownership');
 PERFORM pg_temp.ok(NOT EXISTS(SELECT 1 FROM public.inventory_serials WHERE normalized_full='7515CA50-A4'),'unknown no canonical serial');
 first_post:=public.complete_receiving_arrival_line(pg_temp.id(13),l,pg_temp.id(2),'2099-03-15');
 PERFORM pg_temp.ok((SELECT count(*)=before_tx+1 FROM public.inventory_transactions),'ARRIVAL-5 first posting');
 PERFORM pg_temp.ok(public.complete_receiving_arrival_line(pg_temp.id(13),l,pg_temp.id(2),'2099-03-15')=first_post,'complete retry same result');
 PERFORM pg_temp.reject(format('SELECT public.complete_receiving_arrival_line(%L,%L,%L,%L)',pg_temp.id(14),l,pg_temp.id(2),'2099-03-15'),'no second posting','ALREADY_POSTED');
 PERFORM pg_temp.reject(format('SELECT public.complete_receiving_arrival_line(%L,%L,%L,%L)',pg_temp.id(13),l,pg_temp.id(3),'2099-03-15'),'complete payload conflict','Request conflict');

 PERFORM pg_temp.make(15,2,2,'["V5A000001-AA","SE1234-V5A000002-AA"]');
 PERFORM pg_temp.ok((SELECT count(*)=2 FROM public.inventory_serials WHERE serial_number IN ('V5A000001-AA','SE1234-V5A000002-AA')),'SERIAL-2 full/9+2');
 tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(2),'transaction_type','IN','transaction_date','2099-03-15','quantity',3,'unit','台'),
 '["SE1234-V5A000003-AA","SE5678-V5A000003-AA","V5A00004-AA"]');
 PERFORM pg_temp.reject('SELECT pg_temp.make(16,2,1,''["V5A000003-AA"]'')','SERIAL-3 ambiguous','SERIAL_IDENTITY_CONFLICT');
 PERFORM pg_temp.reject('SELECT pg_temp.make(17,2,1,''["V5A00004-AA"]'')','SERIAL-4 existing in-stock','EXISTING_IN_STOCK');
 PERFORM pg_temp.reject('SELECT pg_temp.make(18,3,1,''["V5A00004-AA"]'')','different item','SERIAL_IDENTITY_CONFLICT');
 PERFORM public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(2),'transaction_type','OUT','transaction_date','2099-03-15','quantity',1,'unit','台','project_id',current_setting('test.v5_project')::uuid),'["V5A00004-AA"]');
 PERFORM pg_temp.reject('SELECT pg_temp.make(19,2,1,''["V5A00004-AA"]'')','SERIAL-5 OUT','SERIAL_IDENTITY_CONFLICT');
 PERFORM pg_temp.reject('SELECT pg_temp.make(20,2,2,''["V5A000009-AA","SE1234-V5A000009-AA"]'')','alias batch not two devices','AMBIGUOUS_SERIAL');

 source:=pg_temp.pending(30,1,20);
 result:=public.match_receiving_arrival_line(pg_temp.id(31),pg_temp.line(r),8,NULL,source);
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,source)->>'fulfilled'='8' AND public.get_receiving_pending_fulfilment(NULL,source)->>'remaining'='12','MATCH-1 8/20');
 PERFORM pg_temp.ok(public.match_receiving_arrival_line(pg_temp.id(31),pg_temp.line(r),8,NULL,source)=result,'match retry');
 r:=pg_temp.make(32,1,8);
 source2:=pg_temp.pending(33,1,4);
 PERFORM public.match_receiving_arrival_line(pg_temp.id(34),pg_temp.line(r),4,NULL,source);
 PERFORM public.match_receiving_arrival_line(pg_temp.id(35),pg_temp.line(r),4,NULL,source2);
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment(NULL,source)->>'fulfilled'='12','MATCH-3/4 one to many and many to one');

 r:=pg_temp.make(36,1,10);
 before_tx:=(SELECT count(*) FROM public.inventory_transactions);
 PERFORM pg_temp.reject(format('SELECT public.match_receiving_arrival_line(%L,%L,10,NULL,%L)',pg_temp.id(37),pg_temp.line(r),source),'MATCH-5 overmatch','CAPACITY_CONFLICT');
 PERFORM pg_temp.ok(EXISTS(SELECT 1 FROM public.receiving_arrivals WHERE id=(r->'arrival'->>'id')::uuid) AND (SELECT count(*)=before_tx FROM public.inventory_transactions),'arrival survives separate match failure');
 PERFORM pg_temp.ok(NOT EXISTS(SELECT 1 FROM public.receiving_arrival_matches WHERE arrival_line_id=pg_temp.line(r)),'MATCH-2 standalone');
 -- Default optional match failure preserves creation; all-or-nothing explicitly rolls it back.
 result:=public.create_receiving_arrival(pg_temp.id(38),'2000-01-01',jsonb_build_array(jsonb_build_object('inventory_item_id',pg_temp.id(1),'quantity',50)),NULL,'[TEST V5A]','2099-03-15',
 jsonb_build_array(jsonb_build_object('line_index',0,'se_supply_record_id',source,'quantity',50)));
 PERFORM pg_temp.ok(result->'matches'->0->>'status'='CONFLICT' AND EXISTS(SELECT 1 FROM public.receiving_arrival_lines WHERE id=pg_temp.line(result)),'optional match failure retains arrival');
 before_arrivals:=(SELECT count(*) FROM public.receiving_arrivals);
 PERFORM pg_temp.reject(format('SELECT public.create_receiving_arrival(%L,%L,%L,NULL,%L,%L,%L,true)',pg_temp.id(39),'2000-01-01',jsonb_build_array(jsonb_build_object('inventory_item_id',pg_temp.id(1),'quantity',50)),'[TEST V5A]','2099-03-15',jsonb_build_array(jsonb_build_object('line_index',0,'se_supply_record_id',source,'quantity',50))),'transaction-wide match failure','CAPACITY_CONFLICT');
 PERFORM pg_temp.ok((SELECT count(*)=before_arrivals FROM public.receiving_arrivals),'all-or-nothing rollback');
 r:=pg_temp.make(40,1,1,'[]',current_setting('test.v5_project')::uuid);
 source2:=pg_temp.pending(41,1,1,current_setting('test.v5_other_project')::uuid);
 PERFORM pg_temp.ok(current_setting('test.v5_other_project') IS NOT NULL,'two existing projects available');
 PERFORM pg_temp.reject(format('SELECT public.match_receiving_arrival_line(%L,%L,1,NULL,%L)',pg_temp.id(42),pg_temp.line(r),source2),'MATCH-7 project conflict','PROJECT_CONFLICT');

 source2:=pg_temp.pending(43,2,1,NULL,'["V5A00006-AA"]');
 r2:=pg_temp.make(44,2,1,'["V5A00006-AA"]');
 PERFORM public.match_receiving_arrival_line(pg_temp.id(45),pg_temp.line(r2),1,NULL,source2,pg_temp.entries(pg_temp.line(r2)));
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM public.receiving_arrival_match_serials s JOIN public.receiving_serial_entries e ON e.id=s.pending_entry_id WHERE e.se_supply_record_id=source2 AND e.active_receipt_id IS NULL),'Pending history separate from arrival observation');
 before_tx:=(SELECT count(*) FROM public.inventory_transactions);
 result:=public.update_receiving_arrival_metadata(pg_temp.id(46),(r->'arrival'->>'id')::uuid,1,NULL,'[TEST V5A] edited metadata');
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions) AND result->>'version'='2','notes/project edit no IN');
 PERFORM pg_temp.reject(format('SELECT public.update_receiving_arrival_metadata(%L,%L,1,NULL,NULL)',pg_temp.id(47),r->'arrival'->>'id'),'metadata stale version','VERSION_CONFLICT');

 before_tx:=(SELECT count(*) FROM public.inventory_transactions);
 before_receipts:=(SELECT count(*) FROM public.material_receipts);
 before_serials:=(SELECT count(*) FROM public.inventory_serials);
 before_arrivals:=(SELECT count(*) FROM public.receiving_arrivals);
 before_lines:=(SELECT count(*) FROM public.receiving_arrival_lines);
 before_entries:=(SELECT count(*) FROM public.receiving_serial_entries);
 before_audit:=(SELECT count(*) FROM public.activity_logs);
 PERFORM set_config('test.v5_fail','yes',true);
 PERFORM pg_temp.reject('SELECT pg_temp.make(50,2,1,''["V5A00007-AA"]'')','ATOMIC-1 injection after IN/receipt/serial/audit','V5_INJECTED_AFTER_POSTING');
 PERFORM set_config('test.v5_fail','no',true);
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions)
 AND (SELECT count(*)=before_receipts FROM public.material_receipts)
 AND (SELECT count(*)=before_serials FROM public.inventory_serials)
 AND (SELECT count(*)=before_arrivals FROM public.receiving_arrivals)
 AND (SELECT count(*)=before_lines FROM public.receiving_arrival_lines)
 AND (SELECT count(*)=before_entries FROM public.receiving_serial_entries)
 AND (SELECT count(*)=before_audit FROM public.activity_logs),'ATOMIC-1 all seven categories rolled back');
 u:=pg_temp.make(51,NULL,1,'["V5A00008-AA"]');
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM public.inventory_transactions) AND EXISTS(SELECT 1 FROM public.receiving_arrival_lines WHERE id=pg_temp.line(u) AND resolution_state='UNRESOLVED'),'ATOMIC-2 intentional persistence without IN');
 PERFORM pg_temp.reject(format('SELECT public.match_receiving_arrival_line(%L,%L,1,NULL,%L)',pg_temp.id(52),pg_temp.line(u),source),'unknown cannot match/route','REQUIRES_POSTED');
 PERFORM pg_temp.ok((SELECT md5(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'')) FROM public.material_receipts x WHERE arrival_line_id IS NULL)=(SELECT receipt_hash FROM v5_before),'LEGACY-1 original receipts exact unchanged');
 PERFORM pg_temp.ok(public.get_receiving_source_details('SE_SUPPLY',source)->'receipts'='[]'::jsonb,'LEGACY-2 V4 selector still loads');
END $$;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v5_viewer'),'role','authenticated')::text,true);
SELECT pg_temp.ok(current_setting('test.v5_viewer') IS NOT NULL,'Viewer exists');
SELECT pg_temp.reject('SELECT pg_temp.make(60,1,1)','AUTH-1 Viewer denied','active editor');
SELECT pg_temp.ok((SELECT count(*)=4 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('receiving_arrivals','receiving_arrival_lines','receiving_arrival_matches','receiving_arrival_match_serials') AND c.relrowsecurity),'four new tables RLS');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.receiving_arrivals','INSERT') AND NOT has_table_privilege('authenticated','public.receiving_arrival_lines','UPDATE') AND NOT has_table_privilege('authenticated','public.receiving_arrival_matches','DELETE'),'direct writes denied');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','app_private.post_receiving_arrival_line(uuid,uuid,date)','EXECUTE'),'private posting helper denied');
RESET ROLE;
ROLLBACK;
SELECT 'PASS V5-A arrival/serial/match/atomic/auth/legacy transaction; all fixtures rolled back' AS result;
