-- Only a canonical Physical Arrival office receipt can create Receiving project preparation.
CREATE OR REPLACE FUNCTION public.prepare_receiving_project_material(
 p_request_id uuid,p_receipt_id uuid,p_quantity numeric,p_serial_ids uuid[],
 p_project_id uuid,p_material_id uuid,p_create_new boolean,p_prepared_at timestamptz,p_notes text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('PROJECT_PREP',p_receipt_id,p_quantity,p_serial_ids,p_project_id,p_material_id,p_create_new,p_prepared_at,p_notes);
 scope jsonb; item public.inventory_items; material public.project_materials; batch_id uuid;
 actual_received numeric; prepared numeric; serial_id uuid; result jsonb; allocation_ids uuid[]:='{}'; allocation_id uuid;
BEGIN
 IF p_request_id IS NULL OR p_receipt_id IS NULL OR p_project_id IS NULL OR p_prepared_at IS NULL
  OR NOT isfinite(p_prepared_at) OR p_quantity IS NULL OR p_quantity<=0
  OR p_quantity::text IN ('NaN','Infinity','-Infinity') OR p_serial_ids IS NULL OR p_create_new IS NULL
  OR (p_material_id IS NOT NULL AND p_create_new)
 THEN RAISE EXCEPTION 'INVALID_PROJECT_PREP_REQUEST' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.material_receipts WHERE id=p_receipt_id
  AND source_type IN ('ARRIVAL','ARRIVAL_ROUTE') AND event_type='RECEIVE' AND inventory_linked)
 THEN RAISE EXCEPTION 'PROJECT_PREP_ARRIVAL_RECEIPT_REQUIRED' USING ERRCODE='PT409'; END IF;
 scope:=app_private.lock_receiving_handoff(p_receipt_id);
 IF p_quantity>(scope->>'available')::numeric THEN RAISE EXCEPTION 'HANDOFF_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=(scope->>'item_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'INVALID_PROJECT' USING ERRCODE='PT409'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_serial_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT x) FROM unnest(p_serial_ids)x)<>p_quantity
   OR (SELECT count(*) FROM jsonb_array_elements_text(scope->'available_serial_ids')x
    WHERE x::uuid=ANY(p_serial_ids))<>p_quantity
  THEN RAISE EXCEPTION 'HANDOFF_SERIAL_SCOPE_CONFLICT' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.inventory_serials WHERE id=ANY(p_serial_ids) ORDER BY id FOR UPDATE;
 ELSIF cardinality(p_serial_ids)<>0 THEN
  RAISE EXCEPTION 'NON_SERIAL_ENTRY_IDS_NOT_ALLOWED' USING ERRCODE='PT409';
 END IF;
 IF p_material_id IS NOT NULL THEN
  SELECT * INTO material FROM public.project_materials WHERE id=p_material_id FOR UPDATE;
  IF material.id IS NULL OR material.project_id<>p_project_id OR material.receiving_archived_at IS NOT NULL
   OR material.delivery_destination<>'SITE' OR material.unit<>item.unit OR material.procurement_status='RECEIVED'
   OR material.inventory_item_id IS DISTINCT FROM item.id
  THEN RAISE EXCEPTION 'PROJECT_PREP_REQUIREMENT_CONFLICT' USING ERRCODE='PT409'; END IF;
 ELSIF p_create_new THEN
  INSERT INTO public.project_material_batches(project_id,batch_name,created_by,ordered_at,planned_receipt_at)
   VALUES(p_project_id,'北辦預備物料',actor.id,p_prepared_at,p_prepared_at) RETURNING id INTO batch_id;
  INSERT INTO public.project_materials(project_id,batch_id,item_name,specification,quantity,unit,
   procurement_status,created_by,delivery_destination,inventory_item_id,include_in_purchase_request)
   VALUES(p_project_id,batch_id,item.name,item.code,p_quantity,item.unit,'ORDERED',actor.id,'SITE',item.id,false)
   RETURNING * INTO material;
 ELSE RAISE EXCEPTION 'PROJECT_PREP_REQUIREMENT_REQUIRED' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0)
 INTO actual_received FROM public.material_receipts WHERE project_material_id=material.id
  AND (receipt_location='SITE' OR receipt_location IS NULL);
 SELECT COALESCE(sum(quantity),0) INTO prepared FROM public.receiving_inventory_allocations
  WHERE project_material_id=material.id AND route_type='PROJECT_PREP' AND cancelled_at IS NULL;
 IF actual_received+prepared+p_quantity>material.quantity
 THEN RAISE EXCEPTION 'PROJECT_PREP_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF item.requires_serial THEN
  FOREACH serial_id IN ARRAY p_serial_ids LOOP
   INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,inventory_serial_id,
    quantity,route_type,project_material_id,created_by)
    VALUES(p_receipt_id,item.id,serial_id,1,'PROJECT_PREP',material.id,actor.id) RETURNING id INTO allocation_id;
   allocation_ids:=array_append(allocation_ids,allocation_id);
  END LOOP;
 ELSE
  INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,quantity,
   route_type,project_material_id,created_by)
   VALUES(p_receipt_id,item.id,p_quantity,'PROJECT_PREP',material.id,actor.id) RETURNING id INTO allocation_id;
  allocation_ids:=array_append(allocation_ids,allocation_id);
 END IF;
 result:=jsonb_build_object('id',(SELECT inventory_transaction_id FROM public.material_receipts WHERE id=p_receipt_id),'project_material_id',material.id,'allocation_ids',to_jsonb(allocation_ids),
  'inventory_effect',0,'site_receipt_id',NULL,'scope',app_private.receiving_handoff_scope(p_receipt_id));
 PERFORM app_private.inventory_audit('PREPARE_RECEIVING_PROJECT_MATERIAL',jsonb_build_object('receipt_id',p_receipt_id),result,
  'North Office stock reserved for project material; no SITE delivery');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.prepare_receiving_project_material(uuid,uuid,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_receiving_project_material(uuid,uuid,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 TO authenticated;
