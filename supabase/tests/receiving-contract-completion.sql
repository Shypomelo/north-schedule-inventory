-- Candidate/local development only. Every fixture and injection trigger rolls back.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_database()<>'receiving_v5a1_contract_20260926' THEN
  IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW')
  THEN RAISE EXCEPTION 'DEVELOPMENT ONLY'; END IF;
 END IF;
 PERFORM set_config('test.v51_admin',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
 PERFORM set_config('test.v51_viewer',(SELECT email FROM public.team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
 PERFORM set_config('test.v51_project_a',gen_random_uuid()::text,true);
 PERFORM set_config('test.v51_project_b',gen_random_uuid()::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v51_admin'),'role','authenticated')::text,true);
 PERFORM set_config('test.v51_plain',gen_random_uuid()::text,true);
 PERFORM set_config('test.v51_serial',gen_random_uuid()::text,true);
END $$;
INSERT INTO public.projects(id,project_name) VALUES
 (current_setting('test.v51_project_a')::uuid,'[TEST V5A.1] project A'),
 (current_setting('test.v51_project_b')::uuid,'[TEST V5A.1] project B');
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) VALUES
 (current_setting('test.v51_plain')::uuid,'[TEST V5A.1] plain','[TEST V5A.1] plain','個','一般',false,false),
 (current_setting('test.v51_serial')::uuid,'[TEST V5A.1] serial','[TEST V5A.1] serial','台','設備維修',true,true);
CREATE TEMP TABLE v51_assertions(label text);
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
 INSERT INTO v51_assertions VALUES(label);
END $$;
CREATE FUNCTION pg_temp.reject(q text,pattern text,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN
  IF SQLERRM !~ pattern THEN RAISE EXCEPTION 'FAIL: % unexpected % [%]',label,SQLERRM,SQLSTATE; END IF;
  PERFORM pg_temp.ok(true,label); RETURN;
 END; RAISE EXCEPTION 'FAIL: % did not reject',label;
END $$;
CREATE FUNCTION pg_temp.pending(qty numeric,project uuid DEFAULT NULL,kind text DEFAULT 'SE_SUPPLY',serialized boolean DEFAULT false,serials jsonb DEFAULT '[]')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item uuid:=current_setting(CASE WHEN serialized THEN 'test.v51_serial' ELSE 'test.v51_plain' END)::uuid;
 b uuid; s uuid; raw text;
BEGIN
 IF kind='SE_SUPPLY' THEN RETURN (public.create_office_equipment_arrival(gen_random_uuid(),item,qty,now(),project,'[TEST V5A.1]',serials)->>'id')::uuid; END IF;
 project:=COALESCE(project,current_setting('test.v51_project_a')::uuid);
 INSERT INTO public.project_material_batches(project_id,batch_name,created_by) VALUES(project,'[TEST V5A.1]',(app_private.inventory_actor()).id) RETURNING id INTO b;
 INSERT INTO public.project_materials(project_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination,batch_id)
 VALUES(project,'[TEST V5A.1]',qty,CASE WHEN serialized THEN '台' ELSE '個' END,(app_private.inventory_actor()).id,item,'OFFICE',b) RETURNING id INTO s;
 FOR raw IN SELECT jsonb_array_elements_text(serials) LOOP PERFORM public.register_receiving_serial(kind,s,item,raw); END LOOP;
 RETURN s;
END $$;
CREATE FUNCTION pg_temp.arrival(qty numeric,serials jsonb DEFAULT NULL,project uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
 SELECT (public.create_receiving_arrival(gen_random_uuid(),'2000-01-01',jsonb_build_array(jsonb_build_object('inventory_item_id',
 current_setting(CASE WHEN serials IS NULL THEN 'test.v51_plain' ELSE 'test.v51_serial' END)::uuid,'quantity',qty,'raw_serials',COALESCE(serials,'[]'))),
 project,'[TEST V5A.1]','2099-03-15')->'lines'->0->>'id')::uuid
$$;
CREATE FUNCTION pg_temp.alloc(source uuid,qty numeric,entries uuid[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(CASE WHEN EXISTS(SELECT 1 FROM public.project_materials WHERE id=source) THEN 'project_material_id' ELSE 'se_supply_record_id' END,source,
 'quantity',qty,'entry_ids',to_jsonb(entries))
$$;
CREATE FUNCTION pg_temp.replace(line uuid,matches jsonb,req uuid DEFAULT gen_random_uuid(),ver bigint DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.replace_receiving_arrival_matches(req,line,COALESCE(ver,(SELECT version FROM public.receiving_arrival_lines WHERE id=line)),matches)
$$;
CREATE FUNCTION pg_temp.fulfil(source uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.get_receiving_pending_fulfilment(CASE WHEN EXISTS(SELECT 1 FROM public.project_materials WHERE id=source) THEN source END,
 CASE WHEN NOT EXISTS(SELECT 1 FROM public.project_materials WHERE id=source) THEN source END)
$$;
CREATE FUNCTION pg_temp.metadata(line uuid,project uuid,notes text DEFAULT '[TEST V5A.1]',req uuid DEFAULT gen_random_uuid(),ver bigint DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.update_receiving_arrival_metadata($4,a.id,COALESCE($5,a.version),$2,$3) FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id WHERE l.id=$1
$$;
CREATE FUNCTION pg_temp.ledger() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('transactions',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM public.inventory_transactions t),
 'receipts',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM public.material_receipts t),
 'serials',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM public.inventory_serials t),
 'observations',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM public.receiving_serial_entries t),
 'receipt_serials',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY receipt_id,entry_id)::text,'')) FROM public.material_receipt_serials t),
 'transaction_serials',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM public.inventory_transaction_serials t),
 'batches',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM public.inventory_batches t))
$$;
CREATE FUNCTION pg_temp.inject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.action=current_setting('test.v51_inject',true) THEN RAISE EXCEPTION 'V51_INJECTED_AUDIT_FAILURE'; END IF; RETURN NEW;
END $$;
CREATE FUNCTION pg_temp.request_state() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('requests',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY request_id)::text,'')) FROM app_private.receiving_requests r),
 'context',(SELECT count(*) FROM app_private.receiving_contract_context),
 'arrivals',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'')) FROM public.receiving_arrivals r),
 'lines',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'')) FROM public.receiving_arrival_lines r))
$$;
CREATE TRIGGER v51_test_inject BEFORE INSERT ON public.activity_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.inject();
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
GRANT SELECT,INSERT ON v51_assertions TO authenticated,anon;
SET LOCAL ROLE authenticated;
DO $$
DECLARE a uuid:=current_setting('test.v51_project_a')::uuid; b uuid:=current_setting('test.v51_project_b')::uuid;
 s uuid; s2 uuid; s3 uuid; l uuid; l2 uuid; req uuid; ver bigint; r jsonb; status jsonb; before_data jsonb; before_matches jsonb; before_arrival jsonb;
 kind text; n bigint; old_count bigint; entries uuid[]; before_request jsonb;
BEGIN
 PERFORM pg_temp.ok(a IS NOT NULL AND b IS NOT NULL AND a<>b,'two project contexts available');
 FOREACH kind IN ARRAY ARRAY['SE_SUPPLY','PROJECT_MATERIAL'] LOOP
  s:=pg_temp.pending(20,NULL,kind); l:=pg_temp.arrival(8);
  PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)));
  before_data:=pg_temp.ledger();
  SELECT jsonb_build_object('line',to_jsonb(al),'arrival',to_jsonb(ar)) INTO before_arrival FROM public.receiving_arrival_lines al JOIN public.receiving_arrivals ar ON ar.id=al.arrival_id WHERE al.id=l;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l;
  PERFORM pg_temp.reject(format('SELECT public.cancel_receiving_arrival(gen_random_uuid(),%L,%L,''unsafe old cancel'')',kind,s),'MATCHED_PENDING_CORRECTION_REQUIRED','LEGACY-1 old cancel remains guarded '||kind);
  PERFORM set_config('app.receiving_contract_context','cancel_remaining',true);
  PERFORM pg_temp.reject(format('UPDATE public.%I SET receiving_archived_at=now() WHERE id=%L',CASE WHEN kind='SE_SUPPLY' THEN 'se_supply_records' ELSE 'project_materials' END,s),'MATCHED_PENDING_CORRECTION_REQUIRED','GUC cannot bypass guard '||kind);
  req:=gen_random_uuid();
  r:=public.cancel_receiving_pending_remaining(req,kind,s,'remaining not needed');
  status:=pg_temp.fulfil(s);
  PERFORM pg_temp.ok(r->>'outcome'='CANCELLED' AND r->>'expected'='20' AND r->>'fulfilled'='8' AND r->>'cancelled_remaining'='12','PENDING-1 cancellation facts '||kind);
  PERFORM pg_temp.ok(status->>'remaining'='12' AND status->>'remaining_status'='CANCELLED' AND status->>'active'='false','PENDING-1 query preserves remaining '||kind);
  PERFORM pg_temp.ok(status->'cancellation'->>'fulfilled_at_cancellation'='8' AND status->'cancellation'->>'actor_id' IS NOT NULL AND status->'cancellation'->>'cancelled_at' IS NOT NULL,'cancellation audit query '||kind);
  PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'PENDING-1 ledger receipt serial unchanged '||kind);
  PERFORM pg_temp.ok((SELECT jsonb_build_object('line',to_jsonb(al),'arrival',to_jsonb(ar))=before_arrival FROM public.receiving_arrival_lines al JOIN public.receiving_arrivals ar ON ar.id=al.arrival_id WHERE al.id=l),'PENDING-1 arrival unchanged '||kind);
  PERFORM pg_temp.ok((SELECT jsonb_agg(to_jsonb(m) ORDER BY id)=before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l),'PENDING-1 active matches unchanged '||kind);
  SELECT count(*) INTO n FROM public.activity_logs;
  PERFORM pg_temp.ok(public.cancel_receiving_pending_remaining(req,kind,s,'remaining not needed')=r AND (SELECT count(*) FROM public.activity_logs)=n,'IDEMPOTENCY cancel retry '||kind);
  PERFORM pg_temp.reject(format('SELECT public.cancel_receiving_pending_remaining(%L,%L,%L,''different'')',req,kind,s),'Request conflict','IDEMPOTENCY cancel payload '||kind);
  l2:=pg_temp.arrival(1);
  PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,%L)',l2,jsonb_build_array(pg_temp.alloc(s,1))),'MATCH_PENDING_INACTIVE','PENDING-4 inactive rejects future replacement '||kind);
  PERFORM pg_temp.reject(format('SELECT public.match_receiving_arrival_line(gen_random_uuid(),%L,1,%L,%L)',l2,CASE WHEN kind='PROJECT_MATERIAL' THEN s END,CASE WHEN kind='SE_SUPPLY' THEN s END),'MATCH_PENDING_INACTIVE','PENDING-4 inactive rejects existing match RPC '||kind);
  PERFORM pg_temp.reject(format('UPDATE public.%I SET receiving_archived_at=NULL WHERE id=%L',CASE WHEN kind='SE_SUPPLY' THEN 'se_supply_records' ELSE 'project_materials' END,s),'CANCELLED_PENDING_CORRECTION_REQUIRED','cannot reopen cancellation '||kind);
  PERFORM pg_temp.replace(l,'[]');
  PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'active'='false' AND pg_temp.fulfil(s)->>'remaining'='20' AND pg_temp.fulfil(s)->'cancellation'->>'cancelled_remaining'='12','unmatch retains cancellation-time history '||kind);
  s:=pg_temp.pending(20,NULL,kind);
  PERFORM pg_temp.ok(public.cancel_receiving_pending_remaining(gen_random_uuid(),kind,s)->>'cancelled_remaining'='20','PENDING-2 zero matched cancellation '||kind);
  s:=pg_temp.pending(20,NULL,kind); l:=pg_temp.arrival(20); PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,20)));
  SELECT count(*) INTO n FROM public.activity_logs;
  PERFORM pg_temp.ok(public.cancel_receiving_pending_remaining(gen_random_uuid(),kind,s)->>'outcome'='NO_REMAINING' AND (SELECT count(*) FROM public.activity_logs)=n,'PENDING-3 no fake cancellation '||kind);
 END LOOP;

 -- All five final-set operations, quantity boundaries and request cache.
 s:=pg_temp.pending(20); s2:=pg_temp.pending(20); s3:=pg_temp.pending(2); l:=pg_temp.arrival(8);
 before_data:=pg_temp.ledger();
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='8','MATCH add 0 -> 8');
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,5)));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='5','MATCH-1 reduce 8 -> 5');
 PERFORM pg_temp.replace(l,'[]');
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='0','MATCH-2 remove 8 -> 0');
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)));
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,5),pg_temp.alloc(s2,3)));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='5' AND pg_temp.fulfil(s2)->>'fulfilled'='3','MATCH-3 A8 -> A5+B3');
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s2,8)));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='0' AND pg_temp.fulfil(s2)->>'fulfilled'='8','MATCH-4 A8 -> B8');
 PERFORM pg_temp.ok((SELECT count(*)>0 FROM public.receiving_arrival_matches WHERE arrival_line_id=l AND cancelled_at IS NOT NULL),'match history retained');
 PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'MATCH-8/9 full ledger and receipt fingerprint unchanged');
 SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l;
 PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,%L)',l,jsonb_build_array(pg_temp.alloc(s,6),pg_temp.alloc(s2,3))),'MATCH_CAPACITY_CONFLICT','MATCH-5 sum above arrival');
 PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,%L)',l,jsonb_build_array(pg_temp.alloc(s3,3))),'MATCH_CAPACITY_CONFLICT','MATCH-6 pending overflow');
 PERFORM pg_temp.ok((SELECT jsonb_agg(to_jsonb(m) ORDER BY id)=before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l),'failed replacement preserves whole old set');
 req:=gen_random_uuid(); SELECT version INTO ver FROM public.receiving_arrival_lines WHERE id=l;
 r:=pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)),req,ver);
 SELECT count(*) INTO n FROM public.activity_logs; SELECT count(*) INTO old_count FROM public.receiving_arrival_matches;
 PERFORM pg_temp.ok(pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)),req,ver)=r AND (SELECT count(*) FROM public.activity_logs)=n AND (SELECT count(*) FROM public.receiving_arrival_matches)=old_count,'IDEMPOTENCY replace exact retry no extra history');
 PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,''[]'',%L,%s)',l,req,ver),'Request conflict','IDEMPOTENCY replace payload');
 PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,''[]'',gen_random_uuid(),%s)',l,ver),'MATCH_LINE_VERSION_CONFLICT','stale line version rejected');

 -- Metadata compatibility, all active matches and immutable original posting provenance.
 l:=pg_temp.arrival(8); before_data:=pg_temp.ledger();
 PERFORM pg_temp.metadata(l,a); PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'PROJECT-1 unmatched metadata no ledger rewrite');
 s:=pg_temp.pending(20,a); l:=pg_temp.arrival(8); PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8))); before_data:=pg_temp.ledger();
 PERFORM pg_temp.metadata(l,a); PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'PROJECT-2 compatible explicit project');
 PERFORM pg_temp.reject(format('SELECT pg_temp.metadata(%L,NULL)',l),'ARRIVAL_PROJECT_CONFLICT_WITH_MATCH','cannot clear explicit matched project');
 s:=pg_temp.pending(20); l:=pg_temp.arrival(8); PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8))); before_data:=pg_temp.ledger();
 req:=gen_random_uuid(); SELECT ar.version INTO ver FROM public.receiving_arrivals ar JOIN public.receiving_arrival_lines al ON al.arrival_id=ar.id WHERE al.id=l;
 r:=pg_temp.metadata(l,a,'context',req,ver);
 PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'PROJECT-3 NULL pending project compatible');
 SELECT count(*) INTO n FROM public.activity_logs;
 PERFORM pg_temp.ok(pg_temp.metadata(l,a,'context',req,ver)=r AND (SELECT count(*) FROM public.activity_logs)=n,'IDEMPOTENCY metadata retry');
 PERFORM pg_temp.reject(format('SELECT pg_temp.metadata(%L,%L,''different'',%L,%s)',l,a,req,ver),'Request conflict','IDEMPOTENCY metadata payload');
 s:=pg_temp.pending(20,b); l:=pg_temp.arrival(8); PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)));
 PERFORM pg_temp.reject(format('SELECT pg_temp.metadata(%L,%L)',l,a),'ARRIVAL_PROJECT_CONFLICT_WITH_MATCH','PROJECT-4 conflicting pending project');
 PERFORM pg_temp.metadata(l,NULL,'notes only');
 PERFORM pg_temp.ok(true,'notes-only edit preserves existing NULL context');
 PERFORM pg_temp.reject(format('UPDATE public.receiving_arrivals SET project_id=%L WHERE id=(SELECT arrival_id FROM public.receiving_arrival_lines WHERE id=%L)',a,l),'permission denied','direct arrival metadata write denied');
 PERFORM pg_temp.reject(format('UPDATE public.se_supply_records SET project_id=%L WHERE id=%L',a,s),'MATCHED_PENDING_CORRECTION_REQUIRED','LEGACY direct Pending project mutation guarded');

 -- Serial reassignment releases active uniqueness while preserving all historical links.
 s:=pg_temp.pending(3,NULL,'SE_SUPPLY',true,'["V51A0001-AA","V51A0002-AA"]');
 s2:=pg_temp.pending(3,NULL,'SE_SUPPLY',true);
 l:=pg_temp.arrival(3,'["V51A0001-AA","V51A0002-AA","V51A0003-AA"]');
 SELECT array_agg(id ORDER BY normalized_serial) INTO entries FROM public.receiving_serial_entries WHERE arrival_line_id=l;
 before_data:=pg_temp.ledger();
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,3,entries)));
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,2,entries[1:2])));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='2','serialized reduce');
 PERFORM pg_temp.replace(l,'[]');
 PERFORM pg_temp.ok((SELECT count(*)=0 FROM public.receiving_arrival_match_serials WHERE arrival_entry_id=ANY(entries) AND cancelled_at IS NULL),'serialized remove');
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,2,entries[1:2]),pg_temp.alloc(s2,1,entries[3:3])));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='2' AND pg_temp.fulfil(s2)->>'fulfilled'='1','serialized split');
 PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s2,3,entries)));
 PERFORM pg_temp.ok(pg_temp.fulfil(s)->>'fulfilled'='0' AND pg_temp.fulfil(s2)->>'fulfilled'='3','serialized full reassign');
 SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l;
 PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,%L)',l,jsonb_build_array(pg_temp.alloc(s,1,entries[1:1]),pg_temp.alloc(s2,2,entries[1:2]))),'duplicate key|MATCH_SERIAL','MATCH-7 same actual serial in two active matches rejected');
 PERFORM pg_temp.ok((SELECT jsonb_agg(to_jsonb(m) ORDER BY id)=before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l),'serialized failure restores old relations');
 PERFORM pg_temp.ok((SELECT count(*)>3 FROM public.receiving_arrival_match_serials WHERE arrival_entry_id=ANY(entries) AND cancelled_at IS NOT NULL),'serialized historical relations retained');
 PERFORM pg_temp.ok(NOT EXISTS(SELECT 1 FROM public.receiving_arrival_match_serials ms JOIN public.receiving_arrival_matches m ON m.id=ms.match_id WHERE ms.cancelled_at IS DISTINCT FROM m.cancelled_at),'serial active state agrees with parent');
 PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'serialized replacement no canonical mutation');
 PERFORM pg_temp.reject('UPDATE public.receiving_arrival_matches SET cancelled_at=now()','permission denied','direct match mutation denied');
 PERFORM pg_temp.reject('UPDATE public.receiving_arrival_match_serials SET cancelled_at=now()','permission denied','direct match serial mutation denied');
 PERFORM pg_temp.reject('INSERT INTO app_private.receiving_contract_context VALUES(txid_current(),pg_backend_pid(),''SE_SUPPLY'',gen_random_uuid())','permission denied','private cancellation capability denied');

 -- Inject a failure at each final audit point; changes, context and inner request caches roll back.
 s:=pg_temp.pending(20); l:=pg_temp.arrival(8); PERFORM pg_temp.replace(l,jsonb_build_array(pg_temp.alloc(s,8)));
 FOREACH kind IN ARRAY ARRAY['PENDING_REMAINING_CANCELLED','ARRIVAL_METADATA','ARRIVAL_MATCHES_REPLACED'] LOOP
  SELECT count(*) INTO n FROM public.activity_logs;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l;
  before_data:=pg_temp.ledger();
  before_request:=pg_temp.request_state();
  PERFORM set_config('test.v51_inject',kind,true);
  IF kind='PENDING_REMAINING_CANCELLED' THEN
   PERFORM pg_temp.reject(format('SELECT public.cancel_receiving_pending_remaining(gen_random_uuid(),''SE_SUPPLY'',%L)',s),'V51_INJECTED','cancel rollback injection');
  ELSIF kind='ARRIVAL_METADATA' THEN
   PERFORM pg_temp.reject(format('SELECT pg_temp.metadata(%L,%L)',l,a),'V51_INJECTED','metadata rollback injection');
  ELSE PERFORM pg_temp.reject(format('SELECT pg_temp.replace(%L,''[]'')',l),'V51_INJECTED','replace rollback injection'); END IF;
  PERFORM set_config('test.v51_inject','',true);
  PERFORM pg_temp.ok((SELECT count(*) FROM public.activity_logs)=n AND pg_temp.fulfil(s)->>'active'='true' AND pg_temp.fulfil(s)->>'fulfilled'='8','injection audit and pending unchanged '||kind);
  PERFORM pg_temp.ok(pg_temp.ledger()=before_data AND (SELECT jsonb_agg(to_jsonb(m) ORDER BY id)=before_matches FROM public.receiving_arrival_matches m WHERE arrival_line_id=l),'injection canonical and match state unchanged '||kind);
  PERFORM pg_temp.ok(pg_temp.request_state()=before_request,'injection request cache context and versions unchanged '||kind);
 END LOOP;
END $$;
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*)=0 FROM app_private.receiving_contract_context),'no capability leftovers');
-- Closing the original posting month does not turn receiving metadata into a ledger edit.
INSERT INTO public.inventory_monthly_closings(year,month,status,closed_by,closed_at,notes)
 VALUES('2099','03','CLOSED','[TEST V5A.1]',now(),'[TEST V5A.1]');
SET LOCAL ROLE authenticated;
DO $$ DECLARE l uuid; before_data jsonb; BEGIN
 SELECT al.id INTO l FROM public.receiving_arrival_lines al JOIN public.receiving_arrivals ar ON ar.id=al.arrival_id
 WHERE ar.notes='notes only' ORDER BY al.id LIMIT 1;
 PERFORM pg_temp.ok(l IS NOT NULL,'closed-month metadata fixture');
 before_data:=pg_temp.ledger();
 PERFORM pg_temp.metadata(l,current_setting('test.v51_project_b')::uuid,'[TEST V5A.1] closed month context');
 PERFORM pg_temp.ok(pg_temp.ledger()=before_data,'closed-month metadata leaves posting provenance unchanged');
END $$;
RESET ROLE;
SELECT pg_temp.ok((SELECT relrowsecurity FROM pg_class WHERE oid='app_private.receiving_contract_context'::regclass),'private capability RLS enabled');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','app_private.receiving_contract_context','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('anon','app_private.receiving_contract_context','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('service_role','app_private.receiving_contract_context','SELECT,INSERT,UPDATE,DELETE'),'private capability has no client grants');
DO $$ DECLARE f text; t text; BEGIN
 FOREACH f IN ARRAY ARRAY['public.cancel_receiving_pending_remaining(uuid,text,uuid,text)',
  'public.replace_receiving_arrival_matches(uuid,uuid,bigint,jsonb)','public.update_receiving_arrival_metadata(uuid,uuid,bigint,uuid,text)'] LOOP
  PERFORM pg_temp.ok(has_function_privilege('authenticated',f,'EXECUTE') AND NOT has_function_privilege('anon',f,'EXECUTE') AND NOT has_function_privilege('service_role',f,'EXECUTE'),'RPC least privilege '||f);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['receiving_arrivals','receiving_arrival_lines','receiving_arrival_matches','receiving_arrival_match_serials'] LOOP
  PERFORM pg_temp.ok((SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass)
   AND NOT has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE'),'V5 read-only table and RLS '||t);
 END LOOP;
END $$;
DO $$ BEGIN
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.v51_viewer'),'role','authenticated')::text,true);
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject('SELECT public.cancel_receiving_pending_remaining(gen_random_uuid(),''SE_SUPPLY'',gen_random_uuid())','active editor','viewer cancel denied');
SELECT pg_temp.reject('SELECT public.replace_receiving_arrival_matches(gen_random_uuid(),gen_random_uuid(),1,''[]'')','active editor','viewer replacement denied');
SELECT pg_temp.reject('SELECT public.update_receiving_arrival_metadata(gen_random_uuid(),gen_random_uuid(),1,NULL,NULL)','active editor','viewer metadata denied');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.reject('SELECT public.cancel_receiving_pending_remaining(gen_random_uuid(),''SE_SUPPLY'',gen_random_uuid())','permission denied','anon cancel denied');
SELECT pg_temp.reject('SELECT public.replace_receiving_arrival_matches(gen_random_uuid(),gen_random_uuid(),1,''[]'')','permission denied','anon replacement denied');
SELECT pg_temp.reject('SELECT public.update_receiving_arrival_metadata(gen_random_uuid(),gen_random_uuid(),1,NULL,NULL)','permission denied','anon metadata denied');
SELECT pg_temp.reject('SELECT * FROM public.receiving_arrival_match_serials','permission denied','anon relation read denied');
RESET ROLE;
SELECT count(*) AS passed_assertions FROM v51_assertions;
ROLLBACK;
SELECT 'PASS V5-A.1 cancellation, metadata, final-set replacement, serial history, audit, idempotency, rollback injection, actor/grants and direct-write guards; all fixtures rolled back' AS result;
