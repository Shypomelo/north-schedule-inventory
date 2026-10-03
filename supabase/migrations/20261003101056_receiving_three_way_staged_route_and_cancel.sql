-- Staged physical quantity is an immutable arrival fact. Cancellation is an
-- append-only event, never a rewrite of the arrival line or Inventory ledger.
CREATE TABLE public.receiving_arrival_stage_cancellations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE,
 arrival_line_id uuid NOT NULL REFERENCES public.receiving_arrival_lines(id) ON DELETE RESTRICT,
 reversal_receipt_id uuid REFERENCES public.material_receipts(id) ON DELETE RESTRICT,
 quantity numeric NOT NULL CHECK (quantity > 0 AND quantity::text NOT IN ('NaN','Infinity','-Infinity')),
 entry_ids uuid[] NOT NULL DEFAULT '{}',
 reason text NOT NULL CHECK (btrim(reason) <> ''),
 created_by uuid NOT NULL REFERENCES public.team_members(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX receiving_stage_cancel_line ON public.receiving_arrival_stage_cancellations(arrival_line_id);
CREATE INDEX receiving_stage_cancel_reversal ON public.receiving_arrival_stage_cancellations(reversal_receipt_id)
 WHERE reversal_receipt_id IS NOT NULL;
ALTER TABLE public.receiving_arrival_stage_cancellations ENABLE ROW LEVEL SECURITY;
CREATE POLICY receiving_stage_cancel_read ON public.receiving_arrival_stage_cancellations
 FOR SELECT TO authenticated USING (COALESCE(app_private.is_active_member(),false));
REVOKE ALL ON public.receiving_arrival_stage_cancellations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.receiving_arrival_stage_cancellations TO authenticated;

-- Existing posting/re-entry functions are still the sole Inventory writers.
-- Their receipt inserts must respect canceled capacity even when called directly.
CREATE FUNCTION app_private.guard_canceled_arrival_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE canceled numeric; already numeric; physical numeric;
BEGIN
 IF NEW.source_type <> 'ARRIVAL_ROUTE' OR NEW.event_type <> 'RECEIVE' THEN RETURN NEW; END IF;
 IF NEW.reentry_of_reversal_id IS NULL THEN
  SELECT quantity INTO physical FROM public.receiving_arrival_lines WHERE id=NEW.route_arrival_line_id;
  SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
   WHERE arrival_line_id=NEW.route_arrival_line_id AND reversal_receipt_id IS NULL;
  SELECT COALESCE(sum(quantity_received),0) INTO already FROM public.material_receipts
   WHERE source_type='ARRIVAL_ROUTE' AND route_arrival_line_id=NEW.route_arrival_line_id
    AND event_type='RECEIVE' AND reentry_of_reversal_id IS NULL;
 ELSE
  SELECT quantity_received INTO physical FROM public.material_receipts WHERE id=NEW.reentry_of_reversal_id
   AND event_type='REVERSAL' AND route_arrival_line_id=NEW.route_arrival_line_id;
  SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
   WHERE reversal_receipt_id=NEW.reentry_of_reversal_id;
  SELECT COALESCE(sum(quantity_received),0) INTO already FROM public.material_receipts
   WHERE reentry_of_reversal_id=NEW.reentry_of_reversal_id AND event_type='RECEIVE';
 END IF;
 IF physical IS NULL OR already+canceled+NEW.quantity_received>physical
 THEN RAISE EXCEPTION 'ARRIVAL_CANCELLED_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canceled_arrival_receipt_capacity BEFORE INSERT ON public.material_receipts
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_canceled_arrival_receipt();
REVOKE ALL ON FUNCTION app_private.guard_canceled_arrival_receipt() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.guard_canceled_arrival_match() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE physical numeric; canceled numeric; matched numeric;
BEGIN
 IF NEW.cancelled_at IS NOT NULL THEN RETURN NEW; END IF;
 SELECT quantity INTO physical FROM public.receiving_arrival_lines WHERE id=NEW.arrival_line_id;
 SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
  WHERE arrival_line_id=NEW.arrival_line_id;
 SELECT COALESCE(sum(quantity),0) INTO matched FROM public.receiving_arrival_matches
  WHERE arrival_line_id=NEW.arrival_line_id AND cancelled_at IS NULL AND id<>NEW.id;
 IF physical IS NULL OR matched+NEW.quantity+canceled>physical
 THEN RAISE EXCEPTION 'ARRIVAL_CANCELLED_MATCH_CAPACITY' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canceled_arrival_match_capacity BEFORE INSERT OR UPDATE OF quantity,cancelled_at
 ON public.receiving_arrival_matches FOR EACH ROW EXECUTE FUNCTION app_private.guard_canceled_arrival_match();
REVOKE ALL ON FUNCTION app_private.guard_canceled_arrival_match() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.guard_canceled_arrival_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE canceled numeric;
BEGIN
 IF OLD.resolution_state='UNRESOLVED' AND NEW.resolution_state='STAGED' THEN
  SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
   WHERE arrival_line_id=OLD.id;
  IF canceled>=OLD.quantity THEN RAISE EXCEPTION 'ARRIVAL_FULLY_CANCELLED' USING ERRCODE='PT409'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canceled_arrival_completion BEFORE UPDATE OF resolution_state
 ON public.receiving_arrival_lines FOR EACH ROW EXECUTE FUNCTION app_private.guard_canceled_arrival_completion();
REVOKE ALL ON FUNCTION app_private.guard_canceled_arrival_completion() FROM PUBLIC,anon,authenticated,service_role;

-- One client action, one Postgres transaction. A failing SE/SITE route rolls
-- back its preceding Inventory IN and receipt, including all nested audits.
CREATE FUNCTION public.route_staged_receiving(
 p_request_id uuid,p_stage_kind text,p_line_id uuid,p_reversal_receipt_id uuid,
 p_route_type text,p_quantity numeric,p_entry_ids uuid[],p_project_id uuid,
 p_material_id uuid,p_create_new boolean,p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('ROUTE_STAGED',p_stage_kind,p_line_id,p_reversal_receipt_id,
  p_route_type,p_quantity,p_entry_ids,p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
 posted jsonb; routed jsonb; v_receipt_id uuid; serial_ids uuid[]; result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_stage_kind NOT IN ('NORMAL','REENTRY') OR p_route_type NOT IN ('SE','SITE')
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
 routed:=public.route_receiving_inventory(gen_random_uuid(),v_receipt_id,p_route_type,p_quantity,serial_ids,
  p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
 result:=jsonb_build_object('receipt',posted->'receipt','route',routed,'stage_kind',p_stage_kind);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.route_staged_receiving(uuid,text,uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.route_staged_receiving(uuid,text,uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 TO authenticated;

-- Cancel only quantity which is currently staged. The original arrival,
-- receipts, reversals and match rows remain queryable as history.
CREATE FUNCTION public.cancel_receiving_physical_stage(
 p_request_id uuid,p_line_id uuid,p_reversal_receipt_id uuid,p_quantity numeric,
 p_entry_ids uuid[],p_match_reductions jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('CANCEL_PHYSICAL_STAGE',p_line_id,p_reversal_receipt_id,
  p_quantity,p_entry_ids,p_match_reductions,p_reason);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; item public.inventory_items;
 reversal public.material_receipts; match_row public.receiving_arrival_matches;
 replacement public.receiving_arrival_matches; change jsonb; seen_matches uuid[]:='{}';
 selected_count integer; serial_required boolean; posted numeric; canceled numeric;
 available numeric; matched_before numeric:=0; reduced numeric:=0; reduction numeric;
 active_entries uuid[]; kept_entries uuid[]; new_quantity numeric; cancel_id uuid;
 result jsonb; v_at timestamptz:=clock_timestamp();
BEGIN
 IF p_request_id IS NULL OR p_line_id IS NULL OR p_quantity IS NULL OR p_quantity<=0
  OR p_quantity::text IN ('NaN','Infinity','-Infinity') OR p_entry_ids IS NULL
  OR jsonb_typeof(p_match_reductions) IS DISTINCT FROM 'array'
  OR nullif(btrim(p_reason),'') IS NULL
 THEN RAISE EXCEPTION 'INVALID_PHYSICAL_CANCEL_REQUEST' USING ERRCODE='22023'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'REQUEST_PAYLOAD_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT a.* INTO arrival FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
  WHERE l.id=p_line_id FOR UPDATE OF a;
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL
 THEN RAISE EXCEPTION 'PHYSICAL_ARRIVAL_INACTIVE' USING ERRCODE='PT409'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=line.inventory_item_id;
 serial_required:=COALESCE(item.requires_serial,
  EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE arrival_line_id=line.id AND retired_at IS NULL));
 IF serial_required AND (p_quantity<>trunc(p_quantity)
   OR cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT id) FROM unnest(p_entry_ids) id)<>p_quantity)
  OR NOT serial_required AND cardinality(p_entry_ids)<>0
 THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_SERIAL_COUNT' USING ERRCODE='PT409'; END IF;

 IF p_reversal_receipt_id IS NULL THEN
  SELECT COALESCE(sum(r.quantity_received),0) INTO posted FROM public.material_receipts r
   WHERE r.source_type='ARRIVAL_ROUTE' AND r.route_arrival_line_id=line.id
    AND r.event_type='RECEIVE' AND r.reentry_of_reversal_id IS NULL;
  IF line.receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.material_receipts r
    WHERE r.id=line.receipt_id AND r.source_type='ARRIVAL' AND r.arrival_line_id=line.id AND r.event_type='RECEIVE')
  THEN SELECT quantity_received INTO posted FROM public.material_receipts WHERE id=line.receipt_id; END IF;
  SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
   WHERE arrival_line_id=line.id AND reversal_receipt_id IS NULL;
  available:=line.quantity-posted-canceled;
  IF serial_required THEN
   SELECT count(*) INTO selected_count FROM public.receiving_serial_entries e
    WHERE e.id=ANY(p_entry_ids) AND e.arrival_line_id=line.id AND e.retired_at IS NULL
     AND e.active_receipt_id IS NULL AND e.inventory_serial_id IS NULL;
  END IF;
 ELSE
  SELECT * INTO reversal FROM public.material_receipts WHERE id=p_reversal_receipt_id FOR UPDATE;
  IF reversal.id IS NULL OR reversal.source_type<>'ARRIVAL_ROUTE' OR reversal.route_arrival_line_id<>line.id
   OR reversal.event_type<>'REVERSAL' OR NOT reversal.inventory_linked
   OR reversal.inventory_transaction_id IS NULL
  THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_REVERSAL_CONFLICT' USING ERRCODE='PT409'; END IF;
  SELECT COALESCE(sum(quantity_received),0) INTO posted FROM public.material_receipts
   WHERE reentry_of_reversal_id=reversal.id AND event_type='RECEIVE';
  SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
   WHERE reversal_receipt_id=reversal.id;
  available:=reversal.quantity_received-posted-canceled;
  IF serial_required THEN
   SELECT count(*) INTO selected_count FROM public.material_receipt_serials link
    JOIN public.receiving_serial_entries e ON e.id=link.entry_id
    JOIN public.inventory_serials s ON s.id=link.inventory_serial_id
    WHERE link.receipt_id=reversal.id AND link.entry_id=ANY(p_entry_ids)
     AND e.arrival_line_id=line.id AND e.retired_at IS NULL AND e.active_receipt_id IS NULL
     AND e.inventory_serial_id=s.id AND s.status='待入庫'
     AND NOT EXISTS(SELECT 1 FROM public.receiving_inventory_allocations x
      WHERE x.inventory_serial_id=s.id AND x.cancelled_at IS NULL);
  END IF;
 END IF;
 IF available<p_quantity OR (serial_required AND selected_count<>p_quantity)
 THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_STAGED_SCOPE_CONFLICT' USING ERRCODE='PT409'; END IF;

 -- A nonserial partial cancellation needs explicit match reductions. Serial
 -- reductions are inferred from exact arrival entry identity.
 IF serial_required AND jsonb_array_length(p_match_reductions)>0
 THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_SERIAL_MATCH_IS_DERIVED' USING ERRCODE='PT409'; END IF;
 IF NOT serial_required THEN
  FOR change IN SELECT value FROM jsonb_array_elements(p_match_reductions) LOOP
   IF change->>'match_id' IS NULL OR change->>'quantity' IS NULL
   THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_MATCH_SPEC' USING ERRCODE='PT409'; END IF;
   IF (change->>'match_id')::uuid=ANY(seen_matches) OR (change->>'quantity')::numeric<=0
    OR (change->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity')
    OR NOT EXISTS(SELECT 1 FROM public.receiving_arrival_matches m WHERE m.id=(change->>'match_id')::uuid
     AND m.arrival_line_id=line.id AND m.cancelled_at IS NULL)
   THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_MATCH_SPEC' USING ERRCODE='PT409'; END IF;
   seen_matches:=array_append(seen_matches,(change->>'match_id')::uuid);
  END LOOP;
 END IF;
 FOR match_row IN SELECT * FROM public.receiving_arrival_matches
  WHERE arrival_line_id=line.id AND cancelled_at IS NULL ORDER BY id FOR UPDATE LOOP
  matched_before:=matched_before+match_row.quantity;
  IF serial_required THEN
   SELECT COALESCE(array_agg(arrival_entry_id ORDER BY arrival_entry_id),'{}') INTO active_entries
    FROM public.receiving_arrival_match_serials WHERE match_id=match_row.id AND cancelled_at IS NULL;
   IF cardinality(active_entries) IS DISTINCT FROM match_row.quantity
   THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_MATCH_IDENTITY_CONFLICT' USING ERRCODE='PT409'; END IF;
   SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO kept_entries
    FROM unnest(active_entries) id WHERE id<>ALL(p_entry_ids);
   reduction:=match_row.quantity-cardinality(kept_entries);
  ELSE
   SELECT COALESCE(sum((value->>'quantity')::numeric),0) INTO reduction
    FROM jsonb_array_elements(p_match_reductions) WHERE (value->>'match_id')::uuid=match_row.id;
   kept_entries:='{}';
  END IF;
  IF reduction>match_row.quantity THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_MATCH_EXCEEDED' USING ERRCODE='PT409'; END IF;
  reduced:=reduced+reduction;
  IF reduction=0 THEN CONTINUE; END IF;
  new_quantity:=match_row.quantity-reduction;
  UPDATE public.receiving_arrival_matches SET cancelled_at=v_at WHERE id=match_row.id;
  IF new_quantity>0 THEN
   INSERT INTO public.receiving_arrival_matches(arrival_line_id,project_material_id,se_supply_record_id,quantity,created_by)
    VALUES(line.id,match_row.project_material_id,match_row.se_supply_record_id,new_quantity,actor.id)
    RETURNING * INTO replacement;
   IF serial_required THEN
    INSERT INTO public.receiving_arrival_match_serials(match_id,arrival_entry_id,pending_entry_id)
     SELECT replacement.id,s.arrival_entry_id,s.pending_entry_id
     FROM public.receiving_arrival_match_serials s
     WHERE s.match_id=match_row.id AND s.arrival_entry_id=ANY(kept_entries);
   END IF;
  END IF;
 END LOOP;
 SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
  WHERE arrival_line_id=line.id;
 IF reduced>p_quantity OR matched_before-reduced>line.quantity-canceled-p_quantity
 THEN RAISE EXCEPTION 'PHYSICAL_CANCEL_PENDING_CONFLICT' USING ERRCODE='PT409'; END IF;

 INSERT INTO public.receiving_arrival_stage_cancellations
  (request_id,arrival_line_id,reversal_receipt_id,quantity,entry_ids,reason,created_by,created_at)
 VALUES(p_request_id,line.id,p_reversal_receipt_id,p_quantity,p_entry_ids,btrim(p_reason),actor.id,v_at)
 RETURNING id INTO cancel_id;
 IF serial_required THEN
  UPDATE public.receiving_serial_entries SET retired_at=v_at,updated_at=v_at
   WHERE id=ANY(p_entry_ids) AND arrival_line_id=line.id;
  IF p_reversal_receipt_id IS NOT NULL THEN
   UPDATE public.inventory_serials SET status='作廢',project_id=NULL,updated_at=v_at
    WHERE id IN (SELECT inventory_serial_id FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids))
     AND status='待入庫';
  END IF;
 END IF;
 UPDATE public.receiving_arrival_lines SET version=version+1,updated_at=v_at WHERE id=line.id;
 UPDATE public.receiving_arrivals SET version=version+1,updated_at=v_at WHERE id=arrival.id;
 result:=jsonb_build_object('id',cancel_id,'arrival_line_id',line.id,'reversal_receipt_id',p_reversal_receipt_id,
  'quantity',p_quantity,'entry_ids',p_entry_ids,'released_pending_quantity',reduced);
 PERFORM app_private.inventory_audit('PHYSICAL_ARRIVAL_STAGING_CANCELLED',to_jsonb(line),result,btrim(p_reason));
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.cancel_receiving_physical_stage(uuid,uuid,uuid,numeric,uuid[],jsonb,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.cancel_receiving_physical_stage(uuid,uuid,uuid,numeric,uuid[],jsonb,text)
 TO authenticated;
