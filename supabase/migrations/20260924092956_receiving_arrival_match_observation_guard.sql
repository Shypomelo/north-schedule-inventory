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
 PERFORM app_private.inventory_audit('ARRIVAL_MATCH',NULL,to_jsonb(result),'Explicit pending match; no Inventory mutation');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,to_jsonb(result),now());
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.match_receiving_arrival_line(uuid,uuid,numeric,uuid,uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.match_receiving_arrival_line(uuid,uuid,numeric,uuid,uuid,uuid[]) TO authenticated;
