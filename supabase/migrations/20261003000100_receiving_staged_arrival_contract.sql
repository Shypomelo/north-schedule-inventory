-- Physical arrival is a quantity observation. Inventory ownership starts only
-- at an explicit receipt posting. Existing ARRIVAL receipts remain POSTED.
ALTER TABLE public.receiving_arrival_lines DROP CONSTRAINT receiving_arrival_lines_resolution_state_check;
ALTER TABLE public.receiving_arrival_lines ADD CONSTRAINT receiving_arrival_lines_resolution_state_check
 CHECK (resolution_state IN ('UNRESOLVED','STAGED','POSTED'));
ALTER TABLE public.receiving_arrival_lines DROP CONSTRAINT receiving_arrival_lines_check;
ALTER TABLE public.receiving_arrival_lines ADD CONSTRAINT receiving_arrival_lines_check CHECK (
 (resolution_state='UNRESOLVED' AND inventory_item_id IS NULL AND receipt_id IS NULL AND posting_date IS NULL)
 OR (resolution_state='STAGED' AND inventory_item_id IS NOT NULL AND unit IS NOT NULL
     AND (receipt_id IS NULL)=(posting_date IS NULL))
 OR (resolution_state='POSTED' AND inventory_item_id IS NOT NULL AND unit IS NOT NULL
     AND receipt_id IS NOT NULL AND posting_date IS NOT NULL));
ALTER TABLE public.material_receipts ADD COLUMN route_arrival_line_id uuid
 REFERENCES public.receiving_arrival_lines(id) ON DELETE RESTRICT;
ALTER TABLE public.material_receipts DROP CONSTRAINT material_receipts_single_source_check;
ALTER TABLE public.material_receipts ADD CONSTRAINT material_receipts_single_source_check CHECK (
 (source_type='PROJECT_MATERIAL' AND project_material_id IS NOT NULL AND se_supply_record_id IS NULL
  AND arrival_line_id IS NULL AND route_arrival_line_id IS NULL)
 OR (source_type='SE_SUPPLY' AND se_supply_record_id IS NOT NULL AND project_material_id IS NULL
  AND arrival_line_id IS NULL AND route_arrival_line_id IS NULL)
 OR (source_type='ARRIVAL' AND arrival_line_id IS NOT NULL AND route_arrival_line_id IS NULL
  AND project_material_id IS NULL AND se_supply_record_id IS NULL)
 OR (source_type='ARRIVAL_ROUTE' AND route_arrival_line_id IS NOT NULL AND arrival_line_id IS NULL
  AND project_material_id IS NULL AND se_supply_record_id IS NULL));
ALTER TABLE public.material_receipts ADD CONSTRAINT route_arrival_receipt_office CHECK (
 route_arrival_line_id IS NULL OR
 (receipt_location IS NOT DISTINCT FROM 'OFFICE' AND inventory_linked AND inventory_transaction_id IS NOT NULL));
CREATE INDEX material_receipts_route_arrival_line_idx ON public.material_receipts(route_arrival_line_id,created_at,id)
 WHERE route_arrival_line_id IS NOT NULL;

-- The old private first-post helper is retained for historical function
-- references, but it cannot be used to post a newly staged line.
CREATE OR REPLACE FUNCTION app_private.post_receiving_arrival_line(p_line_id uuid,p_item_id uuid,p_posting_date date)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 RAISE EXCEPTION 'USE_ROUTE_ARRIVAL_POST' USING ERRCODE='PT409';
END $$;
REVOKE ALL ON FUNCTION app_private.post_receiving_arrival_line(uuid,uuid,date)
 FROM PUBLIC,anon,authenticated,service_role;

-- Keep the public signature so existing clients can submit physical arrivals.
-- Reject the old posting-date argument to prevent a caller assuming an IN.
CREATE OR REPLACE FUNCTION public.create_receiving_arrival(p_request_id uuid,p_actual_received_at timestamptz,p_lines jsonb,
 p_project_id uuid DEFAULT NULL,p_notes text DEFAULT NULL,p_posting_date date DEFAULT NULL,p_matches jsonb DEFAULT '[]',p_match_all_or_nothing boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('STAGED_CREATE',p_actual_received_at,p_lines,p_project_id,p_notes,p_posting_date,p_matches,p_match_all_or_nothing);
 arrival public.receiving_arrivals; line public.receiving_arrival_lines; spec jsonb; raw jsonb; raw_text text;
 lines jsonb:='[]'; match_results jsonb:='[]'; result jsonb; request jsonb; line_id uuid; obs uuid[];
 item public.inventory_items; qty numeric; unit_value text; serials jsonb;
BEGIN
 IF p_request_id IS NULL OR p_actual_received_at IS NULL OR NOT isfinite(p_actual_received_at)
 THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_TIME_REQUIRED'; END IF;
 IF p_posting_date IS NOT NULL THEN
  RAISE EXCEPTION 'ARRIVAL_POSTING_DATE_NOT_APPLICABLE' USING ERRCODE='PT409'; END IF;
 IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines)<1 OR jsonb_array_length(p_lines)>200
  OR jsonb_typeof(p_matches) IS DISTINCT FROM 'array' OR p_match_all_or_nothing IS NULL
 THEN RAISE EXCEPTION 'ARRIVAL_LINES_MATCHES_REQUIRED'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'ARRIVAL_PROJECT_INVALID'; END IF;
 INSERT INTO public.receiving_arrivals(actual_received_at,project_id,notes,created_by)
 VALUES(p_actual_received_at,p_project_id,p_notes,actor.id) RETURNING * INTO arrival;
 FOR spec IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
  IF jsonb_typeof(spec) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ARRIVAL_LINE_OBJECT'; END IF;
  qty:=(spec->>'quantity')::numeric; unit_value:=NULLIF(btrim(spec->>'unit'),''); serials:=COALESCE(spec->'raw_serials','[]');
  IF qty IS NULL OR qty<=0 OR qty::text IN ('NaN','Infinity','-Infinity')
   OR jsonb_typeof(serials) IS DISTINCT FROM 'array' OR jsonb_array_length(serials)>1000
  THEN RAISE EXCEPTION 'ARRIVAL_LINE_QUANTITY_OR_SERIALS'; END IF;
  IF spec->>'inventory_item_id' IS NOT NULL THEN
   SELECT * INTO item FROM public.inventory_items WHERE id=(spec->>'inventory_item_id')::uuid FOR UPDATE;
   IF item.id IS NULL OR NOT item.is_active OR (unit_value IS NOT NULL AND unit_value<>item.unit)
   THEN RAISE EXCEPTION 'ARRIVAL_ITEM_UNIT_CONFLICT' USING ERRCODE='PT409'; END IF;
   unit_value:=item.unit;
   IF item.requires_serial AND (qty<>trunc(qty) OR jsonb_array_length(serials)<>qty)
   THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_COUNT'; END IF;
   IF NOT item.requires_serial AND jsonb_array_length(serials)<>0
   THEN RAISE EXCEPTION 'ARRIVAL_NONSERIAL_HAS_SERIAL'; END IF;
  ELSE
   item:=NULL;
   IF jsonb_array_length(serials)=0 OR qty IS DISTINCT FROM jsonb_array_length(serials)::numeric
   THEN RAISE EXCEPTION 'UNKNOWN_ARRIVAL_REQUIRES_SERIAL_OBSERVATIONS'; END IF;
  END IF;
  INSERT INTO public.receiving_arrival_lines(arrival_id,inventory_item_id,quantity,unit,resolution_state)
   VALUES(arrival.id,item.id,qty,unit_value,CASE WHEN item.id IS NULL THEN 'UNRESOLVED' ELSE 'STAGED' END)
   RETURNING * INTO line;
  FOR raw IN SELECT value FROM jsonb_array_elements(serials) LOOP
   IF jsonb_typeof(raw) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'ARRIVAL_RAW_SERIAL_STRING'; END IF;
   raw_text:=raw#>>'{}';
   IF public.classify_inventory_serial_format(raw_text)='unknown' OR NULLIF(btrim(raw_text),'') IS NULL
   THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_FORMAT'; END IF;
   INSERT INTO public.receiving_serial_entries(arrival_line_id,inventory_item_id,raw_serial,created_by)
    VALUES(line.id,item.id,raw_text,actor.id);
  END LOOP;
  lines:=lines||jsonb_build_array(to_jsonb(line));
 END LOOP;
 FOR request IN SELECT value FROM jsonb_array_elements(p_matches) LOOP
  BEGIN
   IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR (request->>'line_index')::integer IS NULL
    OR (request->>'line_index')::integer<0 OR (request->>'line_index')::integer>=jsonb_array_length(lines)
   THEN RAISE EXCEPTION 'MATCH_LINE_INDEX'; END IF;
   line_id:=(lines->((request->>'line_index')::integer)->>'id')::uuid;
   SELECT COALESCE(array_agg(e.id ORDER BY e.id),'{}') INTO obs FROM public.receiving_serial_entries e
    WHERE e.arrival_line_id=line_id AND e.normalized_serial IN
     (SELECT public.normalize_inventory_serial(value) FROM jsonb_array_elements_text(COALESCE(request->'raw_serials','[]')));
   result:=public.match_receiving_arrival_line(gen_random_uuid(),line_id,(request->>'quantity')::numeric,
    (request->>'project_material_id')::uuid,(request->>'se_supply_record_id')::uuid,obs);
   match_results:=match_results||jsonb_build_array(jsonb_build_object('status','MATCHED','match',result));
  EXCEPTION WHEN OTHERS THEN
   IF p_match_all_or_nothing THEN RAISE; END IF;
   match_results:=match_results||jsonb_build_array(jsonb_build_object('status','CONFLICT','code',SQLSTATE,'message',SQLERRM));
  END;
 END LOOP;
 result:=jsonb_build_object('arrival',to_jsonb(arrival),'lines',lines,'matches',match_results);
 PERFORM app_private.inventory_audit('ARRIVAL_CREATED',NULL,result||jsonb_build_object('id',arrival.id,'project_id',arrival.project_id),'Physical arrival; inventory effect zero');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_receiving_arrival(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_receiving_arrival(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean)
 TO authenticated;

-- Resolving an unknown item's identity changes only the staging line.
CREATE OR REPLACE FUNCTION public.complete_receiving_arrival_line(p_request_id uuid,p_line_id uuid,p_item_id uuid,p_posting_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('STAGE_ARRIVAL_ITEM',p_line_id,p_item_id,p_posting_date);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; item public.inventory_items;
 serial_count integer;
BEGIN
 IF p_request_id IS NULL OR p_line_id IS NULL OR p_item_id IS NULL THEN RAISE EXCEPTION 'STAGE_ITEM_REQUEST_REQUIRED'; END IF;
 IF p_posting_date IS NOT NULL THEN
  RAISE EXCEPTION 'ARRIVAL_POSTING_DATE_NOT_APPLICABLE' USING ERRCODE='PT409'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT a.* INTO arrival FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
  WHERE l.id=p_line_id FOR UPDATE OF a;
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 SELECT * INTO item FROM public.inventory_items WHERE id=p_item_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state<>'UNRESOLVED'
  OR item.id IS NULL OR NOT item.is_active OR (line.unit IS NOT NULL AND line.unit<>item.unit)
 THEN RAISE EXCEPTION 'ARRIVAL_IDENTITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT count(*) INTO serial_count FROM public.receiving_serial_entries
  WHERE arrival_line_id=line.id AND retired_at IS NULL;
 IF item.requires_serial AND (line.quantity<>trunc(line.quantity) OR serial_count<>line.quantity)
  OR NOT item.requires_serial AND serial_count<>0
 THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_COUNT' USING ERRCODE='PT409'; END IF;
 UPDATE public.receiving_arrival_lines SET inventory_item_id=item.id,unit=item.unit,resolution_state='STAGED',
  version=version+1,updated_at=clock_timestamp() WHERE id=line.id RETURNING * INTO line;
 UPDATE public.receiving_serial_entries SET inventory_item_id=item.id,updated_at=clock_timestamp()
  WHERE arrival_line_id=line.id;
 PERFORM app_private.inventory_audit('ARRIVAL_STAGED',NULL,to_jsonb(line),'Item resolved; no Inventory mutation');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,to_jsonb(line),now());
 RETURN to_jsonb(line);
END $$;
REVOKE ALL ON FUNCTION public.complete_receiving_arrival_line(uuid,uuid,uuid,date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.complete_receiving_arrival_line(uuid,uuid,uuid,date) TO authenticated;

-- A route receipt represents only the selected portion of a staged line.
-- The line remains STAGED until its entire physical quantity has been posted.
CREATE FUNCTION public.post_receiving_arrival_line(
 p_request_id uuid,p_line_id uuid,p_quantity numeric,p_entry_ids uuid[],p_posting_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('ROUTE_ARRIVAL_POST',p_line_id,p_quantity,p_entry_ids,p_posting_date);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; item public.inventory_items;
 entry public.receiving_serial_entries; serial public.inventory_serials; lookup record;
 names jsonb:='[]'; tx jsonb; receipt public.material_receipts; posted numeric; net_posted numeric; selected integer;
 posting date:=COALESCE(p_posting_date,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date);
 result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_line_id IS NULL OR p_quantity IS NULL OR p_quantity<=0
  OR p_quantity::text IN ('NaN','Infinity','-Infinity') OR posting IS NULL OR NOT isfinite(posting)
 THEN RAISE EXCEPTION 'INVALID_ROUTE_ARRIVAL_POST' USING ERRCODE='22023'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT a.* INTO arrival FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
  WHERE l.id=p_line_id FOR UPDATE OF a;
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state NOT IN ('STAGED','POSTED')
 THEN RAISE EXCEPTION 'ARRIVAL_NOT_STAGED' USING ERRCODE='PT409'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=line.inventory_item_id FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active OR item.unit IS DISTINCT FROM line.unit
 THEN RAISE EXCEPTION 'ARRIVAL_ITEM_UNIT_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(quantity_received),0) INTO posted FROM public.material_receipts
  WHERE route_arrival_line_id=line.id AND source_type='ARRIVAL_ROUTE' AND event_type='RECEIVE'
   AND reentry_of_reversal_id IS NULL;
 IF posted+p_quantity>line.quantity THEN RAISE EXCEPTION 'ARRIVAL_POST_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT x) FROM unnest(p_entry_ids)x)<>p_quantity
  THEN RAISE EXCEPTION 'ARRIVAL_POST_SERIAL_COUNT' USING ERRCODE='PT409'; END IF;
  SELECT count(*) INTO selected FROM public.receiving_serial_entries
   WHERE id=ANY(p_entry_ids) AND arrival_line_id=line.id AND retired_at IS NULL
    AND inventory_serial_id IS NULL AND active_receipt_id IS NULL;
  IF selected<>p_quantity THEN RAISE EXCEPTION 'ARRIVAL_POST_SERIAL_SCOPE' USING ERRCODE='PT409'; END IF;
  IF EXISTS(SELECT 1 FROM public.receiving_serial_entries a JOIN public.receiving_serial_entries b
   ON a.arrival_line_id=b.arrival_line_id AND a.id<>b.id
   AND public.derive_inventory_serial_short_key(a.raw_serial)=public.derive_inventory_serial_short_key(b.raw_serial)
   WHERE a.arrival_line_id=line.id AND public.classify_inventory_serial_format(a.raw_serial)='short')
  THEN RAISE EXCEPTION 'ARRIVAL_AMBIGUOUS_SERIAL' USING ERRCODE='PT409'; END IF;
  FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids)
   ORDER BY normalized_serial FOR UPDATE LOOP
   SELECT * INTO lookup FROM public.lookup_inventory_serial(entry.raw_serial,NULL,NULL);
   IF lookup.result_type IS DISTINCT FROM 'no_match'
   THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_IDENTITY_CONFLICT: %',lookup.result_type USING ERRCODE='PT409'; END IF;
   names:=names||jsonb_build_array(entry.normalized_serial);
  END LOOP;
 ELSE
  IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION 'ARRIVAL_NONSERIAL_HAS_SERIAL'; END IF;
 END IF;
 tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object(
  'item_id',item.id,'transaction_type','IN','quantity',p_quantity,'unit',item.unit,
  'transaction_date',posting,'project_id',arrival.project_id,'source','ARRIVAL_ROUTE','notes',arrival.notes),names);
 INSERT INTO public.material_receipts(source_type,route_arrival_line_id,event_type,quantity_received,
  received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
 VALUES('ARRIVAL_ROUTE',line.id,'RECEIVE',p_quantity,actor.id,clock_timestamp(),arrival.notes,
  'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO receipt;
 IF item.requires_serial THEN
  FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) ORDER BY id LOOP
   SELECT * INTO STRICT serial FROM public.inventory_serials WHERE normalized_full=entry.normalized_serial;
   INSERT INTO public.material_receipt_serials(receipt_id,entry_id,inventory_serial_id,linked_existing,inventory_snapshot)
    VALUES(receipt.id,entry.id,serial.id,false,to_jsonb(serial));
   UPDATE public.receiving_serial_entries SET inventory_serial_id=serial.id,active_receipt_id=receipt.id,
    updated_at=clock_timestamp() WHERE id=entry.id;
  END LOOP;
 END IF;
 SELECT COALESCE(sum(CASE WHEN event_type='RECEIVE' THEN quantity_received ELSE -quantity_received END),0)
 INTO net_posted FROM public.material_receipts WHERE route_arrival_line_id=line.id;
 UPDATE public.receiving_arrival_lines SET
  resolution_state=CASE WHEN net_posted=line.quantity THEN 'POSTED' ELSE 'STAGED' END,
  receipt_id=COALESCE(line.receipt_id,receipt.id),posting_date=COALESCE(line.posting_date,posting),
  version=version+1,updated_at=clock_timestamp() WHERE id=line.id RETURNING * INTO line;
 result:=jsonb_build_object('line',to_jsonb(line),'receipt',to_jsonb(receipt),
  'inventory_transaction',tx,'remaining_staged_quantity',line.quantity-net_posted);
 PERFORM app_private.inventory_audit('ARRIVAL_ROUTE_POST',NULL,result,'Explicit Inventory Receipt');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.post_receiving_arrival_line(uuid,uuid,numeric,uuid[],date)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.post_receiving_arrival_line(uuid,uuid,numeric,uuid[],date) TO authenticated;

-- Pending fulfilment is consumed by a physical match. Posting only changes
-- the inventory projection, so it cannot consume Pending a second time.
CREATE OR REPLACE FUNCTION public.get_receiving_pending_fulfilment(
 p_project_material_id uuid DEFAULT NULL,p_se_supply_record_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE source jsonb; total numeric; fulfilled numeric;
 cancellation jsonb; active boolean; state text; kind text; source_id uuid;
BEGIN
 IF NOT COALESCE(app_private.is_active_member(),false)
 THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF num_nonnulls(p_project_material_id,p_se_supply_record_id)<>1
 THEN RAISE EXCEPTION 'One pending source required'; END IF;
 source_id:=COALESCE(p_project_material_id,p_se_supply_record_id);
 kind:=CASE WHEN p_project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END;
 IF p_project_material_id IS NOT NULL THEN
  SELECT to_jsonb(m) INTO source FROM public.project_materials m
   WHERE id=p_project_material_id AND delivery_destination='OFFICE';
 ELSE
  SELECT to_jsonb(s) INTO source FROM public.se_supply_records s
   WHERE id=p_se_supply_record_id AND receiving_only;
 END IF;
 IF source IS NULL THEN RAISE EXCEPTION 'Pending not found'; END IF;
 total:=(source->>'quantity')::numeric;
 SELECT COALESCE(sum(m.quantity),0) INTO fulfilled
 FROM public.receiving_arrival_matches m
 JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id
 JOIN public.receiving_arrivals a ON a.id=l.arrival_id
 WHERE m.cancelled_at IS NULL AND a.voided_at IS NULL
  AND l.resolution_state IN ('STAGED','POSTED')
  AND (m.project_material_id=p_project_material_id OR m.se_supply_record_id=p_se_supply_record_id);
 SELECT changes->'after' INTO cancellation FROM public.activity_logs
  WHERE action='PENDING_REMAINING_CANCELLED' AND target_id=source_id::text
   AND changes->'after'->>'source_type'=kind
  ORDER BY created_at DESC,id DESC LIMIT 1;
 active:=source->>'receiving_archived_at' IS NULL AND source->>'cancelled_at' IS NULL
  AND COALESCE(source->>'procurement_status','')<>'RECEIVED' AND total>fulfilled;
 state:=CASE WHEN cancellation IS NOT NULL THEN 'CANCELLED'
  WHEN total<=fulfilled THEN 'FULFILLED' WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END;
 RETURN jsonb_build_object('quantity',total,'expected',total,'fulfilled',fulfilled,
  'physical_arrived',fulfilled,
  'remaining',total-fulfilled,'remaining_status',state,'active',active,'cancellation',cancellation);
END $$;
REVOKE ALL ON FUNCTION public.get_receiving_pending_fulfilment(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_receiving_pending_fulfilment(uuid,uuid) TO authenticated;


-- Physical matches consume Pending at STAGED or POSTED; no Inventory write.
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
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state NOT IN ('STAGED','POSTED') THEN RAISE EXCEPTION 'MATCH_REQUIRES_POSTED_ARRIVAL' USING ERRCODE='PT409'; END IF;
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
  IF (SELECT count(*) FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) AND arrival_line_id=line.id AND retired_at IS NULL AND (line.resolution_state='STAGED' OR active_receipt_id=line.receipt_id))<>p_quantity THEN RAISE EXCEPTION 'MATCH_SERIAL_OWNER'; END IF;
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

CREATE OR REPLACE FUNCTION public.replace_receiving_arrival_matches(p_request_id uuid,p_line_id uuid,p_expected_version bigint,p_matches jsonb)
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
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state NOT IN ('STAGED','POSTED') THEN RAISE EXCEPTION 'MATCH_REQUIRES_POSTED_ARRIVAL' USING ERRCODE='PT409'; END IF;
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


-- V6 legacy reversal behavior is retained; route receipts use the same canonical writer.
CREATE OR REPLACE FUNCTION public.reverse_receiving_inventory_in(
 p_request_id uuid,p_receipt_id uuid,p_quantity numeric,p_entry_ids uuid[],
 p_reversed_at timestamptz,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor();
 payload jsonb:=jsonb_build_array('REVERSE_RECEIVING_IN',p_receipt_id,p_quantity,p_entry_ids,p_reversed_at,p_reason);
 cached app_private.receiving_requests; receipt public.material_receipts;
 reversal public.material_receipts; origin public.inventory_transactions; item public.inventory_items;
 tx jsonb; result jsonb; names jsonb:='[]'; selected integer; already numeric;
BEGIN
 IF p_request_id IS NULL OR p_reversed_at IS NULL OR NOT isfinite(p_reversed_at)
  OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity')
  OR NULLIF(btrim(p_reason),'') IS NULL
 THEN RAISE EXCEPTION 'INVALID_RECEIPT_REVERSAL_REQUEST' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 -- Safe Delete takes the SE table before the request lock. Fail fast if it
 -- owns the table, so this request lock cannot form the opposite wait edge.
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload
  THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=p_receipt_id;
 IF receipt.id IS NULL OR receipt.event_type<>'RECEIVE' OR receipt.receipt_location IS DISTINCT FROM 'OFFICE'
  OR NOT receipt.inventory_linked OR receipt.inventory_transaction_id IS NULL
  OR p_reversed_at<receipt.received_at
 THEN RAISE EXCEPTION 'OFFICE_IN_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF receipt.source_type IN ('ARRIVAL','ARRIVAL_ROUTE') THEN
  PERFORM 1 FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
   WHERE l.id=COALESCE(receipt.route_arrival_line_id,receipt.arrival_line_id)
    AND (receipt.source_type='ARRIVAL_ROUTE' OR l.receipt_id=app_private.receiving_arrival_anchor_receipt(receipt.id))
    AND l.resolution_state IN ('STAGED','POSTED') AND a.voided_at IS NULL FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'ARRIVAL_RECEIPT_INACTIVE' USING ERRCODE='23514'; END IF;
  UPDATE public.receiving_arrivals SET version=version WHERE id=(
   SELECT arrival_id FROM public.receiving_arrival_lines WHERE id=COALESCE(receipt.route_arrival_line_id,receipt.arrival_line_id));
  PERFORM 1 FROM public.receiving_arrival_lines WHERE id=COALESCE(receipt.route_arrival_line_id,receipt.arrival_line_id) FOR UPDATE;
 ELSE
  PERFORM app_private.receiving_source(receipt.source_type,COALESCE(receipt.project_material_id,receipt.se_supply_record_id));
 END IF;
 SELECT * INTO origin FROM public.inventory_transactions WHERE id=receipt.inventory_transaction_id;
 SELECT * INTO item FROM public.inventory_items WHERE id=origin.item_id FOR UPDATE;
 SELECT * INTO origin FROM public.inventory_transactions WHERE id=receipt.inventory_transaction_id FOR UPDATE;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=p_receipt_id FOR UPDATE;
 IF item.id IS NULL OR origin.id IS NULL OR origin.transaction_type<>'IN' OR origin.is_voided
  OR origin.excluded_by_initialization_id IS NOT NULL
 THEN RAISE EXCEPTION 'RECEIPT_IN_ORIGIN_INVALID' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(quantity_received),0) INTO already FROM public.material_receipts
  WHERE reversal_of_id=receipt.id AND event_type='REVERSAL';
 IF already+p_quantity>receipt.quantity_received
 THEN RAISE EXCEPTION 'RECEIPT_REVERSAL_EXCEEDS_ORIGIN' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations a
  WHERE a.office_receipt_id=receipt.id AND a.cancelled_at IS NULL
   AND (a.inventory_serial_id IS NULL OR a.inventory_serial_id IN (
    SELECT rs.inventory_serial_id FROM public.material_receipt_serials rs
    WHERE rs.receipt_id=receipt.id AND rs.entry_id=ANY(p_entry_ids))))
 THEN RAISE EXCEPTION 'RECEIPT_HAS_DOWNSTREAM_HANDOFF' USING ERRCODE='23514'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT x) FROM unnest(p_entry_ids)x)<>p_quantity
  THEN RAISE EXCEPTION 'RECEIPT_SERIAL_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT count(*),COALESCE(jsonb_agg(s.serial_number ORDER BY s.id),'[]') INTO selected,names
   FROM public.material_receipt_serials rs
   JOIN public.receiving_serial_entries e ON e.id=rs.entry_id
   JOIN public.inventory_serials s ON s.id=rs.inventory_serial_id
   WHERE rs.receipt_id=receipt.id AND rs.entry_id=ANY(p_entry_ids)
    AND NOT rs.linked_existing AND e.active_receipt_id=receipt.id
    AND s.item_id=item.id AND EXISTS(SELECT 1 FROM public.inventory_transaction_serials l
     WHERE l.transaction_id=origin.id AND l.serial_id=s.id);
  IF selected<>p_quantity THEN RAISE EXCEPTION 'RECEIPT_SERIAL_PROVENANCE_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
  IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION 'NON_SERIAL_ENTRY_IDS_NOT_ALLOWED' USING ERRCODE='23514'; END IF;
 END IF;
 INSERT INTO app_private.inventory_reversal_context VALUES(pg_backend_pid(),txid_current(),receipt.id);
 tx:=public.write_inventory_transaction_atomic('REVERSE_IN',jsonb_build_object(
  'item_id',item.id,'quantity',p_quantity,'transaction_date',(p_reversed_at AT TIME ZONE 'Asia/Taipei')::date),
  names,origin.id,p_reason,origin.updated_at);
 IF receipt.source_type='ARRIVAL_ROUTE' THEN
  INSERT INTO public.material_receipts(source_type,route_arrival_line_id,event_type,reversal_of_id,
   quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
  VALUES('ARRIVAL_ROUTE',receipt.route_arrival_line_id,'REVERSAL',receipt.id,p_quantity,actor.id,p_reversed_at,
   p_reason,'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO reversal;
 ELSIF receipt.source_type='ARRIVAL' THEN
  INSERT INTO public.material_receipts(source_type,arrival_line_id,event_type,reversal_of_id,
   quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
  VALUES('ARRIVAL',receipt.arrival_line_id,'REVERSAL',receipt.id,p_quantity,actor.id,p_reversed_at,
   p_reason,'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO reversal;
 ELSE
  SELECT * INTO reversal FROM app_private.append_receiving_reversal(receipt.id,p_quantity,p_reversed_at,p_reason);
  UPDATE public.material_receipts SET receipt_location='OFFICE',inventory_linked=true,
   inventory_transaction_id=(tx->>'id')::uuid WHERE id=reversal.id RETURNING * INTO reversal;
 END IF;
 IF receipt.source_type='ARRIVAL_ROUTE' THEN
  UPDATE public.receiving_arrival_lines SET resolution_state='STAGED',version=version+1,updated_at=clock_timestamp()
   WHERE id=receipt.route_arrival_line_id;
 END IF;
 IF item.requires_serial THEN
  INSERT INTO public.material_receipt_serials(receipt_id,entry_id,inventory_serial_id,linked_existing,inventory_snapshot)
   SELECT reversal.id,rs.entry_id,rs.inventory_serial_id,rs.linked_existing,rs.inventory_snapshot
   FROM public.material_receipt_serials rs WHERE rs.receipt_id=receipt.id AND rs.entry_id=ANY(p_entry_ids);
  UPDATE public.receiving_serial_entries SET active_receipt_id=NULL,updated_at=clock_timestamp()
   WHERE id=ANY(p_entry_ids);
 END IF;
 DELETE FROM app_private.inventory_reversal_context
  WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 result:=jsonb_build_object('receipt',to_jsonb(reversal),'inventory_transaction',tx,
  'staged_quantity',p_quantity);
 PERFORM app_private.inventory_audit('REVERSE_RECEIVING_IN',to_jsonb(receipt),
  to_jsonb(reversal)||jsonb_build_object('inventory_transaction',tx),p_reason);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.reverse_receiving_inventory_in(uuid,uuid,numeric,uuid[],timestamptz,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.reverse_receiving_inventory_in(uuid,uuid,numeric,uuid[],timestamptz,text) TO authenticated;


-- Re-entry of a route reversal adds a fresh IN and receipt event.
CREATE OR REPLACE FUNCTION public.reenter_receiving_inventory(
 p_request_id uuid,p_reversal_receipt_id uuid,p_quantity numeric,p_entry_ids uuid[],
 p_received_at timestamptz,p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor();
 payload jsonb:=jsonb_build_array('REENTER_RECEIVING_IN',p_reversal_receipt_id,p_quantity,p_entry_ids,p_received_at,p_notes);
 cached app_private.receiving_requests; reversed public.material_receipts;
 receipt public.material_receipts; original public.material_receipts;
 reversal_tx public.inventory_transactions; item public.inventory_items;
 tx jsonb; result jsonb; names jsonb:='[]'; selected integer; staged numeric;
BEGIN
 IF p_request_id IS NULL OR p_received_at IS NULL OR NOT isfinite(p_received_at)
  OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'INVALID_RECEIPT_REENTRY_REQUEST' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload
  THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT * INTO reversed FROM public.material_receipts WHERE id=p_reversal_receipt_id;
 IF reversed.id IS NULL OR reversed.event_type<>'REVERSAL' OR reversed.receipt_location IS DISTINCT FROM 'OFFICE'
  OR NOT reversed.inventory_linked OR reversed.inventory_transaction_id IS NULL
  OR p_received_at<reversed.received_at
 THEN RAISE EXCEPTION 'OFFICE_REVERSAL_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
 SELECT * INTO original FROM public.material_receipts WHERE id=reversed.reversal_of_id;
 IF original.id IS NULL OR original.event_type<>'RECEIVE'
 THEN RAISE EXCEPTION 'ORIGINAL_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF reversed.source_type IN ('ARRIVAL','ARRIVAL_ROUTE') THEN
  PERFORM 1 FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
   WHERE l.id=COALESCE(reversed.route_arrival_line_id,reversed.arrival_line_id)
    AND (reversed.source_type='ARRIVAL_ROUTE' OR l.receipt_id=app_private.receiving_arrival_anchor_receipt(original.id))
    AND l.resolution_state IN ('STAGED','POSTED') AND a.voided_at IS NULL FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'ARRIVAL_RECEIPT_INACTIVE' USING ERRCODE='23514'; END IF;
  UPDATE public.receiving_arrivals SET version=version WHERE id=(
   SELECT arrival_id FROM public.receiving_arrival_lines WHERE id=COALESCE(reversed.route_arrival_line_id,reversed.arrival_line_id));
  PERFORM 1 FROM public.receiving_arrival_lines WHERE id=COALESCE(reversed.route_arrival_line_id,reversed.arrival_line_id) FOR UPDATE;
 ELSE
  PERFORM app_private.receiving_source(reversed.source_type,
   COALESCE(reversed.project_material_id,reversed.se_supply_record_id));
 END IF;
 SELECT * INTO reversal_tx FROM public.inventory_transactions WHERE id=reversed.inventory_transaction_id;
 SELECT * INTO item FROM public.inventory_items WHERE id=reversal_tx.item_id FOR UPDATE;
 SELECT * INTO reversal_tx FROM public.inventory_transactions WHERE id=reversed.inventory_transaction_id FOR UPDATE;
 SELECT * INTO reversed FROM public.material_receipts WHERE id=p_reversal_receipt_id FOR UPDATE;
 IF item.id IS NULL OR reversal_tx.id IS NULL OR reversal_tx.transaction_type<>'IN_REVERSAL'
  OR reversal_tx.is_voided OR reversal_tx.excluded_by_initialization_id IS NOT NULL
  OR reversal_tx.quantity IS DISTINCT FROM reversed.quantity_received
 THEN RAISE EXCEPTION 'RECEIPT_REVERSAL_ORIGIN_INVALID' USING ERRCODE='23514'; END IF;
 SELECT reversal_tx.quantity-COALESCE(sum(t.quantity),0) INTO staged
  FROM public.inventory_transactions t WHERE t.reenters_reversal_id=reversal_tx.id
   AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL;
 IF p_quantity>staged THEN RAISE EXCEPTION 'STAGED_QUANTITY_EXCEEDED' USING ERRCODE='23514'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT x) FROM unnest(p_entry_ids)x)<>p_quantity
  THEN RAISE EXCEPTION 'REENTRY_SERIAL_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT count(*),COALESCE(jsonb_agg(s.serial_number ORDER BY s.id),'[]') INTO selected,names
   FROM public.material_receipt_serials rs
   JOIN public.receiving_serial_entries e ON e.id=rs.entry_id
   JOIN public.inventory_serials s ON s.id=rs.inventory_serial_id
   WHERE rs.receipt_id=reversed.id AND rs.entry_id=ANY(p_entry_ids)
    AND e.active_receipt_id IS NULL AND e.retired_at IS NULL
    AND s.item_id=item.id AND s.status='待入庫'
    AND EXISTS(SELECT 1 FROM public.inventory_transaction_serials l
     WHERE l.transaction_id=reversal_tx.id AND l.serial_id=s.id);
  IF selected<>p_quantity THEN RAISE EXCEPTION 'REENTRY_SERIAL_PROVENANCE_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
  IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION 'NON_SERIAL_ENTRY_IDS_NOT_ALLOWED' USING ERRCODE='23514'; END IF;
 END IF;
 INSERT INTO app_private.inventory_reversal_context VALUES(pg_backend_pid(),txid_current(),reversed.id);
 tx:=public.write_inventory_transaction_atomic('REENTER_IN',jsonb_build_object(
  'item_id',item.id,'quantity',p_quantity,'transaction_date',(p_received_at AT TIME ZONE 'Asia/Taipei')::date),
  names,reversal_tx.id,COALESCE(NULLIF(btrim(p_notes),''),'Re-enter received inventory'),reversal_tx.updated_at);
 IF reversed.source_type='ARRIVAL_ROUTE' THEN
  INSERT INTO public.material_receipts(source_type,route_arrival_line_id,event_type,reentry_of_reversal_id,
   quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
  VALUES('ARRIVAL_ROUTE',reversed.route_arrival_line_id,'RECEIVE',reversed.id,p_quantity,actor.id,p_received_at,
   p_notes,'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO receipt;
 ELSIF reversed.source_type='ARRIVAL' THEN
  INSERT INTO public.material_receipts(source_type,arrival_line_id,event_type,reentry_of_reversal_id,
   quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
  VALUES('ARRIVAL',reversed.arrival_line_id,'RECEIVE',reversed.id,p_quantity,actor.id,p_received_at,
   p_notes,'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO receipt;
 ELSE
  SELECT * INTO receipt FROM app_private.append_receiving_event(reversed.source_type,
   COALESCE(reversed.project_material_id,reversed.se_supply_record_id),p_quantity,p_received_at,p_notes);
  UPDATE public.material_receipts SET receipt_location='OFFICE',inventory_linked=true,
   inventory_transaction_id=(tx->>'id')::uuid,reentry_of_reversal_id=reversed.id
   WHERE id=receipt.id RETURNING * INTO receipt;
 END IF;
 IF reversed.source_type='ARRIVAL_ROUTE' THEN
  UPDATE public.receiving_arrival_lines SET resolution_state=CASE WHEN (
    SELECT COALESCE(sum(CASE WHEN event_type='RECEIVE' THEN quantity_received ELSE -quantity_received END),0)
    FROM public.material_receipts WHERE route_arrival_line_id=reversed.route_arrival_line_id)=quantity
   THEN 'POSTED' ELSE 'STAGED' END,version=version+1,updated_at=clock_timestamp()
   WHERE id=reversed.route_arrival_line_id;
 END IF;
 IF item.requires_serial THEN
  INSERT INTO public.material_receipt_serials(receipt_id,entry_id,inventory_serial_id,linked_existing,inventory_snapshot)
   SELECT receipt.id,rs.entry_id,rs.inventory_serial_id,false,to_jsonb(s)
   FROM public.material_receipt_serials rs JOIN public.inventory_serials s ON s.id=rs.inventory_serial_id
   WHERE rs.receipt_id=reversed.id AND rs.entry_id=ANY(p_entry_ids);
  UPDATE public.receiving_serial_entries SET active_receipt_id=receipt.id,updated_at=clock_timestamp()
   WHERE id=ANY(p_entry_ids);
 END IF;
 DELETE FROM app_private.inventory_reversal_context
  WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 result:=jsonb_build_object('receipt',to_jsonb(receipt),'inventory_transaction',tx,
  'remaining_staged_quantity',staged-p_quantity);
 PERFORM app_private.inventory_audit('REENTER_RECEIVING_IN',to_jsonb(reversed),
  to_jsonb(receipt)||jsonb_build_object('inventory_transaction',tx),
  COALESCE(NULLIF(btrim(p_notes),''),'Re-enter received inventory'));
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.reenter_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.reenter_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.guard_receipt_inventory_reentry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source_receipt public.material_receipts; entry_tx public.inventory_transactions;
BEGIN
 IF TG_OP='UPDATE' AND OLD.reentry_of_reversal_id IS NOT NULL
  AND (NEW.reentry_of_reversal_id IS DISTINCT FROM OLD.reentry_of_reversal_id
   OR NEW.inventory_transaction_id IS DISTINCT FROM OLD.inventory_transaction_id)
 THEN RAISE EXCEPTION 'REENTRY_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.reentry_of_reversal_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO source_receipt FROM public.material_receipts WHERE id=NEW.reentry_of_reversal_id;
 SELECT * INTO entry_tx FROM public.inventory_transactions WHERE id=NEW.inventory_transaction_id;
 IF source_receipt.id IS NULL OR source_receipt.event_type<>'REVERSAL'
  OR source_receipt.source_type IS DISTINCT FROM NEW.source_type
  OR source_receipt.project_material_id IS DISTINCT FROM NEW.project_material_id
  OR source_receipt.se_supply_record_id IS DISTINCT FROM NEW.se_supply_record_id
  OR source_receipt.arrival_line_id IS DISTINCT FROM NEW.arrival_line_id
  OR source_receipt.route_arrival_line_id IS DISTINCT FROM NEW.route_arrival_line_id
  OR NEW.receipt_location IS DISTINCT FROM 'OFFICE'
  OR entry_tx.id IS NULL OR entry_tx.transaction_type<>'IN'
  OR entry_tx.reenters_reversal_id IS DISTINCT FROM source_receipt.inventory_transaction_id
  OR entry_tx.quantity IS DISTINCT FROM NEW.quantity_received
 THEN RAISE EXCEPTION 'INVALID_RECEIPT_IN_REENTRY' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_receipt_inventory_reentry() FROM PUBLIC,anon,authenticated;


-- Route receipts resolve the same physical arrival without changing legacy ARRIVAL anchors.
CREATE OR REPLACE FUNCTION app_private.receiving_source(p_type text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r jsonb; a public.receiving_arrivals; l public.receiving_arrival_lines;
BEGIN
 IF p_type='PROJECT_MATERIAL' THEN
  SELECT to_jsonb(m) INTO r FROM public.project_materials m WHERE id=p_id FOR UPDATE;
  IF r->>'delivery_destination'<>'OFFICE' THEN RAISE EXCEPTION '只能接收北辦到貨'; END IF;
 ELSIF p_type='SE_SUPPLY' THEN
  SELECT to_jsonb(s) INTO r FROM public.se_supply_records s WHERE id=p_id FOR UPDATE;
  IF r->>'cancelled_at' IS NOT NULL THEN RAISE EXCEPTION '到貨已取消'; END IF;
 ELSIF p_type IN ('ARRIVAL','ARRIVAL_ROUTE') THEN
  SELECT parent.* INTO a FROM public.receiving_arrivals parent JOIN public.receiving_arrival_lines line ON line.arrival_id=parent.id WHERE line.id=p_id FOR UPDATE OF parent;
  SELECT * INTO l FROM public.receiving_arrival_lines WHERE id=p_id FOR UPDATE;
  IF l.id IS NULL OR a.voided_at IS NOT NULL OR l.resolution_state NOT IN ('STAGED','POSTED') OR NOT EXISTS(
   SELECT 1 FROM public.material_receipts receipt JOIN public.inventory_transactions tx ON tx.id=receipt.inventory_transaction_id
   WHERE ((p_type='ARRIVAL' AND receipt.id=l.receipt_id AND receipt.arrival_line_id=l.id AND receipt.source_type='ARRIVAL')
    OR (p_type='ARRIVAL_ROUTE' AND receipt.route_arrival_line_id=l.id AND receipt.source_type='ARRIVAL_ROUTE'))
    AND receipt.event_type='RECEIVE' AND receipt.receipt_location='OFFICE' AND receipt.inventory_linked
    AND tx.transaction_type='IN' AND tx.item_id=l.inventory_item_id AND NOT tx.is_voided AND tx.excluded_by_initialization_id IS NULL)
  THEN RAISE EXCEPTION 'ARRIVAL_NOT_AVAILABLE_FOR_HANDOFF' USING ERRCODE='PT409'; END IF;
  r:=to_jsonb(l)||jsonb_build_object('project_id',a.project_id,'notes',a.notes,'receiving_archived_at',NULL,'source_type',p_type);
 ELSE RAISE EXCEPTION 'Invalid receiving source'; END IF;
 IF r IS NULL THEN RAISE EXCEPTION '找不到到貨來源'; END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app_private.receiving_source(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.receiving_handoff_scope(p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.material_receipts; l public.receiving_arrival_lines; a public.receiving_arrivals;
 item public.inventory_items; iid uuid; received numeric; se numeric; site numeric; available numeric; ids uuid[];
BEGIN
 SELECT * INTO r FROM public.material_receipts WHERE id=p_receipt_id;
 IF r.id IS NULL OR r.event_type<>'RECEIVE' OR r.receipt_location IS DISTINCT FROM 'OFFICE' OR NOT r.inventory_linked
 THEN RAISE EXCEPTION 'HANDOFF_REQUIRES_OFFICE_RECEIPT' USING ERRCODE='PT409'; END IF;
 IF r.source_type IN ('ARRIVAL','ARRIVAL_ROUTE') THEN
  SELECT * INTO l FROM public.receiving_arrival_lines WHERE id=COALESCE(r.route_arrival_line_id,r.arrival_line_id);
  SELECT * INTO a FROM public.receiving_arrivals WHERE id=l.arrival_id;
  IF (r.source_type='ARRIVAL' AND l.receipt_id IS DISTINCT FROM app_private.receiving_arrival_anchor_receipt(r.id))
   OR l.resolution_state NOT IN ('STAGED','POSTED') OR a.id IS NULL OR a.voided_at IS NOT NULL
  THEN RAISE EXCEPTION 'ARRIVAL_NOT_AVAILABLE_FOR_HANDOFF' USING ERRCODE='PT409'; END IF;
  iid:=l.inventory_item_id;
 ELSIF r.source_type='PROJECT_MATERIAL' THEN
  SELECT inventory_item_id INTO iid FROM public.project_materials WHERE id=r.project_material_id AND delivery_destination='OFFICE';
 ELSIF r.source_type='SE_SUPPLY' THEN
  SELECT inventory_item_id INTO iid FROM public.se_supply_records WHERE id=r.se_supply_record_id AND cancelled_at IS NULL;
 END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=iid;
 IF item.id IS NULL OR NOT item.is_active THEN RAISE EXCEPTION 'HANDOFF_SOURCE_INACTIVE' USING ERRCODE='PT409'; END IF;
 IF (r.source_type IN ('ARRIVAL','ARRIVAL_ROUTE') AND r.inventory_transaction_id IS NULL) OR (r.inventory_transaction_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.inventory_transactions t WHERE t.id=r.inventory_transaction_id AND t.item_id=item.id AND t.transaction_type='IN' AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL))
 THEN RAISE EXCEPTION 'HANDOFF_INVENTORY_PROVENANCE_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT r.quantity_received-COALESCE(sum(quantity_received),0) INTO received FROM public.material_receipts WHERE event_type='REVERSAL' AND reversal_of_id=r.id;
 SELECT COALESCE(sum(quantity) FILTER(WHERE route_type='SE'),0),COALESCE(sum(quantity) FILTER(WHERE route_type='SITE'),0)
 INTO se,site FROM public.receiving_inventory_allocations WHERE office_receipt_id=r.id AND cancelled_at IS NULL;
 available:=GREATEST(0,received-se-site);
 SELECT COALESCE(array_agg(s.id ORDER BY s.id),'{}') INTO ids FROM public.receiving_serial_entries e
 JOIN public.inventory_serials s ON s.id=e.inventory_serial_id AND s.item_id=item.id AND s.status='在庫'
 JOIN public.material_receipt_serials links ON links.receipt_id=r.id AND links.entry_id=e.id AND links.inventory_serial_id=s.id
 WHERE e.active_receipt_id=r.id AND e.retired_at IS NULL
 AND (COALESCE(r.route_arrival_line_id,r.arrival_line_id) IS NULL OR e.arrival_line_id=COALESCE(r.route_arrival_line_id,r.arrival_line_id))
 AND NOT EXISTS(SELECT 1 FROM public.receiving_inventory_allocations x WHERE x.inventory_serial_id=s.id AND x.cancelled_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.se_supply_records x WHERE x.inventory_serial_id=s.id AND x.replace_date IS NULL AND x.cancelled_at IS NULL AND NOT x.receiving_only);
 available:=LEAST(available,CASE WHEN item.requires_serial THEN cardinality(ids)::numeric
  ELSE GREATEST(0,app_private.inventory_effective_balance(item.id)-app_private.receiving_reserved_quantity(item.id)) END);
 RETURN jsonb_build_object('receipt_id',r.id,'arrival_line_id',COALESCE(r.route_arrival_line_id,r.arrival_line_id),'item_id',item.id,'requires_serial',item.requires_serial,
  'received',received,'se',se,'site',site,'other',GREATEST(0,received-se-site-available),'available',available,'available_serial_ids',to_jsonb(ids),
  'allocations',COALESCE((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('state',app_private.receiving_allocation_state(x)) ORDER BY x.created_at,x.id)
   FROM public.receiving_inventory_allocations x WHERE x.office_receipt_id=r.id),'[]'));
END $$;
REVOKE ALL ON FUNCTION app_private.receiving_handoff_scope(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.lock_receiving_handoff(p_receipt_id uuid,p_allow_archived boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.material_receipts; source jsonb; iid uuid;
BEGIN
 SELECT * INTO r FROM public.material_receipts WHERE id=p_receipt_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'HANDOFF_RECEIPT_NOT_FOUND' USING ERRCODE='PT409'; END IF;
 source:=app_private.receiving_source(r.source_type,COALESCE(r.project_material_id,r.se_supply_record_id,r.route_arrival_line_id,r.arrival_line_id));
 IF NOT p_allow_archived AND source->>'receiving_archived_at' IS NOT NULL THEN RAISE EXCEPTION 'HANDOFF_SOURCE_INACTIVE' USING ERRCODE='PT409'; END IF;
 -- Preserve every Arrival field while making a later Repeatable Read void of
 -- this parent conflict with a handoff it cannot see in its old snapshot.
 IF r.source_type IN ('ARRIVAL','ARRIVAL_ROUTE') THEN
  UPDATE public.receiving_arrivals SET version=version WHERE id=(source->>'arrival_id')::uuid;
 END IF;
 iid:=(source->>'inventory_item_id')::uuid;
 PERFORM 1 FROM public.inventory_items WHERE id=iid FOR UPDATE;
 -- A real tuple version also rejects stale Repeatable Read snapshots after another handoff/retract.
 UPDATE public.inventory_items SET updated_at=clock_timestamp() WHERE id=iid;
 PERFORM 1 FROM public.inventory_transactions WHERE id=r.inventory_transaction_id FOR UPDATE;
 PERFORM 1 FROM public.material_receipts WHERE id=r.id FOR UPDATE;
 RETURN app_private.receiving_handoff_scope(r.id);
END $$;
REVOKE ALL ON FUNCTION app_private.lock_receiving_handoff(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.guard_arrival_handoff_void()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.voided_at IS DISTINCT FROM OLD.voided_at AND EXISTS(
  SELECT 1 FROM public.receiving_arrival_lines l
  JOIN public.material_receipts r ON r.arrival_line_id=l.id OR r.route_arrival_line_id=l.id
  JOIN public.receiving_inventory_allocations x ON x.office_receipt_id=r.id
  WHERE l.arrival_id=OLD.id AND x.cancelled_at IS NULL)
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_arrival_handoff_void() FROM PUBLIC,anon,authenticated,service_role;

-- The legacy correction command cannot reinterpret a routed receipt as its
-- older source types. Route receipts use the canonical reversal command.
CREATE OR REPLACE FUNCTION public.correct_receiving_inventory(
 p_request_id uuid,p_receipt_id uuid,p_quantity numeric,p_entry_ids uuid[],p_reversed_at timestamptz,p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('CORRECT',p_receipt_id,p_quantity,p_entry_ids,p_reversed_at,p_notes);
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations
   WHERE office_receipt_id=p_receipt_id AND cancelled_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.material_receipts
   WHERE id=p_receipt_id AND source_type IN ('ARRIVAL','ARRIVAL_ROUTE'))
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 RETURN app_private.correct_receiving_before_handoff(
  p_request_id,p_receipt_id,p_quantity,p_entry_ids,p_reversed_at,p_notes);
END $$;
REVOKE ALL ON FUNCTION public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text)
 TO authenticated;

-- Keep the existing view shape and expose route reversal staging through its
-- arrival_line_id projection.
CREATE OR REPLACE VIEW public.receiving_in_reversal_staging WITH (security_invoker=true) AS
 SELECT r.id AS reversal_receipt_id,r.reversal_of_id AS original_receipt_id,
  COALESCE(r.route_arrival_line_id,r.arrival_line_id) AS arrival_line_id,
  r.project_material_id,r.se_supply_record_id,t.item_id,t.id AS reversal_transaction_id,
  t.quantity-COALESCE((SELECT sum(i.quantity) FROM public.inventory_transactions i
   WHERE i.reenters_reversal_id=t.id AND NOT i.is_voided
    AND i.excluded_by_initialization_id IS NULL),0) AS staged_quantity
 FROM public.material_receipts r JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id
 WHERE r.event_type='REVERSAL' AND t.transaction_type='IN_REVERSAL'
  AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL;
REVOKE ALL ON public.receiving_in_reversal_staging FROM PUBLIC,anon;
GRANT SELECT ON public.receiving_in_reversal_staging TO authenticated;

NOTIFY pgrst,'reload schema';
