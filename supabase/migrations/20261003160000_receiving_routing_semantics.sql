-- Receiving route semantics: reverse only the unallocated part of an office receipt.
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
 IF (item.requires_serial AND EXISTS(SELECT 1 FROM public.receiving_inventory_allocations a
   WHERE a.office_receipt_id=receipt.id AND a.cancelled_at IS NULL
    AND a.inventory_serial_id IN (
     SELECT rs.inventory_serial_id FROM public.material_receipt_serials rs
     WHERE rs.receipt_id=receipt.id AND rs.entry_id=ANY(p_entry_ids))))
   OR (NOT item.requires_serial AND already+p_quantity+
    (SELECT COALESCE(sum(a.quantity),0) FROM public.receiving_inventory_allocations a
     WHERE a.office_receipt_id=receipt.id AND a.cancelled_at IS NULL)>receipt.quantity_received)
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

-- A project preparation is a reservation of office stock, with no delivery ledger effect.
ALTER TABLE public.receiving_inventory_allocations DROP CONSTRAINT receiving_inventory_allocations_route_type_check;
ALTER TABLE public.receiving_inventory_allocations ADD CONSTRAINT receiving_inventory_allocations_route_type_check
 CHECK (route_type IN ('SE','SITE','PROJECT_PREP'));
ALTER TABLE public.receiving_inventory_allocations DROP CONSTRAINT receiving_allocation_route_links;
ALTER TABLE public.receiving_inventory_allocations ADD CONSTRAINT receiving_allocation_route_links CHECK (
 (route_type='SE' AND se_supply_record_id IS NOT NULL AND site_receipt_id IS NULL AND inventory_transaction_id IS NULL AND project_material_id IS NULL)
 OR (route_type='SITE' AND se_supply_record_id IS NULL AND site_receipt_id IS NOT NULL AND inventory_transaction_id IS NOT NULL AND project_material_id IS NOT NULL)
 OR (route_type='PROJECT_PREP' AND se_supply_record_id IS NULL AND site_receipt_id IS NULL AND inventory_transaction_id IS NULL AND project_material_id IS NOT NULL));

CREATE INDEX receiving_allocation_project_prep ON public.receiving_inventory_allocations(project_material_id)
 WHERE route_type='PROJECT_PREP' AND cancelled_at IS NULL;

CREATE OR REPLACE FUNCTION app_private.receiving_reserved_quantity(p_item_id uuid)
 RETURNS numeric LANGUAGE sql VOLATILE SET search_path='' AS $$
 SELECT COALESCE(sum(a.quantity),0) FROM public.receiving_inventory_allocations a
 WHERE a.inventory_item_id=p_item_id AND a.inventory_serial_id IS NULL
  AND a.route_type IN ('SE','PROJECT_PREP') AND a.cancelled_at IS NULL
$$;

CREATE OR REPLACE FUNCTION app_private.guard_reserved_serial() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status='在庫' AND (
  EXISTS(SELECT 1 FROM public.receiving_inventory_allocations a WHERE a.inventory_serial_id=OLD.id
   AND a.route_type='PROJECT_PREP' AND a.cancelled_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.se_supply_records r WHERE r.inventory_serial_id=OLD.id
   AND r.replace_date IS NULL AND r.cancelled_at IS NULL AND NOT r.receiving_only
   AND NOT EXISTS(SELECT 1 FROM app_private.inventory_routing_context c WHERE c.backend=pg_backend_pid()
    AND c.transaction_id=txid_current() AND r.id=ANY(c.se_ids))))
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_private.guard_project_prep_material() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE prepared numeric; received numeric;
BEGIN
 SELECT COALESCE(sum(quantity),0) INTO prepared FROM public.receiving_inventory_allocations
  WHERE project_material_id=OLD.id AND route_type='PROJECT_PREP' AND cancelled_at IS NULL;
 IF prepared=0 THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROJECT_PREP_RETRACTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0)
 INTO received FROM public.material_receipts WHERE project_material_id=OLD.id
  AND (receipt_location='SITE' OR receipt_location IS NULL);
 IF row(NEW.project_id,NEW.inventory_item_id,NEW.unit,NEW.delivery_destination,NEW.receiving_archived_at)
  IS DISTINCT FROM row(OLD.project_id,OLD.inventory_item_id,OLD.unit,OLD.delivery_destination,OLD.receiving_archived_at)
  OR NEW.quantity < prepared+received
 THEN RAISE EXCEPTION 'PROJECT_PREP_RETRACTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receiving_project_prep_material_guard BEFORE UPDATE OR DELETE ON public.project_materials
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_prep_material();
REVOKE ALL ON FUNCTION app_private.guard_project_prep_material() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.guard_project_prep_site_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE prepared numeric; material_quantity numeric; already numeric;
BEGIN
 IF NEW.project_material_id IS NULL OR NEW.event_type<>'RECEIVE' OR NEW.receipt_location IS DISTINCT FROM 'SITE'
  OR (TG_OP='UPDATE' AND OLD.receipt_location='SITE') THEN RETURN NEW; END IF;
 SELECT COALESCE(sum(quantity),0) INTO prepared FROM public.receiving_inventory_allocations
  WHERE project_material_id=NEW.project_material_id AND route_type='PROJECT_PREP' AND cancelled_at IS NULL;
 IF prepared=0 THEN RETURN NEW; END IF;
 SELECT quantity INTO material_quantity FROM public.project_materials WHERE id=NEW.project_material_id;
 SELECT COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0)
 INTO already FROM public.material_receipts WHERE project_material_id=NEW.project_material_id
  AND id<>NEW.id AND (receipt_location='SITE' OR receipt_location IS NULL);
 IF prepared+already+NEW.quantity_received>material_quantity
 THEN RAISE EXCEPTION 'PROJECT_PREP_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receiving_project_prep_site_guard BEFORE INSERT OR UPDATE ON public.material_receipts
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_prep_site_receipt();
REVOKE ALL ON FUNCTION app_private.guard_project_prep_site_receipt() FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION app_private.receiving_handoff_scope(p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.material_receipts; l public.receiving_arrival_lines; a public.receiving_arrivals;
 item public.inventory_items; iid uuid; received numeric; se numeric; site numeric; prep numeric; available numeric; ids uuid[];
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
 SELECT COALESCE(sum(quantity) FILTER(WHERE route_type='SE'),0),COALESCE(sum(quantity) FILTER(WHERE route_type='SITE'),0),COALESCE(sum(quantity) FILTER(WHERE route_type='PROJECT_PREP'),0)
 INTO se,site,prep FROM public.receiving_inventory_allocations WHERE office_receipt_id=r.id AND cancelled_at IS NULL;
 available:=GREATEST(0,received-se-site-prep);
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
  'received',received,'se',se,'site',site,'prep',prep,'other',GREATEST(0,received-se-site-prep-available),'available',available,'available_serial_ids',to_jsonb(ids),
  'allocations',COALESCE((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('state',app_private.receiving_allocation_state(x)) ORDER BY x.created_at,x.id)
   FROM public.receiving_inventory_allocations x WHERE x.office_receipt_id=r.id),'[]'));
END $$;
REVOKE ALL ON FUNCTION app_private.receiving_handoff_scope(uuid) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION public.get_receiving_project_requirements(p_project_id uuid,p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN
  RAISE EXCEPTION 'INVALID_PROJECT' USING ERRCODE='PT409';
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]') INTO result FROM (
  SELECT m.id,m.batch_id,b.batch_name,m.item_name,m.specification,m.unit,m.quantity,m.created_at,
   COALESCE((SELECT sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END)
    FROM public.material_receipts WHERE project_material_id=m.id AND (receipt_location='SITE' OR receipt_location IS NULL)),0) AS received,
   COALESCE((SELECT sum(quantity) FROM public.receiving_inventory_allocations WHERE project_material_id=m.id
    AND route_type='PROJECT_PREP' AND cancelled_at IS NULL),0) AS prepared
  FROM public.project_materials m JOIN public.project_material_batches b ON b.id=m.batch_id
  JOIN public.inventory_items i ON i.id=m.inventory_item_id
  WHERE m.project_id=p_project_id AND m.inventory_item_id=p_item_id AND m.receiving_archived_at IS NULL
   AND m.delivery_destination='SITE' AND m.procurement_status<>'RECEIVED' AND m.unit=i.unit
 ) r WHERE r.quantity>r.received+r.prepared;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_receiving_project_requirements(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_receiving_project_requirements(uuid,uuid) TO authenticated;

CREATE FUNCTION public.prepare_receiving_project_material(
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
 result:=jsonb_build_object('project_material_id',material.id,'allocation_ids',to_jsonb(allocation_ids),
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
   AND route_arrival_line_id=p_line_id AND event_type='REVERSAL';
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

-- One RPC transaction owns the SE cancellation and the exact Receiving IN reversal.
CREATE FUNCTION public.return_receiving_se_to_received(
 p_request_id uuid,p_record_id uuid,p_reason text,p_reversed_at timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('RETURN_RECEIVING_SE',p_record_id,p_reason,p_reversed_at);
 allocation public.receiving_inventory_allocations; receipt public.material_receipts;
 effective_at timestamptz:=COALESCE(p_reversed_at,clock_timestamp()); entry_ids uuid[]:='{}';
 retracted jsonb; reversed jsonb; result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_record_id IS NULL OR nullif(btrim(p_reason),'') IS NULL
  OR NOT isfinite(effective_at)
 THEN RAISE EXCEPTION 'INVALID_RECEIVING_SE_RETURN' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT * INTO allocation FROM public.receiving_inventory_allocations
  WHERE se_supply_record_id=p_record_id AND route_type='SE' AND cancelled_at IS NULL;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=allocation.office_receipt_id;
 IF allocation.id IS NULL OR receipt.source_type NOT IN ('ARRIVAL','ARRIVAL_ROUTE')
  OR receipt.event_type<>'RECEIVE' OR NOT receipt.inventory_linked
 THEN RAISE EXCEPTION 'RECEIVING_SE_LINEAGE_REQUIRED' USING ERRCODE='PT409'; END IF;
 IF allocation.inventory_serial_id IS NOT NULL THEN
  SELECT COALESCE(array_agg(rs.entry_id),'{}') INTO entry_ids FROM public.material_receipt_serials rs
   WHERE rs.receipt_id=receipt.id AND rs.inventory_serial_id=allocation.inventory_serial_id
    AND NOT rs.linked_existing;
  IF cardinality(entry_ids)<>1 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 END IF;
 BEGIN
  retracted:=public.retract_receiving_handoff(gen_random_uuid(),allocation.id,p_reason,effective_at);
  reversed:=public.reverse_receiving_inventory_in(gen_random_uuid(),receipt.id,allocation.quantity,
   entry_ids,effective_at,p_reason);
 EXCEPTION WHEN check_violation OR SQLSTATE 'PT409' THEN
  RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409',DETAIL=SQLERRM;
 END;
 result:=jsonb_build_object('outcome','RETURNED_TO_RECEIVED','allocation_id',allocation.id,
  'se_record_id',p_record_id,'inventory_serial_id',allocation.inventory_serial_id,
  'retraction',retracted,'reversal',reversed);
 PERFORM app_private.inventory_audit('RETURN_RECEIVING_SE_TO_RECEIVED',to_jsonb(allocation),result,p_reason);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.return_receiving_se_to_received(uuid,uuid,text,timestamptz) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.return_receiving_se_to_received(uuid,uuid,text,timestamptz) TO authenticated;

CREATE FUNCTION public.return_receiving_project_prep_to_received(
 p_request_id uuid,p_allocation_id uuid,p_reason text,p_reversed_at timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('RETURN_PROJECT_PREP',p_allocation_id,p_reason,p_reversed_at);
 allocation public.receiving_inventory_allocations; receipt public.material_receipts; scope jsonb;
 effective_at timestamptz:=COALESCE(p_reversed_at,clock_timestamp()); entry_ids uuid[]:='{}';
 reversed jsonb; result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_allocation_id IS NULL OR nullif(btrim(p_reason),'') IS NULL
  OR NOT isfinite(effective_at)
 THEN RAISE EXCEPTION 'INVALID_PROJECT_PREP_RETURN' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT * INTO allocation FROM public.receiving_inventory_allocations WHERE id=p_allocation_id;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=allocation.office_receipt_id;
 IF allocation.id IS NULL OR allocation.route_type<>'PROJECT_PREP' OR allocation.cancelled_at IS NOT NULL
  OR receipt.source_type NOT IN ('ARRIVAL','ARRIVAL_ROUTE') OR receipt.event_type<>'RECEIVE'
  OR NOT receipt.inventory_linked OR allocation.inventory_transaction_id IS NOT NULL OR allocation.site_receipt_id IS NOT NULL
 THEN RAISE EXCEPTION 'PROJECT_PREP_LINEAGE_REQUIRED' USING ERRCODE='PT409'; END IF;
 scope:=app_private.lock_receiving_handoff(allocation.office_receipt_id);
 SELECT * INTO allocation FROM public.receiving_inventory_allocations WHERE id=p_allocation_id FOR UPDATE;
 IF allocation.cancelled_at IS NOT NULL OR app_private.receiving_allocation_state(allocation)<>'ACTIVE'
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 IF allocation.inventory_serial_id IS NOT NULL THEN
  SELECT COALESCE(array_agg(rs.entry_id),'{}') INTO entry_ids FROM public.material_receipt_serials rs
   WHERE rs.receipt_id=receipt.id AND rs.inventory_serial_id=allocation.inventory_serial_id
    AND NOT rs.linked_existing;
  IF cardinality(entry_ids)<>1 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 END IF;
 BEGIN
  UPDATE public.receiving_inventory_allocations SET cancelled_at=clock_timestamp(),cancelled_by=actor.id,
   cancellation_reason=p_reason WHERE id=allocation.id;
  reversed:=public.reverse_receiving_inventory_in(gen_random_uuid(),receipt.id,allocation.quantity,
   entry_ids,effective_at,p_reason);
 EXCEPTION WHEN check_violation OR SQLSTATE 'PT409' THEN
  RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409',DETAIL=SQLERRM;
 END;
 result:=jsonb_build_object('outcome','RETURNED_TO_RECEIVED','allocation_id',allocation.id,
  'project_material_id',allocation.project_material_id,'inventory_serial_id',allocation.inventory_serial_id,
  'reversal',reversed);
 PERFORM app_private.inventory_audit('RETURN_RECEIVING_PROJECT_PREP_TO_RECEIVED',to_jsonb(allocation),result,p_reason);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.return_receiving_project_prep_to_received(uuid,uuid,text,timestamptz) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.return_receiving_project_prep_to_received(uuid,uuid,text,timestamptz) TO authenticated;
