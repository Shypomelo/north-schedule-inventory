-- Run only on Candidate. Every fixture and assertion is rolled back.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM review_private.environment_guard
  WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW')
 THEN RAISE EXCEPTION 'CANDIDATE_ONLY'; END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',
  (SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),
  'role','authenticated')::text,true);
END $$;

CREATE TEMP TABLE safe_delete_fixture(kind text,id uuid,request_id uuid,expected_at timestamptz);
DO $$
DECLARE actor uuid; project_id uuid; item_id uuid; serial_item_id uuid; batch_id uuid;
 source_id uuid; before_inventory bigint; response jsonb; retry jsonb; req uuid; expected timestamptz;
 arrival_id uuid; line_id uuid; match_id uuid; site_material_id uuid; arrival_response jsonb; routed jsonb;
BEGIN
 SELECT id INTO actor FROM public.team_members WHERE email=(current_setting('request.jwt.claims')::jsonb->>'email');
 IF actor IS NULL THEN RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED'; END IF;
 project_id:=gen_random_uuid(); item_id:=gen_random_uuid(); serial_item_id:=gen_random_uuid();
 INSERT INTO public.projects(id,project_name) VALUES(project_id,'[SAFE DELETE TEST]');
 INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment,canonical_identity_key)
 VALUES(item_id,'TEST-SAFEDELETE-'||left(item_id::text,8),'[TEST] Safe delete plain','pcs','General',false,false,'TEST_SAFE_DELETE_'||item_id::text),
 (serial_item_id,'TEST-SAFEDELETE-'||left(serial_item_id::text,8),'[TEST] Safe delete serial','pcs','General',true,true,'TEST_SAFE_DELETE_'||serial_item_id::text);
 INSERT INTO public.project_material_batches(project_id,batch_name,created_by)
 VALUES(project_id,'[SAFE DELETE TEST]',actor) RETURNING id INTO batch_id;
 INSERT INTO public.project_materials(project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES(project_id,batch_id,'Safe delete plain',1,'pcs',actor,item_id,'OFFICE') RETURNING id,updated_at INTO source_id,expected;
 BEGIN
  UPDATE public.project_materials SET receiving_archived_at=now(),receiving_deleted_at=now() WHERE id=source_id;
  RAISE EXCEPTION 'DIRECT_DELETE_MARKER_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_RPC_REQUIRED' THEN RAISE; END IF;
 END;
 req:=gen_random_uuid();
 SELECT count(*) INTO before_inventory FROM public.inventory_transactions;
 response:=public.delete_receiving_pending_source(req,'PROJECT_MATERIAL',source_id,expected);
 IF response->>'outcome'<>'DELETED' OR (SELECT receiving_deleted_at IS NULL OR receiving_archived_at IS NULL FROM public.project_materials WHERE id=source_id)
  OR (SELECT count(*) FROM public.inventory_transactions)<>before_inventory THEN RAISE EXCEPTION 'PLAIN_DELETE_FAILED'; END IF;
 retry:=public.delete_receiving_pending_source(req,'PROJECT_MATERIAL',source_id,expected);
 IF retry IS DISTINCT FROM response THEN RAISE EXCEPTION 'RETRY_NOT_IDEMPOTENT'; END IF;
 BEGIN
  PERFORM public.delete_receiving_pending_source(req,'PROJECT_MATERIAL',source_id,expected+interval '1 second');
  RAISE EXCEPTION 'REQUEST_CONFLICT_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_REQUEST_CONFLICT' THEN RAISE; END IF;
 END;
 IF NOT EXISTS(SELECT 1 FROM public.activity_logs WHERE action='DELETE_RECEIVING_PENDING' AND target_id=source_id::text)
 THEN RAISE EXCEPTION 'AUDIT_MISSING'; END IF;
 BEGIN
  UPDATE public.project_materials SET receiving_archived_at=NULL WHERE id=source_id;
  RAISE EXCEPTION 'REOPEN_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_IMMUTABLE' THEN RAISE; END IF;
 END;

 -- Preregistered serials are source owned drafts; no canonical stock exists yet.
 source_id:=(public.create_office_equipment_arrival(gen_random_uuid(),serial_item_id,1,now(),project_id,
  '[SAFE DELETE TEST]','[]'::jsonb)->>'id')::uuid;
 PERFORM public.register_receiving_serial('SE_SUPPLY',source_id,serial_item_id,'SDEL0001-AA');
 SELECT updated_at INTO expected FROM public.se_supply_records WHERE id=source_id;
 response:=public.delete_receiving_pending_source(gen_random_uuid(),'SE_SUPPLY',source_id,expected);
 IF jsonb_array_length(response->'retired_entry_ids')<>1
  OR EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE se_supply_record_id=source_id AND retired_at IS NULL)
  OR (SELECT count(*) FROM public.inventory_transactions)<>before_inventory
  OR EXISTS(SELECT 1 FROM public.inventory_serials WHERE normalized_full='SDEL0001-AA')
 THEN RAISE EXCEPTION 'DRAFT_RETIREMENT_FAILED'; END IF;

 -- A stale timestamp fails without archive or audit.
 INSERT INTO public.project_materials(project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES(project_id,batch_id,'Stale pending',1,'pcs',actor,item_id,'OFFICE') RETURNING id,updated_at INTO source_id,expected;
 BEGIN
  PERFORM public.delete_receiving_pending_source(gen_random_uuid(),'PROJECT_MATERIAL',source_id,expected-interval '1 second');
  RAISE EXCEPTION 'STALE_VERSION_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_VERSION_CONFLICT' THEN RAISE; END IF;
 END;
 IF (SELECT receiving_archived_at IS NOT NULL FROM public.project_materials WHERE id=source_id)
 THEN RAISE EXCEPTION 'STALE_CHANGED_SOURCE'; END IF;

 -- Even a cancelled match remains business history and blocks deletion.
 INSERT INTO public.receiving_arrivals(actual_received_at,created_by) VALUES(now(),actor) RETURNING id INTO arrival_id;
 INSERT INTO public.receiving_arrival_lines(arrival_id,inventory_item_id,quantity,unit,resolution_state)
 VALUES(arrival_id,item_id,1,'pcs','STAGED') RETURNING id INTO line_id;
 INSERT INTO public.receiving_arrival_matches(arrival_line_id,project_material_id,quantity,created_by)
 VALUES(line_id,source_id,1,actor) RETURNING id INTO match_id;
 BEGIN
  PERFORM public.delete_receiving_pending_source(gen_random_uuid(),'PROJECT_MATERIAL',source_id,expected);
  RAISE EXCEPTION 'ACTIVE_ARRIVAL_MATCH_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_DOWNSTREAM_EXISTS' THEN RAISE; END IF;
 END;
 UPDATE public.receiving_arrival_matches SET cancelled_at=now() WHERE id=match_id;
 BEGIN
  PERFORM public.delete_receiving_pending_source(gen_random_uuid(),'PROJECT_MATERIAL',source_id,expected);
  RAISE EXCEPTION 'CANCELLED_MATCH_HISTORY_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_DOWNSTREAM_EXISTS' THEN RAISE; END IF;
 END;

 -- Legacy receipt provenance blocks deletion even with no current match.
 INSERT INTO public.project_materials(project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES(project_id,batch_id,'Receipt history',1,'pcs',actor,item_id,'OFFICE') RETURNING id,updated_at INTO source_id,expected;
 INSERT INTO public.material_receipts(source_type,project_material_id,quantity_received,received_by,receipt_location)
 VALUES('PROJECT_MATERIAL',source_id,1,actor,'OFFICE');
 BEGIN
  PERFORM public.delete_receiving_pending_source(gen_random_uuid(),'PROJECT_MATERIAL',source_id,expected);
  RAISE EXCEPTION 'RECEIPT_HISTORY_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_DOWNSTREAM_EXISTS' THEN RAISE; END IF;
 END;

 -- Canonical SE and SITE routes create Inventory effects and allocations.
 source_id:=(public.create_office_equipment_arrival(gen_random_uuid(),item_id,1,now(),project_id,
  '[SAFE DELETE TEST] SE route','[]'::jsonb)->>'id')::uuid;
 arrival_response:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',item_id,'quantity',1)),project_id,'[SAFE DELETE TEST] SE route');
 line_id:=(arrival_response->'lines'->0->>'id')::uuid;
 PERFORM public.match_receiving_arrival_line(gen_random_uuid(),line_id,1,NULL,source_id);
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SE',1,'{}',project_id,NULL,false,now(),NULL);
 IF NOT EXISTS(SELECT 1 FROM public.receiving_inventory_allocations
  WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid AND route_type='SE')
  OR NOT EXISTS(SELECT 1 FROM public.inventory_transactions
   WHERE id=(routed->'receipt'->>'inventory_transaction_id')::uuid)
 THEN RAISE EXCEPTION 'SE_ROUTE_FIXTURE_INCOMPLETE'; END IF;
 SELECT updated_at INTO expected FROM public.se_supply_records WHERE id=source_id;
 BEGIN
  PERFORM public.delete_receiving_pending_source(gen_random_uuid(),'SE_SUPPLY',source_id,expected);
  RAISE EXCEPTION 'SE_DOWNSTREAM_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_DOWNSTREAM_EXISTS' THEN RAISE; END IF;
 END;

 INSERT INTO public.project_materials(project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES(project_id,batch_id,'Office pending for site route',1,'pcs',actor,item_id,'OFFICE') RETURNING id INTO source_id;
 INSERT INTO public.project_materials(project_id,batch_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination)
 VALUES(project_id,batch_id,'Site route',1,'pcs',actor,item_id,'SITE') RETURNING id INTO site_material_id;
 arrival_response:=public.create_receiving_arrival(gen_random_uuid(),now(),
  jsonb_build_array(jsonb_build_object('inventory_item_id',item_id,'quantity',1)),project_id,'[SAFE DELETE TEST] SITE route');
 line_id:=(arrival_response->'lines'->0->>'id')::uuid;
 PERFORM public.match_receiving_arrival_line(gen_random_uuid(),line_id,1,source_id,NULL);
 routed:=public.route_staged_receiving(gen_random_uuid(),'NORMAL',line_id,NULL,'SITE',1,'{}',project_id,site_material_id,false,now(),NULL);
 IF NOT EXISTS(SELECT 1 FROM public.receiving_inventory_allocations
  WHERE office_receipt_id=(routed->'receipt'->>'id')::uuid AND route_type='SITE' AND project_material_id=site_material_id)
  OR NOT EXISTS(SELECT 1 FROM public.material_receipts
   WHERE source_type='PROJECT_MATERIAL' AND receipt_location='SITE' AND project_material_id=site_material_id)
  OR NOT EXISTS(SELECT 1 FROM public.inventory_transactions
   WHERE id=(routed->'receipt'->>'inventory_transaction_id')::uuid)
 THEN RAISE EXCEPTION 'SITE_ROUTE_FIXTURE_INCOMPLETE'; END IF;
 SELECT updated_at INTO expected FROM public.project_materials WHERE id=source_id;
 BEGIN
  PERFORM public.delete_receiving_pending_source(gen_random_uuid(),'PROJECT_MATERIAL',source_id,expected);
  RAISE EXCEPTION 'SITE_DOWNSTREAM_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN
  IF SQLERRM<>'PENDING_DELETE_DOWNSTREAM_EXISTS' THEN RAISE; END IF;
 END;
 RAISE NOTICE 'SAFE DELETE CANDIDATE BASIC CONTRACT PASS';
END $$;
ROLLBACK;
