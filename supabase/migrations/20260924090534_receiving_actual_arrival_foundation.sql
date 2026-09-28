-- V5-A additive foundation. No legacy data rewrite; Inventory remains the sole ledger.
CREATE TABLE public.receiving_arrivals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actual_received_at timestamptz NOT NULL CHECK(isfinite(actual_received_at)),
 project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
 notes text, created_by uuid NOT NULL REFERENCES public.team_members(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 voided_at timestamptz, void_reason text,
 CHECK((voided_at IS NULL)=(void_reason IS NULL))
);
CREATE TABLE public.receiving_arrival_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 arrival_id uuid NOT NULL REFERENCES public.receiving_arrivals(id) ON DELETE RESTRICT,
 inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 quantity numeric NOT NULL CHECK(quantity>0 AND quantity::text NOT IN ('NaN','Infinity','-Infinity')),
 unit text, resolution_state text NOT NULL DEFAULT 'UNRESOLVED' CHECK(resolution_state IN ('UNRESOLVED','POSTED')),
 receipt_id uuid, posting_date date,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK((resolution_state='UNRESOLVED' AND receipt_id IS NULL AND posting_date IS NULL)
 OR (resolution_state='POSTED' AND inventory_item_id IS NOT NULL AND unit IS NOT NULL AND receipt_id IS NOT NULL AND posting_date IS NOT NULL)),
 CHECK(unit IS NULL OR btrim(unit)<>'')
);
CREATE INDEX receiving_arrival_lines_arrival ON public.receiving_arrival_lines(arrival_id);
ALTER TABLE public.material_receipts ADD COLUMN arrival_line_id uuid REFERENCES public.receiving_arrival_lines(id) ON DELETE RESTRICT;
ALTER TABLE public.material_receipts DROP CONSTRAINT material_receipts_single_source_check;
ALTER TABLE public.material_receipts ADD CONSTRAINT material_receipts_single_source_check CHECK(
 (source_type='PROJECT_MATERIAL' AND project_material_id IS NOT NULL AND se_supply_record_id IS NULL AND arrival_line_id IS NULL)
 OR (source_type='SE_SUPPLY' AND se_supply_record_id IS NOT NULL AND project_material_id IS NULL AND arrival_line_id IS NULL)
 OR (source_type='ARRIVAL' AND arrival_line_id IS NOT NULL AND project_material_id IS NULL AND se_supply_record_id IS NULL));
ALTER TABLE public.material_receipts ADD CONSTRAINT arrival_receipt_office CHECK(
 arrival_line_id IS NULL OR (receipt_location IS NOT DISTINCT FROM 'OFFICE' AND inventory_linked AND inventory_transaction_id IS NOT NULL));
CREATE UNIQUE INDEX receiving_arrival_first_receipt ON public.material_receipts(arrival_line_id) WHERE event_type='RECEIVE' AND arrival_line_id IS NOT NULL;
ALTER TABLE public.receiving_arrival_lines ADD CONSTRAINT receiving_arrival_line_receipt_fk FOREIGN KEY(receipt_id) REFERENCES public.material_receipts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX receiving_arrival_line_receipt ON public.receiving_arrival_lines(receipt_id) WHERE receipt_id IS NOT NULL;

ALTER TABLE public.receiving_serial_entries ADD COLUMN arrival_line_id uuid REFERENCES public.receiving_arrival_lines(id) ON DELETE RESTRICT;
ALTER TABLE public.receiving_serial_entries ALTER COLUMN inventory_item_id DROP NOT NULL;
ALTER TABLE public.receiving_serial_entries DROP CONSTRAINT receiving_serial_entries_check;
ALTER TABLE public.receiving_serial_entries ADD CONSTRAINT receiving_serial_entries_owner CHECK(
 num_nonnulls(project_material_id,se_supply_record_id,arrival_line_id)=1
 AND (arrival_line_id IS NOT NULL OR inventory_item_id IS NOT NULL));
CREATE UNIQUE INDEX receiving_arrival_observation_identity ON public.receiving_serial_entries(normalized_serial)
 WHERE arrival_line_id IS NOT NULL AND retired_at IS NULL;
CREATE INDEX receiving_serial_entry_arrival ON public.receiving_serial_entries(arrival_line_id) WHERE arrival_line_id IS NOT NULL;

CREATE TABLE public.receiving_arrival_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 arrival_line_id uuid NOT NULL REFERENCES public.receiving_arrival_lines(id) ON DELETE RESTRICT,
 project_material_id uuid REFERENCES public.project_materials(id) ON DELETE RESTRICT,
 se_supply_record_id uuid REFERENCES public.se_supply_records(id) ON DELETE RESTRICT,
 quantity numeric NOT NULL CHECK(quantity>0 AND quantity::text NOT IN ('NaN','Infinity','-Infinity')),
 created_by uuid NOT NULL REFERENCES public.team_members(id), created_at timestamptz NOT NULL DEFAULT now(),
 cancelled_at timestamptz,
 CHECK(num_nonnulls(project_material_id,se_supply_record_id)=1)
);
CREATE INDEX receiving_arrival_match_line ON public.receiving_arrival_matches(arrival_line_id);
CREATE INDEX receiving_arrival_match_project ON public.receiving_arrival_matches(project_material_id) WHERE project_material_id IS NOT NULL;
CREATE INDEX receiving_arrival_match_se ON public.receiving_arrival_matches(se_supply_record_id) WHERE se_supply_record_id IS NOT NULL;
CREATE TABLE public.receiving_arrival_match_serials (
 match_id uuid NOT NULL REFERENCES public.receiving_arrival_matches(id) ON DELETE RESTRICT,
 arrival_entry_id uuid NOT NULL UNIQUE REFERENCES public.receiving_serial_entries(id) ON DELETE RESTRICT,
 pending_entry_id uuid UNIQUE REFERENCES public.receiving_serial_entries(id) ON DELETE RESTRICT,
 PRIMARY KEY(match_id,arrival_entry_id)
);

-- Readers see persisted observations even before first posting. No client direct mutations.
ALTER TABLE public.receiving_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receiving_arrival_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receiving_arrival_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receiving_arrival_match_serials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receiving_arrivals,public.receiving_arrival_lines,public.receiving_arrival_matches,public.receiving_arrival_match_serials FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.receiving_arrivals,public.receiving_arrival_lines,public.receiving_arrival_matches,public.receiving_arrival_match_serials TO authenticated;
CREATE POLICY arrival_read ON public.receiving_arrivals FOR SELECT TO authenticated USING(app_private.is_active_member());
CREATE POLICY arrival_line_read ON public.receiving_arrival_lines FOR SELECT TO authenticated USING(app_private.is_active_member());
CREATE POLICY arrival_match_read ON public.receiving_arrival_matches FOR SELECT TO authenticated USING(app_private.is_active_member());
CREATE POLICY arrival_match_serial_read ON public.receiving_arrival_match_serials FOR SELECT TO authenticated USING(app_private.is_active_member());

-- All V5 mutations use the same outer mutex as V4 canonical routing, then parent/line,
-- pending rows, item rows and serial rows. Parent locks precede lines; batch order is stable.
CREATE FUNCTION app_private.post_receiving_arrival_line(p_line_id uuid,p_item_id uuid,p_posting_date date)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); line public.receiving_arrival_lines;
 arrival public.receiving_arrivals; item public.inventory_items; entry public.receiving_serial_entries;
 lookup record; serial public.inventory_serials; names jsonb; tx jsonb; receipt public.material_receipts;
BEGIN
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 SELECT * INTO arrival FROM public.receiving_arrivals WHERE id=line.arrival_id;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL THEN RAISE EXCEPTION 'ARRIVAL_NOT_ACTIVE' USING ERRCODE='PT409'; END IF;
 IF line.resolution_state='POSTED' THEN RAISE EXCEPTION 'ARRIVAL_ALREADY_POSTED' USING ERRCODE='PT409'; END IF;
 IF p_posting_date IS NULL OR NOT isfinite(p_posting_date) THEN RAISE EXCEPTION 'POSTING_DATE_REQUIRED'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=p_item_id FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active OR (line.unit IS NOT NULL AND line.unit IS DISTINCT FROM item.unit) THEN RAISE EXCEPTION 'ARRIVAL_ITEM_UNIT_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF line.inventory_item_id IS NOT NULL AND line.inventory_item_id<>item.id THEN RAISE EXCEPTION 'ARRIVAL_ITEM_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(jsonb_agg(normalized_serial ORDER BY normalized_serial),'[]') INTO names FROM public.receiving_serial_entries WHERE arrival_line_id=line.id AND retired_at IS NULL;
 IF item.requires_serial THEN
  IF line.quantity<>trunc(line.quantity) OR jsonb_array_length(names)<>line.quantity THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_COUNT'; END IF;
  -- Full identities sharing a short key remain distinct; a short/full alias pair is not two units.
  IF EXISTS(SELECT 1 FROM public.receiving_serial_entries a JOIN public.receiving_serial_entries b
    ON a.arrival_line_id=b.arrival_line_id AND a.id<>b.id
    AND public.derive_inventory_serial_short_key(a.raw_serial)=public.derive_inventory_serial_short_key(b.raw_serial)
    WHERE a.arrival_line_id=line.id AND public.classify_inventory_serial_format(a.raw_serial)='short')
  THEN RAISE EXCEPTION 'ARRIVAL_AMBIGUOUS_SERIAL' USING ERRCODE='PT409'; END IF;
  FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE arrival_line_id=line.id ORDER BY normalized_serial FOR UPDATE LOOP
   SELECT * INTO lookup FROM public.lookup_inventory_serial(entry.raw_serial,NULL,NULL);
   IF lookup.result_type IS DISTINCT FROM 'no_match' THEN
    SELECT * INTO serial FROM public.inventory_serials WHERE normalized_full=entry.normalized_serial FOR UPDATE;
    IF serial.id IS NOT NULL AND serial.item_id=item.id AND serial.status='在庫' THEN
     RAISE EXCEPTION 'ARRIVAL_EXISTING_IN_STOCK: %',serial.id USING ERRCODE='PT409';
    END IF;
    RAISE EXCEPTION 'ARRIVAL_SERIAL_IDENTITY_CONFLICT: %',lookup.result_type USING ERRCODE='PT409';
   END IF;
  END LOOP;
 ELSIF jsonb_array_length(names)<>0 THEN RAISE EXCEPTION 'ARRIVAL_NONSERIAL_HAS_SERIAL'; END IF;
 tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object(
  'item_id',item.id,'transaction_type','IN','quantity',line.quantity,'unit',item.unit,
  'transaction_date',p_posting_date,'project_id',arrival.project_id,'source','北辦實際到貨','notes',arrival.notes),names);
 INSERT INTO public.material_receipts(source_type,arrival_line_id,event_type,quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
 VALUES('ARRIVAL',line.id,'RECEIVE',line.quantity,actor.id,arrival.actual_received_at,arrival.notes,'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO receipt;
 FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE arrival_line_id=line.id ORDER BY id LOOP
  SELECT * INTO STRICT serial FROM public.inventory_serials WHERE normalized_full=entry.normalized_serial;
  INSERT INTO public.material_receipt_serials(receipt_id,entry_id,inventory_serial_id,linked_existing,inventory_snapshot)
   VALUES(receipt.id,entry.id,serial.id,false,to_jsonb(serial));
  UPDATE public.receiving_serial_entries SET inventory_item_id=item.id,inventory_serial_id=serial.id,active_receipt_id=receipt.id,updated_at=clock_timestamp() WHERE id=entry.id;
 END LOOP;
 UPDATE public.receiving_arrival_lines SET inventory_item_id=item.id,unit=item.unit,resolution_state='POSTED',
  receipt_id=receipt.id,posting_date=p_posting_date,updated_at=clock_timestamp(),version=version+1 WHERE id=line.id RETURNING * INTO line;
 PERFORM app_private.inventory_audit('ARRIVAL_FIRST_POST',NULL,to_jsonb(line),'Actual arrival first Inventory IN');
 RETURN to_jsonb(line);
END $$;
REVOKE ALL ON FUNCTION app_private.post_receiving_arrival_line(uuid,uuid,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.match_receiving_arrival_line(p_request_id uuid,p_line_id uuid,p_quantity numeric,
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

CREATE FUNCTION public.create_receiving_arrival(p_request_id uuid,p_actual_received_at timestamptz,p_lines jsonb,
 p_project_id uuid DEFAULT NULL,p_notes text DEFAULT NULL,p_posting_date date DEFAULT NULL,p_matches jsonb DEFAULT '[]',p_match_all_or_nothing boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('V5_CREATE',p_actual_received_at,p_lines,p_project_id,p_notes,p_posting_date,p_matches,p_match_all_or_nothing);
 arrival public.receiving_arrivals; line public.receiving_arrival_lines; spec jsonb; raw jsonb; raw_text text;
 lines jsonb:='[]'; match_results jsonb:='[]'; result jsonb; request jsonb; line_id uuid; obs uuid[];
 item public.inventory_items; qty numeric; unit_value text; serials jsonb; posting date;
BEGIN
 IF p_request_id IS NULL OR p_actual_received_at IS NULL OR NOT isfinite(p_actual_received_at) THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_TIME_REQUIRED'; END IF;
 IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines)<1 OR jsonb_array_length(p_lines)>200
 OR jsonb_typeof(p_matches) IS DISTINCT FROM 'array' OR p_match_all_or_nothing IS NULL THEN RAISE EXCEPTION 'ARRIVAL_LINES_MATCHES_REQUIRED'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'ARRIVAL_PROJECT_INVALID'; END IF;
 posting:=COALESCE(p_posting_date,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date);
 INSERT INTO public.receiving_arrivals(actual_received_at,project_id,notes,created_by) VALUES(p_actual_received_at,p_project_id,p_notes,actor.id) RETURNING * INTO arrival;
 FOR spec IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
  IF jsonb_typeof(spec) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ARRIVAL_LINE_OBJECT'; END IF;
  qty:=(spec->>'quantity')::numeric; unit_value:=NULLIF(btrim(spec->>'unit'),''); serials:=COALESCE(spec->'raw_serials','[]');
  IF jsonb_typeof(serials) IS DISTINCT FROM 'array' OR jsonb_array_length(serials)>1000 THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_ARRAY'; END IF;
  IF spec->>'inventory_item_id' IS NOT NULL THEN
   SELECT * INTO item FROM public.inventory_items WHERE id=(spec->>'inventory_item_id')::uuid FOR UPDATE;
   IF item.id IS NULL OR NOT item.is_active THEN RAISE EXCEPTION 'ARRIVAL_ITEM_INVALID'; END IF;
   unit_value:=COALESCE(unit_value,item.unit);
  ELSE
   item:=NULL;
   IF jsonb_array_length(serials)=0 OR qty IS DISTINCT FROM jsonb_array_length(serials)::numeric THEN RAISE EXCEPTION 'UNKNOWN_ARRIVAL_REQUIRES_SERIAL_OBSERVATIONS'; END IF;
  END IF;
  INSERT INTO public.receiving_arrival_lines(arrival_id,inventory_item_id,quantity,unit)
   VALUES(arrival.id,item.id,qty,unit_value) RETURNING * INTO line;
  FOR raw IN SELECT value FROM jsonb_array_elements(serials) LOOP
   IF jsonb_typeof(raw) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'ARRIVAL_RAW_SERIAL_STRING'; END IF;
   raw_text:=raw#>>'{}';
   IF public.classify_inventory_serial_format(raw_text)='unknown' OR NULLIF(btrim(raw_text),'') IS NULL THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_FORMAT'; END IF;
   INSERT INTO public.receiving_serial_entries(arrival_line_id,inventory_item_id,raw_serial,created_by) VALUES(line.id,item.id,raw_text,actor.id);
  END LOOP;
  IF item.id IS NOT NULL THEN
   result:=app_private.post_receiving_arrival_line(line.id,item.id,posting);
  ELSE result:=to_jsonb(line); END IF;
  lines:=lines||jsonb_build_array(result);
 END LOOP;
 -- Matching is explicit, and each failed match rolls back only its subtransaction by default.
 FOR request IN SELECT value FROM jsonb_array_elements(p_matches) LOOP
  BEGIN
   IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR (request->>'line_index')::integer IS NULL
    OR (request->>'line_index')::integer<0 OR (request->>'line_index')::integer>=jsonb_array_length(lines) THEN RAISE EXCEPTION 'MATCH_LINE_INDEX'; END IF;
   line_id:=(lines->((request->>'line_index')::integer)->>'id')::uuid;
   SELECT COALESCE(array_agg(e.id ORDER BY e.id),'{}') INTO obs FROM public.receiving_serial_entries e
    WHERE e.arrival_line_id=line_id AND e.normalized_serial IN (SELECT public.normalize_inventory_serial(value) FROM jsonb_array_elements_text(COALESCE(request->'raw_serials','[]')));
   result:=public.match_receiving_arrival_line(gen_random_uuid(),line_id,(request->>'quantity')::numeric,
    (request->>'project_material_id')::uuid,(request->>'se_supply_record_id')::uuid,obs);
   match_results:=match_results||jsonb_build_array(jsonb_build_object('status','MATCHED','match',result));
  EXCEPTION WHEN OTHERS THEN
   IF p_match_all_or_nothing THEN RAISE; END IF;
   match_results:=match_results||jsonb_build_array(jsonb_build_object('status','CONFLICT','code',SQLSTATE,'message',SQLERRM));
  END;
 END LOOP;
 result:=jsonb_build_object('arrival',to_jsonb(arrival),'lines',lines,'matches',match_results);
 PERFORM app_private.inventory_audit('ARRIVAL_CREATED',NULL,result,'Physical OFFICE arrival');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_receiving_arrival(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_receiving_arrival(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean) TO authenticated;

CREATE FUNCTION public.complete_receiving_arrival_line(p_request_id uuid,p_line_id uuid,p_item_id uuid,p_posting_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests; result jsonb;
 payload jsonb:=jsonb_build_array('V5_COMPLETE',p_line_id,p_item_id,p_posting_date);
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 PERFORM 1 FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id WHERE l.id=p_line_id FOR UPDATE OF a;
 result:=app_private.post_receiving_arrival_line(p_line_id,p_item_id,COALESCE(p_posting_date,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date));
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.complete_receiving_arrival_line(uuid,uuid,uuid,date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.complete_receiving_arrival_line(uuid,uuid,uuid,date) TO authenticated;

CREATE FUNCTION public.update_receiving_arrival_metadata(p_request_id uuid,p_arrival_id uuid,p_expected_version bigint,p_project_id uuid,p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests; arrival public.receiving_arrivals; result jsonb;
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
 IF p_project_id IS DISTINCT FROM arrival.project_id AND EXISTS(SELECT 1 FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id WHERE l.arrival_id=arrival.id AND m.cancelled_at IS NULL)
 THEN RAISE EXCEPTION 'MATCHED_ARRIVAL_PROJECT_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 UPDATE public.receiving_arrivals SET project_id=p_project_id,notes=p_notes,version=version+1,updated_at=clock_timestamp() WHERE id=arrival.id RETURNING to_jsonb(receiving_arrivals.*) INTO result;
 PERFORM app_private.inventory_audit('ARRIVAL_METADATA',to_jsonb(arrival),result,'Metadata only; original posting provenance retained');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.update_receiving_arrival_metadata(uuid,uuid,bigint,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.update_receiving_arrival_metadata(uuid,uuid,bigint,uuid,text) TO authenticated;

-- V5 fulfilment uses matches, without changing V4 receipt-based projections.
CREATE FUNCTION public.get_receiving_pending_fulfilment(p_project_material_id uuid DEFAULT NULL,p_se_supply_record_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE total numeric; fulfilled numeric;
BEGIN
 IF NOT COALESCE(app_private.is_active_member(),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF num_nonnulls(p_project_material_id,p_se_supply_record_id)<>1 THEN RAISE EXCEPTION 'One pending source required'; END IF;
 IF p_project_material_id IS NOT NULL THEN SELECT quantity INTO total FROM public.project_materials WHERE id=p_project_material_id;
 ELSE SELECT quantity INTO total FROM public.se_supply_records WHERE id=p_se_supply_record_id AND receiving_only; END IF;
 IF total IS NULL THEN RAISE EXCEPTION 'Pending not found'; END IF;
 SELECT COALESCE(sum(m.quantity),0) INTO fulfilled FROM public.receiving_arrival_matches m
 JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id JOIN public.receiving_arrivals a ON a.id=l.arrival_id
 WHERE m.cancelled_at IS NULL AND a.voided_at IS NULL AND l.resolution_state='POSTED'
 AND (m.project_material_id=p_project_material_id OR m.se_supply_record_id=p_se_supply_record_id);
 RETURN jsonb_build_object('quantity',total,'fulfilled',fulfilled,'remaining',total-fulfilled);
END $$;
REVOKE ALL ON FUNCTION public.get_receiving_pending_fulfilment(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_receiving_pending_fulfilment(uuid,uuid) TO authenticated;

-- Prevent stale V4 writes from re-consuming matched pending capacity or mutating identity.
CREATE FUNCTION app_private.guard_arrival_matched_pending() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE used numeric; old_data jsonb:=to_jsonb(OLD); new_data jsonb:=to_jsonb(NEW);
BEGIN
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
CREATE TRIGGER arrival_matched_project_guard BEFORE UPDATE OR DELETE ON public.project_materials FOR EACH ROW EXECUTE FUNCTION app_private.guard_arrival_matched_pending();
CREATE TRIGGER arrival_matched_se_guard BEFORE UPDATE OR DELETE ON public.se_supply_records FOR EACH ROW EXECUTE FUNCTION app_private.guard_arrival_matched_pending();
CREATE FUNCTION app_private.guard_arrival_receipt_boundary() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.arrival_line_id IS NULL AND NEW.event_type='RECEIVE' AND EXISTS(SELECT 1 FROM public.receiving_arrival_matches WHERE cancelled_at IS NULL AND (project_material_id=NEW.project_material_id OR se_supply_record_id=NEW.se_supply_record_id))
 THEN RAISE EXCEPTION 'V5_MATCHED_PENDING_USE_ARRIVAL' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_arrival_receipt_boundary() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER arrival_receipt_boundary BEFORE INSERT ON public.material_receipts FOR EACH ROW EXECUTE FUNCTION app_private.guard_arrival_receipt_boundary();
NOTIFY pgrst,'reload schema';
