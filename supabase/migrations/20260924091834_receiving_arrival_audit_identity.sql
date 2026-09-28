CREATE OR REPLACE FUNCTION public.create_receiving_arrival(p_request_id uuid,p_actual_received_at timestamptz,p_lines jsonb,
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
 PERFORM app_private.inventory_audit('ARRIVAL_CREATED',NULL,result||jsonb_build_object('id',arrival.id,'project_id',arrival.project_id),'Physical OFFICE arrival');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_receiving_arrival(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_receiving_arrival(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean) TO authenticated;
