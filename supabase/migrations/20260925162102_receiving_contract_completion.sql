-- V5-A.1: controlled planning cancellation, metadata compatibility and match replacement.
-- Inventory/receipt/arrival quantities and posting provenance are never rewritten.
CREATE TABLE app_private.receiving_contract_context (
 transaction_id bigint NOT NULL, backend_pid integer NOT NULL,
 source_type text NOT NULL CHECK(source_type IN ('PROJECT_MATERIAL','SE_SUPPLY')),
 source_id uuid NOT NULL,
 PRIMARY KEY(transaction_id,backend_pid,source_type,source_id)
);
ALTER TABLE app_private.receiving_contract_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.receiving_contract_context FROM PUBLIC,anon,authenticated,service_role;

-- A cancelled association remains queryable; only active associations own serial capacity.
ALTER TABLE public.receiving_arrival_match_serials ADD COLUMN cancelled_at timestamptz;
UPDATE public.receiving_arrival_match_serials s SET cancelled_at=m.cancelled_at
 FROM public.receiving_arrival_matches m WHERE m.id=s.match_id AND m.cancelled_at IS NOT NULL;
ALTER TABLE public.receiving_arrival_match_serials
 DROP CONSTRAINT receiving_arrival_match_serials_arrival_entry_id_key,
 DROP CONSTRAINT receiving_arrival_match_serials_pending_entry_id_key;
CREATE UNIQUE INDEX receiving_match_active_arrival_entry ON public.receiving_arrival_match_serials(arrival_entry_id) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX receiving_match_active_pending_entry ON public.receiving_arrival_match_serials(pending_entry_id) WHERE cancelled_at IS NULL AND pending_entry_id IS NOT NULL;

CREATE FUNCTION app_private.cancel_arrival_match_serials() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
 THEN RAISE EXCEPTION 'CANCELLED_MATCH_HISTORY_IMMUTABLE' USING ERRCODE='PT409'; END IF;
 IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN
  UPDATE public.receiving_arrival_match_serials SET cancelled_at=NEW.cancelled_at WHERE match_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.cancel_arrival_match_serials() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER cancel_arrival_match_serials AFTER UPDATE OF cancelled_at ON public.receiving_arrival_matches
 FOR EACH ROW EXECUTE FUNCTION app_private.cancel_arrival_match_serials();

CREATE FUNCTION app_private.check_arrival_match_serial_state() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE parent_cancelled timestamptz;
BEGIN
 SELECT cancelled_at INTO parent_cancelled FROM public.receiving_arrival_matches WHERE id=NEW.match_id;
 IF NOT FOUND OR NEW.cancelled_at IS DISTINCT FROM parent_cancelled
 THEN RAISE EXCEPTION 'MATCH_SERIAL_ACTIVE_STATE_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF TG_OP='UPDATE' AND (NEW.match_id<>OLD.match_id OR NEW.arrival_entry_id<>OLD.arrival_entry_id
  OR NEW.pending_entry_id IS DISTINCT FROM OLD.pending_entry_id OR OLD.cancelled_at IS NOT NULL)
 THEN RAISE EXCEPTION 'MATCH_SERIAL_HISTORY_IMMUTABLE' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.check_arrival_match_serial_state() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER check_arrival_match_serial_state BEFORE INSERT OR UPDATE ON public.receiving_arrival_match_serials
 FOR EACH ROW EXECUTE FUNCTION app_private.check_arrival_match_serial_state();

CREATE OR REPLACE FUNCTION app_private.guard_arrival_matched_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE used numeric; old_data jsonb:=to_jsonb(OLD); new_data jsonb:=to_jsonb(NEW);
 kind text:=CASE WHEN TG_TABLE_NAME='project_materials' THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END;
BEGIN
 -- Exact, transaction-bound capability; client-set GUCs cannot authorize a bypass.
 IF TG_OP='UPDATE' AND OLD.receiving_archived_at IS NULL AND NEW.receiving_archived_at IS NOT NULL
 AND (new_data-ARRAY['receiving_archived_at','updated_at'])=(old_data-ARRAY['receiving_archived_at','updated_at'])
 AND EXISTS(SELECT 1 FROM app_private.receiving_contract_context
   WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND source_type=kind AND source_id=OLD.id)
 THEN RETURN NEW; END IF;
 -- Do not reopen or rewrite an expectation closed by the controlled command, even at 0 matches.
 IF EXISTS(SELECT 1 FROM public.activity_logs WHERE action='PENDING_REMAINING_CANCELLED' AND target_id=OLD.id::text
   AND changes->'after'->>'source_type'=kind)
 AND (TG_OP='DELETE' OR NEW.quantity IS DISTINCT FROM OLD.quantity
   OR NEW.receiving_archived_at IS DISTINCT FROM OLD.receiving_archived_at)
 THEN RAISE EXCEPTION 'CANCELLED_PENDING_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(quantity),0) INTO used FROM public.receiving_arrival_matches WHERE cancelled_at IS NULL
 AND ((TG_TABLE_NAME='project_materials' AND project_material_id=OLD.id) OR (TG_TABLE_NAME='se_supply_records' AND se_supply_record_id=OLD.id));
 IF used>0 AND (TG_OP='DELETE' OR NEW.quantity<used
 OR (new_data->'inventory_item_id') IS DISTINCT FROM (old_data->'inventory_item_id')
 OR (new_data->'project_id') IS DISTINCT FROM (old_data->'project_id')
 OR (new_data->'unit') IS DISTINCT FROM (old_data->'unit')
 OR (new_data->'receiving_only') IS DISTINCT FROM (old_data->'receiving_only')
 OR (new_data->'delivery_destination') IS DISTINCT FROM (old_data->'delivery_destination')
 OR (new_data->'cancelled_at') IS DISTINCT FROM (old_data->'cancelled_at')
 OR (new_data->'receiving_archived_at') IS DISTINCT FROM (old_data->'receiving_archived_at'))
 THEN RAISE EXCEPTION 'MATCHED_PENDING_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_arrival_matched_pending() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_receiving_pending_fulfilment(p_project_material_id uuid DEFAULT NULL,p_se_supply_record_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE source jsonb; total numeric; fulfilled numeric; cancellation jsonb; active boolean; state text; kind text; source_id uuid;
BEGIN
 IF NOT COALESCE(app_private.is_active_member(),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF num_nonnulls(p_project_material_id,p_se_supply_record_id)<>1 THEN RAISE EXCEPTION 'One pending source required'; END IF;
 source_id:=COALESCE(p_project_material_id,p_se_supply_record_id);
 kind:=CASE WHEN p_project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END;
 IF p_project_material_id IS NOT NULL THEN SELECT to_jsonb(m) INTO source FROM public.project_materials m WHERE id=p_project_material_id AND delivery_destination='OFFICE';
 ELSE SELECT to_jsonb(s) INTO source FROM public.se_supply_records s WHERE id=p_se_supply_record_id AND receiving_only; END IF;
 IF source IS NULL THEN RAISE EXCEPTION 'Pending not found'; END IF;
 total:=(source->>'quantity')::numeric;
 SELECT COALESCE(sum(m.quantity),0) INTO fulfilled FROM public.receiving_arrival_matches m
 JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id JOIN public.receiving_arrivals a ON a.id=l.arrival_id
 WHERE m.cancelled_at IS NULL AND a.voided_at IS NULL AND l.resolution_state='POSTED'
 AND (m.project_material_id=p_project_material_id OR m.se_supply_record_id=p_se_supply_record_id);
 SELECT changes->'after' INTO cancellation FROM public.activity_logs
 WHERE action='PENDING_REMAINING_CANCELLED' AND target_id=source_id::text AND changes->'after'->>'source_type'=kind
 ORDER BY created_at DESC,id DESC LIMIT 1;
 active:=source->>'receiving_archived_at' IS NULL AND source->>'cancelled_at' IS NULL
  AND COALESCE(source->>'procurement_status','')<>'RECEIVED' AND total>fulfilled;
 state:=CASE WHEN cancellation IS NOT NULL THEN 'CANCELLED' WHEN total<=fulfilled THEN 'FULFILLED'
  WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END;
 RETURN jsonb_build_object('quantity',total,'expected',total,'fulfilled',fulfilled,'remaining',total-fulfilled,
  'remaining_status',state,'active',active,'cancellation',cancellation);
END $$;
REVOKE ALL ON FUNCTION public.get_receiving_pending_fulfilment(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_receiving_pending_fulfilment(uuid,uuid) TO authenticated;

CREATE FUNCTION public.cancel_receiving_pending_remaining(p_request_id uuid,p_source_type text,p_source_id uuid,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests; source jsonb;
 payload jsonb:=jsonb_build_array('V5_CANCEL_REMAINING',p_source_type,p_source_id,p_reason);
 status jsonb; result jsonb; at_time timestamptz;
BEGIN
 IF p_request_id IS NULL OR p_source_id IS NULL OR p_source_type IS NULL OR p_source_type NOT IN ('PROJECT_MATERIAL','SE_SUPPLY') THEN RAISE EXCEPTION 'PENDING_REQUEST_SOURCE_REQUIRED'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 source:=app_private.receiving_source(p_source_type,p_source_id);
 IF p_source_type='SE_SUPPLY' AND (source->>'receiving_only')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'PENDING_RECEIVING_ONLY_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.material_receipts WHERE project_material_id=p_source_id OR se_supply_record_id=p_source_id)
 THEN RAISE EXCEPTION 'MATCH_LEGACY_RECEIPT_REQUIRES_PROJECTION' USING ERRCODE='PT409'; END IF;
 status:=public.get_receiving_pending_fulfilment(CASE WHEN p_source_type='PROJECT_MATERIAL' THEN p_source_id END,CASE WHEN p_source_type='SE_SUPPLY' THEN p_source_id END);
 result:=status||jsonb_build_object('id',p_source_id,'source_type',p_source_type,'reason',p_reason);
 IF (status->>'remaining')::numeric<=0 THEN result:=result||jsonb_build_object('outcome','NO_REMAINING');
 ELSIF NOT (status->>'active')::boolean THEN result:=result||jsonb_build_object('outcome','ALREADY_INACTIVE');
 ELSE
  at_time:=clock_timestamp();
  INSERT INTO app_private.receiving_contract_context VALUES(txid_current(),pg_backend_pid(),p_source_type,p_source_id);
  IF p_source_type='PROJECT_MATERIAL' THEN
   UPDATE public.project_materials SET receiving_archived_at=at_time,updated_at=at_time WHERE id=p_source_id;
  ELSE UPDATE public.se_supply_records SET receiving_archived_at=at_time,updated_at=at_time WHERE id=p_source_id; END IF;
  DELETE FROM app_private.receiving_contract_context WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND source_type=p_source_type AND source_id=p_source_id;
  result:=result||jsonb_build_object('outcome','CANCELLED','active',false,'remaining_status','CANCELLED',
   'fulfilled_at_cancellation',(status->>'fulfilled')::numeric,'cancelled_remaining',(status->>'remaining')::numeric,
   'cancelled_at',at_time,'actor_id',actor.id);
  PERFORM app_private.inventory_audit('PENDING_REMAINING_CANCELLED',status||jsonb_build_object('id',p_source_id),result,p_reason);
 END IF;
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.cancel_receiving_pending_remaining(uuid,text,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.cancel_receiving_pending_remaining(uuid,text,uuid,text) TO authenticated;

COMMENT ON COLUMN public.receiving_arrivals.project_id IS
 'Current receiving metadata context, not stock ownership or routing. The first-post inventory transaction retains its original project as posting provenance; metadata edits never rewrite it.';
CREATE OR REPLACE FUNCTION public.update_receiving_arrival_metadata(p_request_id uuid,p_arrival_id uuid,p_expected_version bigint,p_project_id uuid,p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests; arrival public.receiving_arrivals; result jsonb; target record;
 payload jsonb:=jsonb_build_array('V5_METADATA',p_arrival_id,p_expected_version,p_project_id,p_notes);
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 SELECT * INTO arrival FROM public.receiving_arrivals WHERE id=p_arrival_id FOR UPDATE;
 IF arrival.id IS NULL OR arrival.voided_at IS NOT NULL OR arrival.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'ARRIVAL_VERSION_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'ARRIVAL_PROJECT_INVALID'; END IF;
 FOR target IN SELECT DISTINCT CASE WHEN m.project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END kind,
  COALESCE(m.project_material_id,m.se_supply_record_id) id FROM public.receiving_arrival_matches m
  JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id WHERE l.arrival_id=arrival.id AND m.cancelled_at IS NULL ORDER BY kind,id
 LOOP
  PERFORM app_private.receiving_source(target.kind,target.id);
 END LOOP;
 IF p_project_id IS DISTINCT FROM arrival.project_id AND EXISTS(
  SELECT 1 FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id
  LEFT JOIN public.project_materials p ON p.id=m.project_material_id LEFT JOIN public.se_supply_records s ON s.id=m.se_supply_record_id
  WHERE l.arrival_id=arrival.id AND m.cancelled_at IS NULL AND COALESCE(p.project_id,s.project_id) IS NOT NULL
   AND COALESCE(p.project_id,s.project_id) IS DISTINCT FROM p_project_id)
 THEN RAISE EXCEPTION 'ARRIVAL_PROJECT_CONFLICT_WITH_MATCH' USING ERRCODE='PT409'; END IF;
 UPDATE public.receiving_arrivals SET project_id=p_project_id,notes=p_notes,version=version+1,updated_at=clock_timestamp() WHERE id=arrival.id RETURNING to_jsonb(receiving_arrivals.*) INTO result;
 PERFORM app_private.inventory_audit('ARRIVAL_METADATA',to_jsonb(arrival),result,'Receiving metadata only; original Inventory posting provenance retained');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.update_receiving_arrival_metadata(uuid,uuid,bigint,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.update_receiving_arrival_metadata(uuid,uuid,bigint,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.match_receiving_arrival_line(p_request_id uuid,p_line_id uuid,p_quantity numeric,
 p_project_material_id uuid DEFAULT NULL,p_se_supply_record_id uuid DEFAULT NULL,p_entry_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('V5_MATCH',p_line_id,p_quantity,p_project_material_id,p_se_supply_record_id,p_entry_ids);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; source jsonb; source_id uuid; source_type text;
 used numeric; line_used numeric; result public.receiving_arrival_matches; item public.inventory_items;
 entry public.receiving_serial_entries; pending public.receiving_serial_entries; pending_id uuid;
 pending_count integer; unregistered integer:=0; already_unregistered integer; lookup record;
BEGIN
 IF p_request_id IS NULL OR num_nonnulls(p_project_material_id,p_se_supply_record_id)<>1 THEN RAISE EXCEPTION 'MATCH_REQUEST_SOURCE_REQUIRED'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 SELECT a.* INTO arrival FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id WHERE l.id=p_line_id FOR UPDATE OF a;
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state<>'POSTED' THEN RAISE EXCEPTION 'MATCH_REQUIRES_POSTED_ARRIVAL' USING ERRCODE='PT409'; END IF;
 source_id:=COALESCE(p_project_material_id,p_se_supply_record_id);
 source_type:=CASE WHEN p_project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END;
 source:=app_private.receiving_source(source_type,source_id);
 IF source->>'receiving_archived_at' IS NOT NULL OR (source_type='SE_SUPPLY' AND (source->>'receiving_only')::boolean IS DISTINCT FROM true)
  OR source->>'procurement_status'='RECEIVED' THEN RAISE EXCEPTION 'MATCH_PENDING_INACTIVE' USING ERRCODE='PT409'; END IF;
 -- Legacy receipts are not silently converted into matches. Projection is a V5-B decision.
 IF EXISTS(SELECT 1 FROM public.material_receipts WHERE project_material_id=p_project_material_id OR se_supply_record_id=p_se_supply_record_id)
 THEN RAISE EXCEPTION 'MATCH_LEGACY_RECEIPT_REQUIRES_PROJECTION' USING ERRCODE='PT409'; END IF;
 IF (source->>'inventory_item_id')::uuid IS DISTINCT FROM line.inventory_item_id OR source->>'unit' IS DISTINCT FROM line.unit THEN RAISE EXCEPTION 'MATCH_ITEM_UNIT_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF arrival.project_id IS NOT NULL AND source->>'project_id' IS NOT NULL AND arrival.project_id<>(source->>'project_id')::uuid THEN RAISE EXCEPTION 'MATCH_PROJECT_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'MATCH_QUANTITY'; END IF;
 SELECT COALESCE(sum(m.quantity),0) INTO used FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id JOIN public.receiving_arrivals a ON a.id=l.arrival_id
 WHERE m.cancelled_at IS NULL AND a.voided_at IS NULL AND (m.project_material_id=p_project_material_id OR m.se_supply_record_id=p_se_supply_record_id);
 SELECT COALESCE(sum(quantity),0) INTO line_used FROM public.receiving_arrival_matches WHERE arrival_line_id=line.id AND cancelled_at IS NULL;
 IF used+p_quantity>(source->>'quantity')::numeric OR line_used+p_quantity>line.quantity THEN RAISE EXCEPTION 'MATCH_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=line.inventory_item_id FOR UPDATE;
 IF item.requires_serial THEN
  IF cardinality(p_entry_ids) IS DISTINCT FROM p_quantity OR p_quantity<>trunc(p_quantity)
   OR (SELECT count(DISTINCT v) FROM unnest(p_entry_ids)v)<>p_quantity THEN RAISE EXCEPTION 'MATCH_SERIAL_COUNT'; END IF;
  IF (SELECT count(*) FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) AND arrival_line_id=line.id AND retired_at IS NULL AND active_receipt_id=line.receipt_id)<>p_quantity THEN RAISE EXCEPTION 'MATCH_SERIAL_OWNER'; END IF;
 ELSE IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION 'MATCH_NONSERIAL_ENTRIES'; END IF; END IF;
 INSERT INTO public.receiving_arrival_matches(arrival_line_id,project_material_id,se_supply_record_id,quantity,created_by)
 VALUES(line.id,p_project_material_id,p_se_supply_record_id,p_quantity,actor.id) RETURNING * INTO result;
 FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) ORDER BY id FOR UPDATE LOOP
  pending_id:=NULL;
  FOR pending IN SELECT * FROM public.receiving_serial_entries WHERE retired_at IS NULL
   AND (project_material_id=p_project_material_id OR se_supply_record_id=p_se_supply_record_id) ORDER BY id FOR UPDATE LOOP
   IF pending.inventory_item_id IS DISTINCT FROM line.inventory_item_id THEN RAISE EXCEPTION 'MATCH_PREDECLARED_ITEM_CONFLICT' USING ERRCODE='PT409'; END IF;
   IF pending.normalized_serial=entry.normalized_serial THEN pending_id:=pending.id; EXIT; END IF;
   SELECT * INTO lookup FROM public.lookup_inventory_serial(pending.raw_serial,NULL,NULL);
   IF lookup.result_type='unique_match' AND EXISTS(SELECT 1 FROM public.inventory_serials s WHERE s.id=entry.inventory_serial_id
    AND s.short_key=public.derive_inventory_serial_short_key(pending.raw_serial)
    AND public.classify_inventory_serial_format(pending.raw_serial)='short') THEN pending_id:=pending.id; EXIT; END IF;
  END LOOP;
  IF pending_id IS NULL THEN unregistered:=unregistered+1; END IF;
  INSERT INTO public.receiving_arrival_match_serials(match_id,arrival_entry_id,pending_entry_id) VALUES(result.id,entry.id,pending_id);
 END LOOP;
 IF item.requires_serial AND unregistered>0 THEN
  SELECT count(*) INTO pending_count FROM public.receiving_serial_entries WHERE retired_at IS NULL AND (project_material_id=p_project_material_id OR se_supply_record_id=p_se_supply_record_id);
  SELECT count(*) INTO already_unregistered FROM public.receiving_arrival_match_serials s JOIN public.receiving_arrival_matches m ON m.id=s.match_id
   WHERE s.pending_entry_id IS NULL AND m.cancelled_at IS NULL AND (m.project_material_id=p_project_material_id OR m.se_supply_record_id=p_se_supply_record_id);
  IF pending_count+already_unregistered>(source->>'quantity')::numeric THEN RAISE EXCEPTION 'MATCH_PREDECLARED_SERIAL_CONFLICT' USING ERRCODE='PT409'; END IF;
 END IF;
 -- Touch both capacity owners so repeatable-read callers also receive serialization conflicts.
 IF p_project_material_id IS NOT NULL THEN
  UPDATE public.project_materials SET updated_at=clock_timestamp() WHERE id=p_project_material_id;
 ELSE UPDATE public.se_supply_records SET updated_at=clock_timestamp() WHERE id=p_se_supply_record_id; END IF;
 UPDATE public.receiving_arrival_lines SET version=version+1,updated_at=clock_timestamp() WHERE id=line.id;
 -- The parent is also a compatibility owner for concurrent project edits at repeatable read.
 UPDATE public.receiving_arrivals SET version=version+1,updated_at=clock_timestamp() WHERE id=arrival.id;
 PERFORM app_private.inventory_audit('ARRIVAL_MATCH',NULL,to_jsonb(result),'Explicit pending match; no Inventory mutation');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,to_jsonb(result),now());
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.match_receiving_arrival_line(uuid,uuid,numeric,uuid,uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.match_receiving_arrival_line(uuid,uuid,numeric,uuid,uuid,uuid[]) TO authenticated;



CREATE FUNCTION app_private.receiving_line_match_snapshot(p_line_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path='' AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(m)||jsonb_build_object('serials',
  (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.arrival_entry_id),'[]') FROM public.receiving_arrival_match_serials s WHERE s.match_id=m.id))
  ORDER BY m.id),'[]') FROM public.receiving_arrival_matches m WHERE m.arrival_line_id=p_line_id AND m.cancelled_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_private.receiving_line_match_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Final desired active set. An empty array explicitly unmatches the line.
-- expected_version is the persisted line version, not the arrival metadata version.
CREATE FUNCTION public.replace_receiving_arrival_matches(p_request_id uuid,p_line_id uuid,p_expected_version bigint,p_matches jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('V5_REPLACE_MATCHES',p_line_id,p_expected_version,p_matches);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; spec jsonb; target record;
 before_matches jsonb; after_matches jsonb; result jsonb; entries uuid[]; at_time timestamptz;
BEGIN
 IF p_request_id IS NULL OR p_line_id IS NULL OR p_expected_version IS NULL
  OR jsonb_typeof(p_matches) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'MATCH_REPLACEMENT_REQUEST_REQUIRED'; END IF;
 IF jsonb_array_length(p_matches)>200 THEN RAISE EXCEPTION 'MATCH_REPLACEMENT_LIMIT'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 SELECT a.* INTO arrival FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id WHERE l.id=p_line_id FOR UPDATE OF a;
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state<>'POSTED' THEN RAISE EXCEPTION 'MATCH_REQUIRES_POSTED_ARRIVAL' USING ERRCODE='PT409'; END IF;
 IF line.version<>p_expected_version THEN RAISE EXCEPTION 'MATCH_LINE_VERSION_CONFLICT' USING ERRCODE='PT409'; END IF;
 FOR spec IN SELECT value FROM jsonb_array_elements(p_matches) LOOP
  IF jsonb_typeof(spec) IS DISTINCT FROM 'object'
   OR num_nonnulls(spec->>'project_material_id',spec->>'se_supply_record_id')<>1
   OR jsonb_typeof(COALESCE(spec->'entry_ids','[]')) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'MATCH_REPLACEMENT_SPEC'; END IF;
 END LOOP;
 -- Lock the complete union of old and desired sources in one stable order.
 FOR target IN
  SELECT DISTINCT kind,id FROM (
   SELECT CASE WHEN project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END kind,
    COALESCE(project_material_id,se_supply_record_id) id FROM public.receiving_arrival_matches WHERE arrival_line_id=line.id AND cancelled_at IS NULL
   UNION ALL
   SELECT CASE WHEN value->>'project_material_id' IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END,
    COALESCE(value->>'project_material_id',value->>'se_supply_record_id')::uuid FROM jsonb_array_elements(p_matches)
  ) sources ORDER BY kind,id
 LOOP
  PERFORM app_private.receiving_source(target.kind,target.id);
  -- Freed capacity must conflict with stale repeatable-read consumers, too.
  IF target.kind='PROJECT_MATERIAL' THEN UPDATE public.project_materials SET updated_at=clock_timestamp() WHERE id=target.id;
  ELSE UPDATE public.se_supply_records SET updated_at=clock_timestamp() WHERE id=target.id; END IF;
 END LOOP;
 before_matches:=app_private.receiving_line_match_snapshot(line.id);
 at_time:=clock_timestamp();
 UPDATE public.receiving_arrival_matches SET cancelled_at=at_time WHERE arrival_line_id=line.id AND cancelled_at IS NULL;
 -- Reuse the authoritative V5-A item/unit/project/serial/capacity resolver.
 -- Failure of any desired allocation rolls back every cancellation and replacement.
 FOR spec IN SELECT value FROM jsonb_array_elements(p_matches) ORDER BY
  CASE WHEN value->>'project_material_id' IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END,
  COALESCE(value->>'project_material_id',value->>'se_supply_record_id'),value::text
 LOOP
  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid),'{}') INTO entries FROM jsonb_array_elements_text(COALESCE(spec->'entry_ids','[]'));
  PERFORM public.match_receiving_arrival_line(gen_random_uuid(),line.id,(spec->>'quantity')::numeric,
   (spec->>'project_material_id')::uuid,(spec->>'se_supply_record_id')::uuid,entries);
 END LOOP;
 UPDATE public.receiving_arrival_lines SET version=version+1,updated_at=clock_timestamp() WHERE id=line.id RETURNING * INTO line;
 UPDATE public.receiving_arrivals SET version=version+1,updated_at=clock_timestamp() WHERE id=arrival.id;
 after_matches:=app_private.receiving_line_match_snapshot(line.id);
 result:=jsonb_build_object('id',line.id,'arrival_line_id',line.id,'version',line.version,'matches',after_matches,'outcome','REPLACED');
 PERFORM app_private.inventory_audit('ARRIVAL_MATCHES_REPLACED',
  jsonb_build_object('id',line.id,'matches',before_matches),
  result||jsonb_build_object('actor_id',actor.id,'adjusted_at',at_time),'Replace fulfilment only; no Inventory or receipt mutation');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.replace_receiving_arrival_matches(uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.replace_receiving_arrival_matches(uuid,uuid,bigint,jsonb) TO authenticated;

NOTIFY pgrst,'reload schema';
