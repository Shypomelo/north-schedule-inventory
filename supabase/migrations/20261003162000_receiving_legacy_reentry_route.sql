-- Preserve canonical ARRIVAL receipt lineage when routing a returned legacy arrival.
CREATE OR REPLACE FUNCTION public.route_staged_receiving(
 p_request_id uuid,p_stage_kind text,p_line_id uuid,p_reversal_receipt_id uuid,
 p_route_type text,p_quantity numeric,p_entry_ids uuid[],p_project_id uuid,
 p_material_id uuid,p_create_new boolean,p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('ROUTE_STAGED',p_stage_kind,p_line_id,p_reversal_receipt_id,
  p_route_type,p_quantity,p_entry_ids,p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
 posted jsonb; routed jsonb; v_receipt_id uuid; serial_ids uuid[]; result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_stage_kind NOT IN ('NORMAL','REENTRY') OR p_route_type NOT IN ('SE','SITE','PROJECT_PREP')
  OR p_line_id IS NULL OR p_quantity IS NULL OR p_quantity<=0 OR p_received_at IS NULL
  OR NOT isfinite(p_received_at) OR p_entry_ids IS NULL OR p_create_new IS NULL
  OR (p_stage_kind='NORMAL' AND p_reversal_receipt_id IS NOT NULL)
  OR (p_stage_kind='REENTRY' AND p_reversal_receipt_id IS NULL)
 THEN RAISE EXCEPTION 'INVALID_STAGED_ROUTE_REQUEST' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 IF p_stage_kind='NORMAL' THEN
  posted:=public.post_receiving_arrival_line(gen_random_uuid(),p_line_id,p_quantity,p_entry_ids,NULL);
 ELSE
  PERFORM 1 FROM public.material_receipts WHERE id=p_reversal_receipt_id
   AND COALESCE(route_arrival_line_id,arrival_line_id)=p_line_id AND event_type='REVERSAL';
  IF NOT FOUND THEN RAISE EXCEPTION 'REENTRY_LINE_CONFLICT' USING ERRCODE='PT409'; END IF;
  posted:=public.reenter_receiving_inventory(gen_random_uuid(),p_reversal_receipt_id,p_quantity,p_entry_ids,p_received_at,p_notes);
 END IF;
 v_receipt_id:=(posted->'receipt'->>'id')::uuid;
 SELECT COALESCE(array_agg(link.inventory_serial_id ORDER BY link.entry_id),'{}') INTO serial_ids
 FROM public.material_receipt_serials link WHERE link.receipt_id=v_receipt_id;
 IF (SELECT requires_serial FROM public.inventory_items WHERE id=(SELECT inventory_item_id FROM public.receiving_arrival_lines WHERE id=p_line_id))
  AND (cardinality(serial_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(*) FROM public.material_receipt_serials link WHERE link.receipt_id=v_receipt_id AND link.entry_id=ANY(p_entry_ids))<>p_quantity)
 THEN RAISE EXCEPTION 'STAGED_ROUTE_SERIAL_IDENTITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_route_type='PROJECT_PREP' THEN
  routed:=public.prepare_receiving_project_material(gen_random_uuid(),v_receipt_id,p_quantity,serial_ids,
   p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
 ELSE
  routed:=public.route_receiving_inventory(gen_random_uuid(),v_receipt_id,p_route_type,p_quantity,serial_ids,
   p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
 END IF;
 result:=jsonb_build_object('receipt',posted->'receipt','route',routed,'stage_kind',p_stage_kind);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.route_staged_receiving(uuid,text,uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.route_staged_receiving(uuid,text,uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 TO authenticated;
