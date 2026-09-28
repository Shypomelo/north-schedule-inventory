-- V6-A: one-time receipt-scoped handoff. Inventory remains the sole stock ledger.
-- No Arrival/Pending merge, downstream metadata mirroring, or new handoff ledger.
ALTER TABLE public.receiving_inventory_allocations
 ADD COLUMN cancelled_by uuid REFERENCES public.team_members(id) ON DELETE RESTRICT,
 ADD COLUMN cancellation_reason text,
 ADD COLUMN reversal_receipt_id uuid REFERENCES public.material_receipts(id) ON DELETE RESTRICT,
 ADD COLUMN supersedes_allocation_id uuid REFERENCES public.receiving_inventory_allocations(id) ON DELETE RESTRICT;
ALTER TABLE public.receiving_inventory_allocations DROP CONSTRAINT receiving_inventory_allocations_check1;
ALTER TABLE public.receiving_inventory_allocations ADD CONSTRAINT receiving_allocation_route_links CHECK (
 (route_type='SE' AND se_supply_record_id IS NOT NULL AND site_receipt_id IS NULL AND inventory_transaction_id IS NULL AND project_material_id IS NULL)
 OR (route_type='SITE' AND se_supply_record_id IS NULL AND site_receipt_id IS NOT NULL AND inventory_transaction_id IS NOT NULL AND project_material_id IS NOT NULL));
DROP INDEX public.receiving_allocation_se;
CREATE UNIQUE INDEX receiving_allocation_se ON public.receiving_inventory_allocations(se_supply_record_id)
 WHERE se_supply_record_id IS NOT NULL AND cancelled_at IS NULL;
CREATE INDEX receiving_allocation_site_receipt ON public.receiving_inventory_allocations(site_receipt_id) WHERE site_receipt_id IS NOT NULL;

CREATE FUNCTION app_private.guard_handoff_shape() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE item public.inventory_items;
BEGIN
 SELECT * INTO item FROM public.inventory_items WHERE id=NEW.inventory_item_id;
 IF item.id IS NULL OR item.requires_serial IS DISTINCT FROM (NEW.inventory_serial_id IS NOT NULL)
 OR (NEW.inventory_serial_id IS NOT NULL AND (NEW.quantity<>1 OR NOT EXISTS(
  SELECT 1 FROM public.inventory_serials WHERE id=NEW.inventory_serial_id AND item_id=item.id)))
 THEN RAISE EXCEPTION 'HANDOFF_ITEM_SERIAL_SHAPE_CONFLICT' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receiving_handoff_shape BEFORE INSERT ON public.receiving_inventory_allocations FOR EACH ROW EXECUTE FUNCTION app_private.guard_handoff_shape();

CREATE FUNCTION app_private.receiving_allocation_state(a public.receiving_inventory_allocations) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE
 WHEN a.cancelled_at IS NOT NULL THEN CASE WHEN a.reversal_receipt_id IS NULL THEN 'CANCELLED' ELSE 'REVERSED' END
 WHEN EXISTS(SELECT 1 FROM public.maintenance_equipment_records m WHERE m.se_supply_record_id=a.se_supply_record_id OR m.inventory_serial_id=a.inventory_serial_id OR m.inventory_transaction_id=a.inventory_transaction_id)
  OR (a.route_type='SE' AND EXISTS(SELECT 1 FROM public.se_supply_records s WHERE s.id=a.se_supply_record_id AND s.replace_date IS NOT NULL)) THEN 'USED'
 WHEN a.route_type='SITE' AND (
  EXISTS(SELECT 1 FROM public.inventory_transaction_serials old_link JOIN public.inventory_transaction_serials next_link ON next_link.serial_id=old_link.serial_id
   AND next_link.transaction_id<>old_link.transaction_id AND next_link.created_at>=old_link.created_at
   JOIN public.inventory_transactions t ON t.id=next_link.transaction_id AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL
   WHERE old_link.transaction_id=a.inventory_transaction_id AND old_link.serial_id=a.inventory_serial_id)
  OR (a.inventory_serial_id IS NULL AND EXISTS(SELECT 1 FROM public.inventory_transactions old_tx JOIN public.inventory_transactions t
   ON t.item_id=old_tx.item_id AND t.id<>old_tx.id AND t.created_at>=old_tx.created_at AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL
   WHERE old_tx.id=a.inventory_transaction_id AND (t.transaction_type IN('OUT','RETURN') OR t.transaction_type='ADJUST' AND t.quantity<0)))
 ) THEN 'TERMINAL'
 ELSE 'ACTIVE' END
$$;

CREATE FUNCTION app_private.guard_handoff_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HANDOFF_HISTORY_IMMUTABLE' USING ERRCODE='PT409'; END IF;
 IF OLD.cancelled_at IS NOT NULL OR
 (to_jsonb(NEW)-ARRAY['cancelled_at','cancelled_by','cancellation_reason','reversal_receipt_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['cancelled_at','cancelled_by','cancellation_reason','reversal_receipt_id'])
 THEN RAISE EXCEPTION 'HANDOFF_HISTORY_IMMUTABLE' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;

-- Receipt-scoped allocations are immutable provenance. Controlled edits replace a row;
-- ordinary downstream notes/dates never copy back into Receiving.
CREATE OR REPLACE FUNCTION app_private.sync_receiving_se_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations WHERE se_supply_record_id=OLD.id AND cancelled_at IS NULL)
 AND row(NEW.inventory_serial_id,NEW.inventory_item_id,NEW.quantity,NEW.unit,NEW.cancelled_at,NEW.receiving_only,NEW.inventory_routed,NEW.new_serial,NEW.new_model,NEW.project_id)
  IS DISTINCT FROM row(OLD.inventory_serial_id,OLD.inventory_item_id,OLD.quantity,OLD.unit,OLD.cancelled_at,OLD.receiving_only,OLD.inventory_routed,OLD.new_serial,OLD.new_model,OLD.project_id)
 AND NOT EXISTS(SELECT 1 FROM app_private.inventory_routing_context c WHERE c.backend=pg_backend_pid() AND c.transaction_id=txid_current() AND OLD.id=ANY(c.se_ids))
 THEN RAISE EXCEPTION 'HANDOFF_CONTROLLED_EDIT_REQUIRED' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_private.assert_receiving_se_unused(p_allocation public.receiving_inventory_allocations) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.se_supply_records;
BEGIN
 SELECT * INTO r FROM public.se_supply_records WHERE id=p_allocation.se_supply_record_id FOR UPDATE;
 IF r.id IS NULL OR r.receiving_only OR r.cancelled_at IS NOT NULL OR r.replace_date IS NOT NULL
 OR r.inventory_item_id IS DISTINCT FROM p_allocation.inventory_item_id OR r.inventory_serial_id IS DISTINCT FROM p_allocation.inventory_serial_id OR r.quantity<>p_allocation.quantity
 OR EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE se_supply_record_id=r.id OR (p_allocation.inventory_serial_id IS NOT NULL AND inventory_serial_id=p_allocation.inventory_serial_id))
 OR (p_allocation.inventory_serial_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.inventory_serials WHERE id=p_allocation.inventory_serial_id AND item_id=p_allocation.inventory_item_id AND status='在庫'))
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
END $$;

-- Project retract reverses a whole SITE handoff (all serialized allocation rows in
-- the same SITE receipt), never silently edits a subset of a shared OUT.
CREATE FUNCTION public.retract_receiving_handoff(p_request_id uuid,p_allocation_id uuid,p_reason text,p_retracted_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); alloc public.receiving_inventory_allocations; r public.se_supply_records;
 site public.material_receipts; reversal public.material_receipts; tx public.inventory_transactions; scope jsonb; result jsonb; serials uuid[];
 effective_at timestamptz:=COALESCE(p_retracted_at,clock_timestamp());
 payload jsonb:=jsonb_build_array('RETRACT_HANDOFF',p_allocation_id,p_reason,p_retracted_at); cached app_private.receiving_requests;
BEGIN
 IF p_request_id IS NULL OR nullif(btrim(p_reason),'') IS NULL OR NOT isfinite(effective_at) THEN RAISE EXCEPTION 'Retraction request, reason and valid time required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE id=p_allocation_id;
 IF alloc.id IS NULL THEN RAISE EXCEPTION 'HANDOFF_NOT_FOUND' USING ERRCODE='PT409'; END IF;
 scope:=app_private.lock_receiving_handoff(alloc.office_receipt_id,true);
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE id=p_allocation_id FOR UPDATE;
 IF alloc.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'HANDOFF_NOT_ACTIVE' USING ERRCODE='PT409'; END IF;
 IF alloc.route_type='SE' THEN
  PERFORM 1 FROM public.inventory_serials WHERE id=alloc.inventory_serial_id FOR UPDATE;
  PERFORM app_private.assert_receiving_se_unused(alloc);
  SELECT * INTO r FROM public.se_supply_records WHERE id=alloc.se_supply_record_id;
  INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),NULL,ARRAY[r.id]);
  UPDATE public.se_supply_records SET cancelled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=r.id;
  UPDATE public.receiving_inventory_allocations SET cancelled_at=clock_timestamp(),cancelled_by=actor.id,cancellation_reason=p_reason WHERE id=alloc.id;
  DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
  result:=jsonb_build_object('id',alloc.id,'outcome','RETRACTED','route','SE','allocation_ids',jsonb_build_array(alloc.id));
 ELSE
  SELECT * INTO tx FROM public.inventory_transactions WHERE id=alloc.inventory_transaction_id FOR UPDATE;
  PERFORM 1 FROM public.receiving_inventory_allocations WHERE site_receipt_id=alloc.site_receipt_id ORDER BY id FOR UPDATE;
  SELECT * INTO site FROM public.material_receipts WHERE id=alloc.site_receipt_id FOR UPDATE;
  SELECT COALESCE(array_agg(inventory_serial_id ORDER BY inventory_serial_id) FILTER(WHERE inventory_serial_id IS NOT NULL),'{}') INTO serials
   FROM public.receiving_inventory_allocations WHERE site_receipt_id=site.id AND cancelled_at IS NULL;
  PERFORM 1 FROM public.inventory_serials WHERE id=ANY(serials) ORDER BY id FOR UPDATE;
  IF tx.id IS NULL OR tx.is_voided OR tx.excluded_by_initialization_id IS NOT NULL OR tx.transaction_type<>'OUT'
   OR tx.item_id<>alloc.inventory_item_id OR tx.schedule_task_id IS NOT NULL
   OR site.id IS NULL OR site.event_type<>'RECEIVE' OR site.receipt_location IS DISTINCT FROM 'SITE'
   OR site.inventory_transaction_id IS DISTINCT FROM tx.id OR site.project_material_id IS DISTINCT FROM alloc.project_material_id
   OR site.quantity_received<>tx.quantity
   OR EXISTS(SELECT 1 FROM public.material_receipts WHERE reversal_of_id=site.id)
   OR EXISTS(SELECT 1 FROM public.receiving_inventory_allocations WHERE site_receipt_id=site.id AND
      (cancelled_at IS NOT NULL OR office_receipt_id<>alloc.office_receipt_id OR inventory_transaction_id<>tx.id OR inventory_item_id<>tx.item_id))
   OR (SELECT sum(quantity) FROM public.receiving_inventory_allocations WHERE site_receipt_id=site.id AND cancelled_at IS NULL) IS DISTINCT FROM tx.quantity
   OR EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE inventory_transaction_id=tx.id OR inventory_serial_id=ANY(serials))
   OR EXISTS(SELECT 1 FROM public.inventory_serials WHERE id=ANY(serials) AND (status<>'已出庫' OR project_id IS DISTINCT FROM tx.project_id))
   OR EXISTS(SELECT 1 FROM public.inventory_monthly_closings WHERE status='CLOSED' AND
     ((year=to_char(tx.transaction_date,'YYYY') AND month=to_char(tx.transaction_date,'MM')) OR
      (year=to_char(effective_at AT TIME ZONE 'Asia/Taipei','YYYY') AND month=to_char(effective_at AT TIME ZONE 'Asia/Taipei','MM'))))
  THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
  -- Quantity has no serial chronology: any subsequent same-item debit/return is
  -- conservatively a correction boundary, including maintenance material use.
  IF cardinality(serials)=0 AND EXISTS(SELECT 1 FROM public.inventory_transactions later WHERE later.item_id=tx.item_id AND later.id<>tx.id
   AND later.created_at>=tx.created_at AND NOT later.is_voided AND later.excluded_by_initialization_id IS NULL
   AND (later.transaction_type IN('OUT','RETURN') OR later.transaction_type='ADJUST' AND later.quantity<0))
  THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
  BEGIN
   PERFORM app_private.inventory_assert_terminal(tx.id);
   INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),site.id,'{}');
   PERFORM public.write_inventory_transaction_atomic('VOID','{}','[]',tx.id,p_reason,tx.updated_at);
   SELECT * INTO reversal FROM app_private.append_receiving_reversal(site.id,site.quantity_received,effective_at,p_reason);
   UPDATE public.material_receipts SET receipt_location='SITE',inventory_transaction_id=tx.id,inventory_linked=true WHERE id=reversal.id;
   PERFORM app_private.rederive_material_receipt_source('PROJECT_MATERIAL',site.project_material_id);
   UPDATE public.receiving_inventory_allocations SET cancelled_at=clock_timestamp(),cancelled_by=actor.id,cancellation_reason=p_reason,reversal_receipt_id=reversal.id
    WHERE site_receipt_id=site.id AND cancelled_at IS NULL;
   DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
  EXCEPTION WHEN check_violation OR SQLSTATE 'PT409' THEN
   RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409',DETAIL=SQLERRM;
  END;
  result:=jsonb_build_object('id',alloc.id,'outcome','RETRACTED','route','SITE','reversal_receipt_id',reversal.id,
   'allocation_ids',(SELECT jsonb_agg(id ORDER BY id) FROM public.receiving_inventory_allocations WHERE site_receipt_id=site.id));
 END IF;
 result:=result||jsonb_build_object('retracted_at',effective_at,'scope',app_private.receiving_handoff_scope(alloc.office_receipt_id));
 PERFORM app_private.inventory_audit('RETRACT_RECEIVING_HANDOFF',to_jsonb(alloc),result,p_reason);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;

CREATE FUNCTION public.change_receiving_se_handoff(p_request_id uuid,p_allocation_id uuid,p_quantity numeric,p_serial_id uuid,p_project_id uuid,p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); alloc public.receiving_inventory_allocations; next_alloc public.receiving_inventory_allocations;
 r public.se_supply_records; item public.inventory_items; serial public.inventory_serials; scope jsonb; result jsonb;
 payload jsonb:=jsonb_build_array('CHANGE_SE_HANDOFF',p_allocation_id,p_quantity,p_serial_id,p_project_id,p_expected_updated_at); cached app_private.receiving_requests;
BEGIN
 IF p_request_id IS NULL OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN('NaN','Infinity','-Infinity') OR p_expected_updated_at IS NULL THEN RAISE EXCEPTION 'Invalid reservation change'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE id=p_allocation_id;
 IF alloc.id IS NULL OR alloc.route_type<>'SE' OR alloc.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'HANDOFF_NOT_ACTIVE' USING ERRCODE='PT409'; END IF;
 scope:=app_private.lock_receiving_handoff(alloc.office_receipt_id);
 PERFORM 1 FROM public.receiving_inventory_allocations WHERE id=alloc.id FOR UPDATE;
 SELECT * INTO item FROM public.inventory_items WHERE id=alloc.inventory_item_id;
 PERFORM 1 FROM public.inventory_serials WHERE id IN(alloc.inventory_serial_id,p_serial_id) ORDER BY id FOR UPDATE;
 PERFORM app_private.assert_receiving_se_unused(alloc);
 SELECT * INTO r FROM public.se_supply_records WHERE id=alloc.se_supply_record_id;
 IF r.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'HANDOFF_VERSION_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION '請選擇有效案件'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>1 OR p_serial_id IS NULL OR (p_serial_id<>alloc.inventory_serial_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(scope->'available_serial_ids')x WHERE x::uuid=p_serial_id))
  THEN RAISE EXCEPTION 'HANDOFF_SERIAL_SCOPE_CONFLICT: 只能改為同一筆北辦收貨的序號' USING ERRCODE='PT409'; END IF;
  SELECT * INTO serial FROM public.inventory_serials WHERE id=p_serial_id;
 ELSIF p_serial_id IS NOT NULL OR p_quantity>alloc.quantity+(scope->>'available')::numeric THEN
  RAISE EXCEPTION 'HANDOFF_CAPACITY_CONFLICT' USING ERRCODE='PT409';
 END IF;
 INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),NULL,ARRAY[r.id]);
 UPDATE public.se_supply_records SET quantity=p_quantity,inventory_serial_id=p_serial_id,
  new_serial=CASE WHEN item.requires_serial THEN serial.serial_number ELSE NULL END,
  project_id=p_project_id,project_name=(SELECT project_name FROM public.projects WHERE id=p_project_id),updated_at=clock_timestamp()
 WHERE id=r.id;
 IF p_quantity<>alloc.quantity OR p_serial_id IS DISTINCT FROM alloc.inventory_serial_id THEN
  UPDATE public.receiving_inventory_allocations SET cancelled_at=clock_timestamp(),cancelled_by=actor.id,cancellation_reason='Reservation modified' WHERE id=alloc.id;
  INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,inventory_serial_id,quantity,route_type,se_supply_record_id,created_by,supersedes_allocation_id)
   VALUES(alloc.office_receipt_id,item.id,p_serial_id,p_quantity,'SE',r.id,actor.id,alloc.id) RETURNING * INTO next_alloc;
 ELSE next_alloc:=alloc; END IF;
 DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 result:=jsonb_build_object('id',next_alloc.id,'outcome','MODIFIED','allocation',to_jsonb(next_alloc),'se_record',(SELECT to_jsonb(s) FROM public.se_supply_records s WHERE id=r.id),
  'scope',app_private.receiving_handoff_scope(alloc.office_receipt_id));
 PERFORM app_private.inventory_audit('CHANGE_RECEIVING_SE_HANDOFF',jsonb_build_object('allocation',to_jsonb(alloc),'se_record',to_jsonb(r)),result,'Controlled downstream reservation edit; Arrival unchanged');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
CREATE TRIGGER receiving_handoff_history BEFORE UPDATE OR DELETE ON public.receiving_inventory_allocations
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_handoff_history();

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
 ELSIF p_type='ARRIVAL' THEN
  SELECT parent.* INTO a FROM public.receiving_arrivals parent JOIN public.receiving_arrival_lines line ON line.arrival_id=parent.id WHERE line.id=p_id FOR UPDATE OF parent;
  SELECT * INTO l FROM public.receiving_arrival_lines WHERE id=p_id FOR UPDATE;
  IF l.id IS NULL OR a.voided_at IS NOT NULL OR l.resolution_state<>'POSTED' OR NOT EXISTS(
   SELECT 1 FROM public.material_receipts receipt JOIN public.inventory_transactions tx ON tx.id=receipt.inventory_transaction_id
   WHERE receipt.id=l.receipt_id AND receipt.arrival_line_id=l.id AND receipt.source_type='ARRIVAL'
    AND receipt.event_type='RECEIVE' AND receipt.receipt_location='OFFICE' AND receipt.inventory_linked
    AND tx.transaction_type='IN' AND tx.item_id=l.inventory_item_id AND NOT tx.is_voided AND tx.excluded_by_initialization_id IS NULL)
  THEN RAISE EXCEPTION 'ARRIVAL_NOT_AVAILABLE_FOR_HANDOFF' USING ERRCODE='PT409'; END IF;
  r:=to_jsonb(l)||jsonb_build_object('project_id',a.project_id,'notes',a.notes,'receiving_archived_at',NULL,'source_type','ARRIVAL');
 ELSE RAISE EXCEPTION 'Invalid receiving source'; END IF;
 IF r IS NULL THEN RAISE EXCEPTION '找不到到貨來源'; END IF;
 RETURN r;
END $$;

-- Derived reservation capacity, never a second Inventory balance.
CREATE FUNCTION app_private.receiving_reserved_quantity(p_item_id uuid) RETURNS numeric LANGUAGE sql VOLATILE SET search_path='' AS $$
 SELECT COALESCE(sum(a.quantity),0) FROM public.receiving_inventory_allocations a
 WHERE a.inventory_item_id=p_item_id AND a.inventory_serial_id IS NULL AND a.route_type='SE' AND a.cancelled_at IS NULL
$$;

CREATE FUNCTION app_private.receiving_handoff_scope(p_receipt_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.material_receipts; l public.receiving_arrival_lines; a public.receiving_arrivals;
 item public.inventory_items; iid uuid; received numeric; se numeric; site numeric; available numeric; ids uuid[];
BEGIN
 SELECT * INTO r FROM public.material_receipts WHERE id=p_receipt_id;
 IF r.id IS NULL OR r.event_type<>'RECEIVE' OR r.receipt_location IS DISTINCT FROM 'OFFICE' OR NOT r.inventory_linked
 THEN RAISE EXCEPTION 'HANDOFF_REQUIRES_OFFICE_RECEIPT' USING ERRCODE='PT409'; END IF;
 IF r.source_type='ARRIVAL' THEN
  SELECT * INTO l FROM public.receiving_arrival_lines WHERE id=r.arrival_line_id;
  SELECT * INTO a FROM public.receiving_arrivals WHERE id=l.arrival_id;
  IF l.receipt_id IS DISTINCT FROM r.id OR l.resolution_state<>'POSTED' OR a.id IS NULL OR a.voided_at IS NOT NULL
  THEN RAISE EXCEPTION 'ARRIVAL_NOT_AVAILABLE_FOR_HANDOFF' USING ERRCODE='PT409'; END IF;
  iid:=l.inventory_item_id;
 ELSIF r.source_type='PROJECT_MATERIAL' THEN
  SELECT inventory_item_id INTO iid FROM public.project_materials WHERE id=r.project_material_id AND delivery_destination='OFFICE';
 ELSIF r.source_type='SE_SUPPLY' THEN
  SELECT inventory_item_id INTO iid FROM public.se_supply_records WHERE id=r.se_supply_record_id AND cancelled_at IS NULL;
 END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=iid;
 IF item.id IS NULL OR NOT item.is_active THEN RAISE EXCEPTION 'HANDOFF_SOURCE_INACTIVE' USING ERRCODE='PT409'; END IF;
 IF (r.source_type='ARRIVAL' AND r.inventory_transaction_id IS NULL) OR (r.inventory_transaction_id IS NOT NULL AND NOT EXISTS(
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
 AND (r.arrival_line_id IS NULL OR e.arrival_line_id=r.arrival_line_id)
 AND NOT EXISTS(SELECT 1 FROM public.receiving_inventory_allocations x WHERE x.inventory_serial_id=s.id AND x.cancelled_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.se_supply_records x WHERE x.inventory_serial_id=s.id AND x.replace_date IS NULL AND x.cancelled_at IS NULL AND NOT x.receiving_only);
 available:=LEAST(available,CASE WHEN item.requires_serial THEN cardinality(ids)::numeric
  ELSE GREATEST(0,app_private.inventory_effective_balance(item.id)-app_private.receiving_reserved_quantity(item.id)) END);
 RETURN jsonb_build_object('receipt_id',r.id,'arrival_line_id',r.arrival_line_id,'item_id',item.id,'requires_serial',item.requires_serial,
  'received',received,'se',se,'site',site,'other',GREATEST(0,received-se-site-available),'available',available,'available_serial_ids',to_jsonb(ids),
  'allocations',COALESCE((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('state',app_private.receiving_allocation_state(x)) ORDER BY x.created_at,x.id)
   FROM public.receiving_inventory_allocations x WHERE x.office_receipt_id=r.id),'[]'));
END $$;

CREATE FUNCTION public.get_receiving_handoff_scope(p_receipt_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT COALESCE(app_private.is_active_member(),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 RETURN app_private.receiving_handoff_scope(p_receipt_id);
END $$;

-- Caller holds the shared SE mutex. Source/Arrival locks precede canonical item -> transaction -> serial locks.
CREATE FUNCTION app_private.lock_receiving_handoff(p_receipt_id uuid,p_allow_archived boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.material_receipts; source jsonb; iid uuid;
BEGIN
 SELECT * INTO r FROM public.material_receipts WHERE id=p_receipt_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'HANDOFF_RECEIPT_NOT_FOUND' USING ERRCODE='PT409'; END IF;
 source:=app_private.receiving_source(r.source_type,COALESCE(r.project_material_id,r.se_supply_record_id,r.arrival_line_id));
 IF NOT p_allow_archived AND source->>'receiving_archived_at' IS NOT NULL THEN RAISE EXCEPTION 'HANDOFF_SOURCE_INACTIVE' USING ERRCODE='PT409'; END IF;
 -- Preserve every Arrival field while making a later Repeatable Read void of
 -- this parent conflict with a handoff it cannot see in its old snapshot.
 IF r.source_type='ARRIVAL' THEN
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

CREATE OR REPLACE FUNCTION public.route_receiving_inventory(p_request_id uuid,p_receipt_id uuid,p_route_type text,p_quantity numeric,p_serial_ids uuid[],p_project_id uuid,p_material_id uuid,p_create_new boolean,p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); scope jsonb; item public.inventory_items; sid uuid; downstream jsonb;
 response jsonb:='[]'; cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('RECEIPT_ROUTE',p_receipt_id,p_route_type,p_quantity,p_serial_ids,p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
BEGIN
 IF p_request_id IS NULL OR p_received_at IS NULL OR NOT isfinite(p_received_at) OR p_route_type IS NULL OR p_route_type NOT IN('SE','SITE')
 OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid route request'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 scope:=app_private.lock_receiving_handoff(p_receipt_id);
 SELECT * INTO item FROM public.inventory_items WHERE id=(scope->>'item_id')::uuid;
 IF p_quantity>(scope->>'available')::numeric THEN RAISE EXCEPTION 'HANDOFF_CAPACITY_CONFLICT: 超過本批可分配數量' USING ERRCODE='PT409'; END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION '請選擇有效案件'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_serial_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT x) FROM unnest(p_serial_ids)x)<>p_quantity
   OR (SELECT count(*) FROM jsonb_array_elements_text(scope->'available_serial_ids')x WHERE x::uuid=ANY(p_serial_ids))<>p_quantity
  THEN RAISE EXCEPTION 'HANDOFF_SERIAL_SCOPE_CONFLICT: 序號不屬於這筆北辦收貨或已有後續用途' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.inventory_serials WHERE id=ANY(p_serial_ids) ORDER BY id FOR UPDATE;
 ELSIF COALESCE(cardinality(p_serial_ids),0)<>0 THEN RAISE EXCEPTION '一般料不得選序號'; END IF;
 IF p_route_type='SE' THEN
  IF item.requires_serial THEN
   FOREACH sid IN ARRAY p_serial_ids LOOP
    downstream:=public.reserve_inventory_for_se(gen_random_uuid(),sid,p_project_id);
    INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,inventory_serial_id,quantity,route_type,se_supply_record_id,created_by)
     VALUES(p_receipt_id,item.id,sid,1,'SE',(downstream->>'id')::uuid,actor.id);
    response:=response||jsonb_build_array(downstream);
   END LOOP;
  ELSE
   INSERT INTO public.se_supply_records(project_id,project_name,new_model,inventory_item_id,quantity,unit,receive_method,procurement_status,receive_date,received_at,inventory_routed,notes)
   VALUES(p_project_id,(SELECT project_name FROM public.projects WHERE id=p_project_id),item.code,item.id,p_quantity,item.unit,'北辦倉庫','RECEIVED',(p_received_at AT TIME ZONE 'Asia/Taipei')::date,p_received_at,true,p_notes)
   RETURNING to_jsonb(se_supply_records.*) INTO downstream;
   INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,quantity,route_type,se_supply_record_id,created_by)
    VALUES(p_receipt_id,item.id,p_quantity,'SE',(downstream->>'id')::uuid,actor.id);
   response:=jsonb_build_array(downstream);
  END IF;
 ELSE
  downstream:=public.deliver_inventory_to_project(gen_random_uuid(),item.id,p_project_id,p_quantity,p_serial_ids,p_material_id,p_create_new,p_received_at,p_notes);
  IF item.requires_serial THEN
   FOREACH sid IN ARRAY p_serial_ids LOOP
    INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,inventory_serial_id,quantity,route_type,project_material_id,inventory_transaction_id,site_receipt_id,created_by)
     VALUES(p_receipt_id,item.id,sid,1,'SITE',(downstream->>'project_material_id')::uuid,(downstream->>'inventory_transaction_id')::uuid,(downstream->>'id')::uuid,actor.id);
   END LOOP;
  ELSE
   INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,quantity,route_type,project_material_id,inventory_transaction_id,site_receipt_id,created_by)
    VALUES(p_receipt_id,item.id,p_quantity,'SITE',(downstream->>'project_material_id')::uuid,(downstream->>'inventory_transaction_id')::uuid,(downstream->>'id')::uuid,actor.id);
  END IF;
  response:=jsonb_build_array(downstream);
 END IF;
 PERFORM app_private.inventory_audit('ROUTE_RECEIVING',jsonb_build_object('id',p_receipt_id),jsonb_build_object('id',p_receipt_id,'arrival_line_id',scope->'arrival_line_id','allocations',response),'One-time handoff; receiving facts retained');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,response,now());
 RETURN response;
END $$;

-- Reuse the canonical writer, adding only reservation exclusion around its result.
CREATE OR REPLACE FUNCTION public.write_inventory_transaction_atomic(p_action text,p_data jsonb DEFAULT '{}',p_serials jsonb DEFAULT '[]',p_transaction_id uuid DEFAULT NULL,p_reason text DEFAULT NULL,p_expected_updated_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; old_item uuid; new_item uuid; iid uuid;
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 IF p_action<>'CREATE' AND EXISTS(SELECT 1 FROM public.material_receipts r WHERE r.inventory_transaction_id=p_transaction_id
  AND NOT EXISTS(SELECT 1 FROM app_private.inventory_routing_context c WHERE c.backend=pg_backend_pid() AND c.transaction_id=txid_current() AND c.receipt_id=COALESCE(r.reversal_of_id,r.id)))
 THEN RAISE EXCEPTION '此庫存異動已關聯收貨，請從收貨更正'; END IF;
 SELECT item_id INTO old_item FROM public.inventory_transactions WHERE id=p_transaction_id;
 new_item:=COALESCE((p_data->>'item_id')::uuid,old_item);
 PERFORM 1 FROM public.inventory_items WHERE id IN(old_item,new_item) ORDER BY id FOR UPDATE;
 result:=app_private.write_inventory_transaction_before_routing(p_action,p_data,p_serials,p_transaction_id,p_reason,p_expected_updated_at);
 FOR iid IN SELECT id FROM public.inventory_items WHERE id IN(old_item,new_item) AND NOT requires_serial ORDER BY id LOOP
  IF app_private.inventory_effective_balance(iid)<app_private.receiving_reserved_quantity(iid)
  THEN RAISE EXCEPTION 'HANDOFF_RESERVED_QUANTITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 END LOOP;
 UPDATE public.inventory_items SET updated_at=clock_timestamp() WHERE id IN(old_item,new_item);
 RETURN result;
END $$;

-- Existing SE entry points delegate linked reservations to the same controlled
-- contract; unlinked legacy reservations retain their accepted implementation.
ALTER FUNCTION public.change_se_inventory_reservation(uuid,uuid,timestamptz) SET SCHEMA app_private;
ALTER FUNCTION app_private.change_se_inventory_reservation(uuid,uuid,timestamptz) RENAME TO change_se_before_handoff;
ALTER FUNCTION public.cancel_se_inventory_reservation(uuid,timestamptz) SET SCHEMA app_private;
ALTER FUNCTION app_private.cancel_se_inventory_reservation(uuid,timestamptz) RENAME TO cancel_se_before_handoff;
ALTER FUNCTION public.change_receiving_se_project(uuid,uuid,timestamptz) SET SCHEMA app_private;
ALTER FUNCTION app_private.change_receiving_se_project(uuid,uuid,timestamptz) RENAME TO change_se_project_before_handoff;

CREATE FUNCTION public.change_se_inventory_reservation(p_record_id uuid,p_serial_id uuid,p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE alloc public.receiving_inventory_allocations; r public.se_supply_records; result jsonb;
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE se_supply_record_id=p_record_id AND cancelled_at IS NULL;
 IF alloc.id IS NULL THEN RETURN app_private.change_se_before_handoff(p_record_id,p_serial_id,p_expected_updated_at); END IF;
 SELECT * INTO r FROM public.se_supply_records WHERE id=p_record_id;
 result:=public.change_receiving_se_handoff(gen_random_uuid(),alloc.id,alloc.quantity,p_serial_id,r.project_id,p_expected_updated_at);
 RETURN result->'se_record';
END $$;
CREATE FUNCTION public.cancel_se_inventory_reservation(p_record_id uuid,p_expected_updated_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE alloc public.receiving_inventory_allocations; r public.se_supply_records;
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE se_supply_record_id=p_record_id AND cancelled_at IS NULL;
 IF alloc.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations WHERE se_supply_record_id=p_record_id)
   AND EXISTS(SELECT 1 FROM public.se_supply_records WHERE id=p_record_id AND cancelled_at IS NOT NULL) THEN RETURN; END IF;
  PERFORM app_private.cancel_se_before_handoff(p_record_id,p_expected_updated_at); RETURN;
 END IF;
 SELECT * INTO r FROM public.se_supply_records WHERE id=p_record_id;
 IF p_expected_updated_at IS NULL OR r.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'HANDOFF_VERSION_CONFLICT' USING ERRCODE='PT409'; END IF;
 PERFORM public.retract_receiving_handoff(gen_random_uuid(),alloc.id,'取消尚未使用的 SE 庫存預留',clock_timestamp());
END $$;
CREATE FUNCTION public.change_receiving_se_project(p_record_id uuid,p_project_id uuid,p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE alloc public.receiving_inventory_allocations; result jsonb;
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE se_supply_record_id=p_record_id AND cancelled_at IS NULL;
 IF alloc.id IS NULL THEN RETURN app_private.change_se_project_before_handoff(p_record_id,p_project_id,p_expected_updated_at); END IF;
 result:=public.change_receiving_se_handoff(gen_random_uuid(),alloc.id,alloc.quantity,alloc.inventory_serial_id,p_project_id,p_expected_updated_at);
 RETURN result->'se_record';
END $$;

ALTER FUNCTION public.get_receiving_source_details(text,uuid) SET SCHEMA app_private;
ALTER FUNCTION app_private.get_receiving_source_details(text,uuid) RENAME TO source_details_before_handoff;
CREATE FUNCTION public.get_receiving_source_details(p_source_type text,p_source_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rid uuid; scope jsonb;
BEGIN
 IF NOT COALESCE(app_private.is_active_member(),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF p_source_type IS DISTINCT FROM 'ARRIVAL' THEN RETURN app_private.source_details_before_handoff(p_source_type,p_source_id); END IF;
 SELECT receipt_id INTO rid FROM public.receiving_arrival_lines WHERE id=p_source_id;
 scope:=app_private.receiving_handoff_scope(rid);
 RETURN jsonb_build_object('scope',scope,
  'inventoryItem',(SELECT to_jsonb(i) FROM public.inventory_items i WHERE id=(scope->>'item_id')::uuid),
  'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM public.material_receipts r WHERE id=rid OR reversal_of_id=rid),
  'entries',(SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]') FROM public.receiving_serial_entries e WHERE arrival_line_id=p_source_id),
  'links',(SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') FROM public.material_receipt_serials x WHERE receipt_id=rid),
  'allocations',scope->'allocations',
  'serials',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM public.inventory_serials s WHERE id IN(SELECT inventory_serial_id FROM public.receiving_serial_entries WHERE arrival_line_id=p_source_id)),
  'seRecords',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM public.se_supply_records s WHERE id IN(SELECT se_supply_record_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=rid)),
  'materials',(SELECT COALESCE(jsonb_agg(to_jsonb(m)),'[]') FROM public.project_materials m WHERE id IN(SELECT project_material_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=rid)),
  'siteReceipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM public.material_receipts r WHERE id IN(SELECT site_receipt_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=rid)));
END $$;

-- The V5 Arrival correction lifecycle is not implicitly reinterpreted by adding
-- ARRIVAL to the source resolver. Pending cancellation remains V5-A.1's contract.
ALTER FUNCTION public.cancel_receiving_arrival(uuid,text,uuid,text,boolean) SET SCHEMA app_private;
ALTER FUNCTION app_private.cancel_receiving_arrival(uuid,text,uuid,text,boolean) RENAME TO cancel_arrival_before_handoff;
CREATE FUNCTION public.cancel_receiving_arrival(p_request_id uuid,p_source_type text,p_source_id uuid,p_notes text,p_hide_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('CANCEL_ARRIVAL',p_source_type,p_source_id,p_notes,p_hide_only);
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 IF p_source_type='ARRIVAL' OR (NOT p_hide_only AND EXISTS(SELECT 1 FROM public.receiving_inventory_allocations a JOIN public.material_receipts r ON r.id=a.office_receipt_id
  WHERE a.cancelled_at IS NULL AND ((p_source_type='PROJECT_MATERIAL' AND r.project_material_id=p_source_id) OR (p_source_type='SE_SUPPLY' AND r.se_supply_record_id=p_source_id)))
 ) THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED: 已轉 SE 供貨或送至案場，實際到貨不可當待收取消' USING ERRCODE='PT409'; END IF;
 RETURN app_private.cancel_arrival_before_handoff(p_request_id,p_source_type,p_source_id,p_notes,p_hide_only);
END $$;
CREATE FUNCTION app_private.guard_arrival_handoff_void() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.voided_at IS DISTINCT FROM OLD.voided_at AND EXISTS(SELECT 1 FROM public.receiving_arrival_lines l
  JOIN public.receiving_inventory_allocations a ON a.office_receipt_id=l.receipt_id WHERE l.arrival_id=OLD.id AND a.cancelled_at IS NULL)
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receiving_arrival_handoff_void BEFORE UPDATE ON public.receiving_arrivals FOR EACH ROW EXECUTE FUNCTION app_private.guard_arrival_handoff_void();

ALTER FUNCTION public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) SET SCHEMA app_private;
ALTER FUNCTION app_private.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) RENAME TO correct_receiving_before_handoff;
CREATE FUNCTION public.correct_receiving_inventory(p_request_id uuid,p_receipt_id uuid,p_quantity numeric,p_entry_ids uuid[],p_reversed_at timestamptz,p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('CORRECT',p_receipt_id,p_quantity,p_entry_ids,p_reversed_at,p_notes);
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF; RETURN cached.response; END IF;
 IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations WHERE office_receipt_id=p_receipt_id AND cancelled_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.material_receipts WHERE id=p_receipt_id AND source_type='ARRIVAL')
 THEN RAISE EXCEPTION 'DOWNSTREAM_CORRECTION_REQUIRED: 已有後續預留或分配，或屬於實際到貨紀錄' USING ERRCODE='PT409'; END IF;
 RETURN app_private.correct_receiving_before_handoff(p_request_id,p_receipt_id,p_quantity,p_entry_ids,p_reversed_at,p_notes);
END $$;

-- Put the existing SE mutex before Maintenance's task/item/transaction/serial
-- locks as well, so retract-vs-use cannot invert task/SE lock acquisition.
CREATE OR REPLACE FUNCTION public.register_maintenance_equipment_replacement(p_request_id uuid,p_schedule_task_id uuid,p_inventory_serial_id uuid,p_se_supply_record_id uuid,p_replaced_at timestamptz,p_notes text DEFAULT NULL,p_version text DEFAULT NULL,p_confirm_cross_project boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),NULL,ARRAY[p_se_supply_record_id]);
 result:=app_private.register_equipment_before_routing(p_request_id,p_schedule_task_id,p_inventory_serial_id,p_se_supply_record_id,p_replaced_at,p_notes,p_version,p_confirm_cross_project);
 DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION app_private.guard_handoff_shape(),app_private.receiving_allocation_state(public.receiving_inventory_allocations),
 app_private.correct_receiving_before_handoff(uuid,uuid,numeric,uuid[],timestamptz,text),
 app_private.guard_handoff_history(),app_private.receiving_source(text,uuid),app_private.receiving_reserved_quantity(uuid),
 app_private.receiving_handoff_scope(uuid),app_private.lock_receiving_handoff(uuid,boolean),app_private.sync_receiving_se_allocation(),
 app_private.assert_receiving_se_unused(public.receiving_inventory_allocations),app_private.guard_arrival_handoff_void(),
 app_private.change_se_before_handoff(uuid,uuid,timestamptz),app_private.cancel_se_before_handoff(uuid,timestamptz),
 app_private.change_se_project_before_handoff(uuid,uuid,timestamptz),app_private.source_details_before_handoff(text,uuid),
 app_private.cancel_arrival_before_handoff(uuid,text,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_receiving_handoff_scope(uuid),public.retract_receiving_handoff(uuid,uuid,text,timestamptz),
 public.change_receiving_se_handoff(uuid,uuid,numeric,uuid,uuid,timestamptz),public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text),
 public.change_se_inventory_reservation(uuid,uuid,timestamptz),public.cancel_se_inventory_reservation(uuid,timestamptz),
 public.change_receiving_se_project(uuid,uuid,timestamptz),public.get_receiving_source_details(text,uuid),
 public.cancel_receiving_arrival(uuid,text,uuid,text,boolean),public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_receiving_handoff_scope(uuid),public.retract_receiving_handoff(uuid,uuid,text,timestamptz),
 public.change_receiving_se_handoff(uuid,uuid,numeric,uuid,uuid,timestamptz),public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text),
 public.change_se_inventory_reservation(uuid,uuid,timestamptz),public.cancel_se_inventory_reservation(uuid,timestamptz),
 public.change_receiving_se_project(uuid,uuid,timestamptz),public.get_receiving_source_details(text,uuid),
 public.cancel_receiving_arrival(uuid,text,uuid,text,boolean),public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) TO authenticated;
NOTIFY pgrst,'reload schema';
