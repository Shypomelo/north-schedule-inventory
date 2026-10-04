-- One receiving_arrival is one physical box or loose receipt batch.
-- Historical arrivals remain identifiable without assigning them a guessed kind.
ALTER TABLE public.receiving_arrivals
 ADD COLUMN batch_kind text,
 ADD COLUMN batch_session_id uuid,
 ADD COLUMN batch_position integer;
ALTER TABLE public.receiving_arrivals ADD CONSTRAINT receiving_arrivals_batch_identity_check
 CHECK ((batch_kind IS NULL AND batch_session_id IS NULL AND batch_position IS NULL)
   OR (batch_kind IN ('BOX','LOOSE') AND batch_session_id IS NOT NULL AND batch_position > 0));
CREATE UNIQUE INDEX receiving_arrivals_batch_session_position
 ON public.receiving_arrivals(batch_session_id,batch_position) WHERE batch_session_id IS NOT NULL;

-- One user submission, one transaction. The existing single-item contract owns
-- validation, serial registration, source audit and fulfilment semantics.
CREATE FUNCTION public.create_receiving_pending_batch(
 p_request_id uuid,p_project_id uuid,p_notes text,p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('PENDING_BATCH_V1',p_project_id,p_notes,p_items);
 spec jsonb; created jsonb; result jsonb:='[]';
BEGIN
 IF p_request_id IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'PENDING_BATCH_REQUIRED' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN
   RAISE EXCEPTION 'PENDING_BATCH_REQUEST_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 FOR spec IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  IF jsonb_typeof(spec) IS DISTINCT FROM 'object'
   OR spec->>'item_id' IS NULL OR spec->>'quantity' IS NULL
   OR spec->>'expected_at' IS NULL OR jsonb_typeof(COALESCE(spec->'serials','[]'::jsonb)) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'PENDING_BATCH_ITEM_INVALID' USING ERRCODE='22023'; END IF;
  created:=public.create_office_equipment_arrival(gen_random_uuid(),
   (spec->>'item_id')::uuid,(spec->>'quantity')::numeric,(spec->>'expected_at')::timestamptz,
   p_project_id,p_notes,COALESCE(spec->'serials','[]'::jsonb));
  result:=result||jsonb_build_array(created);
 END LOOP;
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_receiving_pending_batch(uuid,uuid,text,jsonb)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_receiving_pending_batch(uuid,uuid,text,jsonb) TO authenticated;

-- Multiple boxes are committed atomically. Each box is an independent
-- receiving_arrival, so its lines can later take different routes.
CREATE FUNCTION public.create_receiving_batches(
 p_request_id uuid,p_actual_received_at timestamptz,p_project_id uuid,p_batches jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('PHYSICAL_BATCHES_V1',p_actual_received_at,p_project_id,p_batches);
 spec jsonb; created jsonb; result jsonb:='[]'; position integer:=0; kind text;
BEGIN
 IF p_request_id IS NULL OR p_actual_received_at IS NULL OR NOT isfinite(p_actual_received_at)
  OR jsonb_typeof(p_batches) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batches) NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'PHYSICAL_BATCHES_REQUIRED' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN
   RAISE EXCEPTION 'PHYSICAL_BATCHES_REQUEST_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 FOR spec IN SELECT value FROM jsonb_array_elements(p_batches) LOOP
  kind:=spec->>'kind'; position:=position+1;
  IF jsonb_typeof(spec) IS DISTINCT FROM 'object' OR kind IS NULL OR kind NOT IN ('BOX','LOOSE')
   OR jsonb_typeof(spec->'lines') IS DISTINCT FROM 'array'
   OR jsonb_typeof(COALESCE(spec->'matches','[]'::jsonb)) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'PHYSICAL_BATCH_INVALID' USING ERRCODE='22023'; END IF;
  created:=public.create_receiving_arrival(gen_random_uuid(),p_actual_received_at,
   spec->'lines',p_project_id,NULL,NULL,COALESCE(spec->'matches','[]'::jsonb),true);
  UPDATE public.receiving_arrivals SET batch_kind=kind,batch_session_id=p_request_id,
   batch_position=position WHERE id=(created->'arrival'->>'id')::uuid;
  created:=jsonb_set(created,'{arrival}',(SELECT to_jsonb(a) FROM public.receiving_arrivals a
   WHERE a.id=(created->'arrival'->>'id')::uuid));
  result:=result||jsonb_build_array(created);
 END LOOP;
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_receiving_batches(uuid,timestamptz,uuid,jsonb)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_receiving_batches(uuid,timestamptz,uuid,jsonb) TO authenticated;

-- A selected set of unknown serial lines resolves together or not at all.
CREATE FUNCTION public.complete_receiving_arrival_lines(
 p_request_id uuid,p_line_ids uuid[],p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('STAGE_ARRIVAL_LINES_V1',p_line_ids,p_item_id);
 line_id uuid; parent_id uuid; current_parent uuid; resolved jsonb; result jsonb:='[]';
BEGIN
 IF p_request_id IS NULL OR p_item_id IS NULL OR p_line_ids IS NULL
  OR cardinality(p_line_ids) NOT BETWEEN 1 AND 100
  OR array_position(p_line_ids,NULL) IS NOT NULL
  OR (SELECT count(DISTINCT id) FROM unnest(p_line_ids) id)<>cardinality(p_line_ids)
 THEN RAISE EXCEPTION 'ARRIVAL_BATCH_RESOLVE_REQUIRED' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN
   RAISE EXCEPTION 'ARRIVAL_BATCH_RESOLVE_REQUEST_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 FOR line_id IN SELECT id FROM unnest(p_line_ids) id ORDER BY id LOOP
  SELECT arrival_id INTO current_parent FROM public.receiving_arrival_lines WHERE id=line_id;
  IF current_parent IS NULL OR (parent_id IS NOT NULL AND parent_id<>current_parent)
  THEN RAISE EXCEPTION 'ARRIVAL_BATCH_RESOLVE_SCOPE' USING ERRCODE='PT409'; END IF;
  parent_id:=current_parent;
  resolved:=public.complete_receiving_arrival_line(gen_random_uuid(),line_id,p_item_id,NULL);
  result:=result||jsonb_build_array(resolved);
 END LOOP;
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.complete_receiving_arrival_lines(uuid,uuid[],uuid)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.complete_receiving_arrival_lines(uuid,uuid[],uuid) TO authenticated;
