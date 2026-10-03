-- Rolling release bridge. This definition is valid on the Production V5 schema;
-- staged-only functions are discovered at execution time, never at creation time.
CREATE FUNCTION public.create_receiving_arrival_legacy_compat(
 p_request_id uuid,p_actual_received_at timestamptz,p_lines jsonb,
 p_project_id uuid DEFAULT NULL,p_notes text DEFAULT NULL,p_posting_date date DEFAULT NULL,
 p_matches jsonb DEFAULT '[]',p_match_all_or_nothing boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 actor public.team_members:=app_private.inventory_actor();
 cached app_private.receiving_requests;
 old_payload jsonb:=jsonb_build_array('V5_CREATE',p_actual_received_at,p_lines,p_project_id,
  p_notes,p_posting_date,p_matches,p_match_all_or_nothing);
 compat_payload jsonb:=jsonb_build_array('LEGACY_COMPAT_CREATE',p_actual_received_at,p_lines,p_project_id,
  p_notes,p_posting_date,p_matches,p_match_all_or_nothing);
 result jsonb; posted jsonb; line jsonb; line_index integer; entry_ids uuid[];
 posting date:=COALESCE(p_posting_date,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date);
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_TIME_REQUIRED'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id IS DISTINCT FROM actor.id
   OR (cached.payload IS DISTINCT FROM old_payload AND cached.payload IS DISTINCT FROM compat_payload)
  THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;

 -- The old canonical RPC retains its V5_CREATE request cache and full posting
 -- behavior. Its cache is also recognized above after the schema transition.
 IF to_regprocedure('public.post_receiving_arrival_line(uuid,uuid,numeric,uuid[],date)') IS NULL THEN
  RETURN public.create_receiving_arrival(p_request_id,p_actual_received_at,p_lines,
   p_project_id,p_notes,p_posting_date,p_matches,p_match_all_or_nothing);
 END IF;

 -- Each internal request has its own ID. Every call and the outer cache insert
 -- participate in this one transaction; any failed post rolls all of it back.
 result:=public.create_receiving_arrival(gen_random_uuid(),p_actual_received_at,p_lines,
  p_project_id,p_notes,NULL,p_matches,p_match_all_or_nothing);
 FOR line_index IN 0..jsonb_array_length(result->'lines')-1 LOOP
  line:=result->'lines'->line_index;
  IF line->>'inventory_item_id' IS NULL THEN CONTINUE; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO entry_ids
   FROM public.receiving_serial_entries
   WHERE arrival_line_id=(line->>'id')::uuid AND retired_at IS NULL;
  EXECUTE 'SELECT public.post_receiving_arrival_line($1,$2,$3,$4,$5)'
   INTO posted USING gen_random_uuid(),(line->>'id')::uuid,
    (line->>'quantity')::numeric,entry_ids,posting;
  result:=jsonb_set(result,ARRAY['lines',line_index::text],posted->'line');
 END LOOP;
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,compat_payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_receiving_arrival_legacy_compat(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_receiving_arrival_legacy_compat(uuid,timestamptz,jsonb,uuid,text,date,jsonb,boolean)
 TO authenticated;
NOTIFY pgrst,'reload schema';
