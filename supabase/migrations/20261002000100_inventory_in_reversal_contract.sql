-- Append-only receipt correction. Existing ledger rows and CLOSED snapshots are untouched.
BEGIN;
ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT inventory_transactions_transaction_type_check;
ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_transaction_type_check
  CHECK (transaction_type IN ('IN','OUT','RETURN','ADJUST','IN_REVERSAL'));
ALTER TABLE public.inventory_transactions
  ADD COLUMN reverses_transaction_id uuid REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN reenters_reversal_id uuid REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT;
ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_reversal_link_shape CHECK (
    (transaction_type='IN_REVERSAL') = (reverses_transaction_id IS NOT NULL)
    AND (reenters_reversal_id IS NULL OR transaction_type='IN')
    AND NOT (reverses_transaction_id IS NOT NULL AND reenters_reversal_id IS NOT NULL));
CREATE INDEX inventory_reverses_transaction_idx ON public.inventory_transactions(reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX inventory_reenters_reversal_idx ON public.inventory_transactions(reenters_reversal_id)
  WHERE reenters_reversal_id IS NOT NULL;
ALTER TABLE public.inventory_monthly_closing_items
  ADD COLUMN monthly_in_reversal numeric NOT NULL DEFAULT 0;
ALTER TABLE public.material_receipts
  ADD COLUMN reentry_of_reversal_id uuid REFERENCES public.material_receipts(id) ON DELETE RESTRICT;
ALTER TABLE public.material_receipts
  ADD CONSTRAINT material_receipts_reentry_shape CHECK (
   reentry_of_reversal_id IS NULL OR (event_type='RECEIVE' AND inventory_linked
    AND inventory_transaction_id IS NOT NULL));
-- Keep the first posted Arrival unique; a later re-IN is another RECEIVE event.
DROP INDEX public.receiving_arrival_first_receipt;
CREATE UNIQUE INDEX receiving_arrival_first_receipt ON public.material_receipts(arrival_line_id)
 WHERE event_type='RECEIVE' AND arrival_line_id IS NOT NULL AND reentry_of_reversal_id IS NULL;
CREATE INDEX material_receipts_reentry_of_reversal_idx ON public.material_receipts(reentry_of_reversal_id)
 WHERE reentry_of_reversal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.inventory_effective_balance(p_item_id uuid)
RETURNS numeric LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
 SELECT i.opening_quantity+COALESCE((
  SELECT sum(CASE t.transaction_type WHEN 'IN' THEN t.quantity WHEN 'RETURN' THEN t.quantity
   WHEN 'OUT' THEN -t.quantity WHEN 'IN_REVERSAL' THEN -t.quantity
   WHEN 'ADJUST' THEN t.quantity ELSE 0 END)
  FROM public.inventory_transactions t WHERE t.item_id=i.id
   AND t.is_voided IS NOT TRUE AND t.excluded_by_initialization_id IS NULL),0)
 FROM public.inventory_items i WHERE i.id=p_item_id
$$;
REVOKE ALL ON FUNCTION app_private.inventory_effective_balance(uuid) FROM PUBLIC,anon,authenticated;

-- The trigger also protects writes made by privileged maintenance code.
CREATE FUNCTION app_private.guard_inventory_reversal_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.inventory_transactions; already numeric;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN
  IF OLD.transaction_type='IN_REVERSAL' OR OLD.reenters_reversal_id IS NOT NULL
   OR (OLD.transaction_type='IN' AND EXISTS(
    SELECT 1 FROM public.inventory_transactions r WHERE r.reverses_transaction_id=OLD.id))
  THEN RAISE EXCEPTION 'APPEND_ONLY_IN_REVERSAL' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 END IF;
 IF NEW.transaction_type='IN_REVERSAL' THEN
  SELECT * INTO target FROM public.inventory_transactions WHERE id=NEW.reverses_transaction_id FOR UPDATE;
  IF target.id IS NULL OR target.transaction_type<>'IN' OR target.item_id IS DISTINCT FROM NEW.item_id
   OR target.is_voided OR target.excluded_by_initialization_id IS NOT NULL
   OR NEW.project_id IS NOT NULL OR NEW.quantity IS NULL OR NEW.quantity<=0 OR NEW.quantity::text IN ('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'INVALID_IN_REVERSAL_ORIGIN' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(quantity),0) INTO already FROM public.inventory_transactions
   WHERE reverses_transaction_id=target.id AND NOT is_voided AND excluded_by_initialization_id IS NULL;
  IF already+NEW.quantity>target.quantity THEN
   RAISE EXCEPTION 'IN_REVERSAL_EXCEEDS_ORIGIN' USING ERRCODE='23514'; END IF;
 ELSIF NEW.reenters_reversal_id IS NOT NULL THEN
  SELECT * INTO target FROM public.inventory_transactions WHERE id=NEW.reenters_reversal_id FOR UPDATE;
  IF target.id IS NULL OR target.transaction_type<>'IN_REVERSAL' OR target.item_id IS DISTINCT FROM NEW.item_id
   OR target.is_voided OR target.excluded_by_initialization_id IS NOT NULL
   OR NEW.quantity IS NULL OR NEW.quantity<=0 OR NEW.quantity::text IN ('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'INVALID_IN_REENTRY_ORIGIN' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(quantity),0) INTO already FROM public.inventory_transactions
   WHERE reenters_reversal_id=target.id AND NOT is_voided AND excluded_by_initialization_id IS NULL;
  IF already+NEW.quantity>target.quantity THEN
   RAISE EXCEPTION 'IN_REENTRY_EXCEEDS_REVERSAL' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_inventory_reversal_contract() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inventory_reversal_contract_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_transactions
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_inventory_reversal_contract();

-- A private, transaction-local capability lets the Receiving RPC write a linked receipt.
CREATE TABLE app_private.inventory_reversal_context (
 backend integer NOT NULL, transaction_id bigint NOT NULL, receipt_id uuid NOT NULL,
 PRIMARY KEY(backend,transaction_id));
ALTER TABLE app_private.inventory_reversal_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.inventory_reversal_context FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.guard_receipt_inventory_reentry()
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
  OR NEW.receipt_location IS DISTINCT FROM 'OFFICE'
  OR entry_tx.id IS NULL OR entry_tx.transaction_type<>'IN'
  OR entry_tx.reenters_reversal_id IS DISTINCT FROM source_receipt.inventory_transaction_id
  OR entry_tx.quantity IS DISTINCT FROM NEW.quantity_received
 THEN RAISE EXCEPTION 'INVALID_RECEIPT_IN_REENTRY' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_receipt_inventory_reentry() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receipt_inventory_reentry_guard BEFORE INSERT OR UPDATE ON public.material_receipts
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_receipt_inventory_reentry();

CREATE FUNCTION app_private.receiving_arrival_anchor_receipt(p_receipt_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path='' AS $$
 WITH RECURSIVE chain AS (
  SELECT r.id,r.reentry_of_reversal_id,0 AS depth FROM public.material_receipts r WHERE r.id=p_receipt_id
  UNION ALL
  SELECT parent.id,parent.reentry_of_reversal_id,child.depth+1
  FROM chain child JOIN public.material_receipts reversal ON reversal.id=child.reentry_of_reversal_id
   JOIN public.material_receipts parent ON parent.id=reversal.reversal_of_id
  WHERE child.depth<32)
 SELECT id FROM chain WHERE reentry_of_reversal_id IS NULL ORDER BY depth DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_private.receiving_arrival_anchor_receipt(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.write_inventory_in_reversal(
 p_action text,p_data jsonb,p_serials jsonb,p_transaction_id uuid,p_reason text,
 p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); origin public.inventory_transactions;
 item public.inventory_items; new_tx public.inventory_transactions; serial public.inventory_serials;
 serial_ids uuid[]:='{}'; names text[]:='{}'; name text; sid uuid;
 qty numeric; already numeric; receipt_id uuid; new_batch uuid;
BEGIN
 IF p_action NOT IN ('REVERSE_IN','REENTER_IN') OR p_transaction_id IS NULL
  OR NULLIF(btrim(p_reason),'') IS NULL OR jsonb_typeof(p_serials) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'INVALID_IN_REVERSAL_REQUEST' USING ERRCODE='22023'; END IF;
 qty:=(p_data->>'quantity')::numeric;
 IF qty IS NULL OR qty<=0 OR qty::text IN ('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'POSITIVE_REVERSAL_QUANTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 SELECT item_id INTO item.id FROM public.inventory_transactions WHERE id=p_transaction_id;
 IF item.id IS NULL THEN RAISE EXCEPTION 'ORIGIN_TRANSACTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=item.id FOR UPDATE;
 SELECT * INTO origin FROM public.inventory_transactions WHERE id=p_transaction_id FOR UPDATE;
 IF p_expected_updated_at IS NOT NULL AND origin.updated_at IS DISTINCT FROM p_expected_updated_at
 THEN RAISE EXCEPTION 'STALE_INVENTORY_ORIGIN' USING ERRCODE='40001'; END IF;
 IF NOT item.is_active OR origin.is_voided OR origin.excluded_by_initialization_id IS NOT NULL
 THEN RAISE EXCEPTION 'INACTIVE_INVENTORY_ORIGIN' USING ERRCODE='23514'; END IF;
 IF (p_action='REVERSE_IN' AND origin.transaction_type<>'IN')
  OR (p_action='REENTER_IN' AND origin.transaction_type<>'IN_REVERSAL')
  OR NULLIF(p_data->>'item_id','')::uuid IS DISTINCT FROM item.id
  OR NULLIF(p_data->>'project_id','') IS NOT NULL
 THEN RAISE EXCEPTION 'INVENTORY_ORIGIN_MISMATCH' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.material_receipts r WHERE r.inventory_transaction_id=origin.id) THEN
  SELECT r.id INTO receipt_id FROM public.material_receipts r WHERE r.inventory_transaction_id=origin.id LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM app_private.inventory_reversal_context c
   WHERE c.backend=pg_backend_pid() AND c.transaction_id=txid_current() AND c.receipt_id=receipt_id)
  THEN RAISE EXCEPTION 'RECEIVING_REVERSAL_OR_REENTRY_RPC_REQUIRED' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_action='REVERSE_IN' THEN
  SELECT COALESCE(sum(quantity),0) INTO already FROM public.inventory_transactions
   WHERE reverses_transaction_id=origin.id AND NOT is_voided AND excluded_by_initialization_id IS NULL;
 ELSE
  SELECT COALESCE(sum(quantity),0) INTO already FROM public.inventory_transactions
   WHERE reenters_reversal_id=origin.id AND NOT is_voided AND excluded_by_initialization_id IS NULL;
 END IF;
 IF already+qty>origin.quantity THEN RAISE EXCEPTION 'REVERSAL_QUANTITY_EXCEEDED' USING ERRCODE='23514'; END IF;
 IF (p_data->>'transaction_date')::date IS NULL OR (p_data->>'transaction_date')::date<origin.transaction_date
 THEN RAISE EXCEPTION 'INVALID_REVERSAL_DATE' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(array_agg(public.normalize_inventory_serial(value) ORDER BY public.normalize_inventory_serial(value)),'{}')
 INTO names FROM jsonb_array_elements_text(p_serials);
 IF EXISTS(SELECT 1 FROM unnest(names) x WHERE x IS NULL OR x='' OR public.classify_inventory_serial_format(x)='unknown')
  OR (SELECT count(DISTINCT x) FROM unnest(names)x)<>cardinality(names)
 THEN RAISE EXCEPTION 'INVALID_REVERSAL_SERIALS' USING ERRCODE='23514'; END IF;
 IF item.requires_serial THEN
  IF qty<>trunc(qty) OR cardinality(names)<>qty
  THEN RAISE EXCEPTION 'REVERSAL_SERIAL_COUNT_MISMATCH' USING ERRCODE='23514'; END IF;
  -- Item -> origin -> sorted serials is the canonical writer order.
  PERFORM 1 FROM public.inventory_serials s WHERE s.normalized_full=ANY(names) ORDER BY s.id FOR UPDATE;
  FOREACH name IN ARRAY names LOOP
   SELECT * INTO serial FROM public.inventory_serials s WHERE s.normalized_full=name;
   IF serial.id IS NULL OR serial.item_id<>item.id
    OR (p_action='REVERSE_IN' AND serial.status<>'在庫')
    OR (p_action='REENTER_IN' AND serial.status<>'待入庫')
    OR NOT EXISTS(SELECT 1 FROM public.inventory_transaction_serials l
     WHERE l.transaction_id=origin.id AND l.serial_id=serial.id AND NOT l.is_pending)
    OR EXISTS(SELECT 1 FROM public.inventory_transaction_serials l
     JOIN public.inventory_transactions t ON t.id=l.transaction_id
     WHERE l.serial_id=serial.id AND l.transaction_id<>origin.id
      AND l.created_at>=(SELECT min(created_at) FROM public.inventory_transaction_serials
       WHERE transaction_id=origin.id AND serial_id=serial.id)
      AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL)
   THEN RAISE EXCEPTION 'SERIAL_HAS_LATER_OR_INCOMPATIBLE_HISTORY' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations a WHERE a.inventory_serial_id=serial.id AND a.cancelled_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.se_supply_records s WHERE s.inventory_serial_id=serial.id AND s.replace_date IS NULL
      AND s.cancelled_at IS NULL AND NOT s.receiving_only)
   THEN RAISE EXCEPTION 'SERIAL_HAS_DOWNSTREAM_OWNERSHIP' USING ERRCODE='23514'; END IF;
   serial_ids:=array_append(serial_ids,serial.id);
  END LOOP;
 ELSE
  IF cardinality(names)<>0 THEN RAISE EXCEPTION 'NON_SERIAL_ITEM_HAS_SERIALS' USING ERRCODE='23514'; END IF;
  IF p_action='REVERSE_IN' AND EXISTS(SELECT 1 FROM public.inventory_transactions t
   WHERE t.item_id=item.id AND t.id<>origin.id AND t.created_at>=origin.created_at
    AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL
    AND (t.transaction_type='OUT' OR (t.transaction_type='IN_REVERSAL'
     AND t.reverses_transaction_id IS DISTINCT FROM origin.id) OR
      (t.transaction_type='ADJUST' AND t.quantity<0)))
  THEN RAISE EXCEPTION 'AMBIGUOUS_NON_SERIAL_PROVENANCE' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_action='REVERSE_IN' AND app_private.inventory_effective_balance(item.id)-qty<app_private.receiving_reserved_quantity(item.id)
 THEN RAISE EXCEPTION 'INSUFFICIENT_UNRESERVED_INVENTORY' USING ERRCODE='23514'; END IF;
 INSERT INTO public.inventory_transactions(item_id,transaction_type,transaction_date,quantity,unit,
  source,handler,notes,reverses_transaction_id,reenters_reversal_id)
 VALUES(item.id,CASE p_action WHEN 'REVERSE_IN' THEN 'IN_REVERSAL' ELSE 'IN' END,
  (p_data->>'transaction_date')::date,qty,item.unit,
  CASE p_action WHEN 'REVERSE_IN' THEN
   CASE WHEN receipt_id IS NULL THEN 'IN_REVERSAL' ELSE 'RECEIVING_IN_REVERSAL' END
   ELSE CASE WHEN receipt_id IS NULL THEN 'IN_REENTRY' ELSE 'RECEIVING_REENTRY' END END,
  actor.name,p_reason,
  CASE WHEN p_action='REVERSE_IN' THEN origin.id ELSE NULL END,
  CASE WHEN p_action='REENTER_IN' THEN origin.id ELSE NULL END)
 RETURNING * INTO new_tx;
 SELECT id INTO new_batch FROM public.inventory_batches WHERE source_transaction_id=new_tx.id;
 FOREACH sid IN ARRAY serial_ids LOOP
  INSERT INTO public.inventory_transaction_serials(transaction_id,serial_id,serial_no,is_pending)
   SELECT new_tx.id,s.id,s.serial_number,false FROM public.inventory_serials s WHERE s.id=sid;
  UPDATE public.inventory_serials SET status=CASE p_action WHEN 'REVERSE_IN' THEN '待入庫' ELSE '在庫' END,
   project_id=NULL,batch_id=CASE WHEN p_action='REVERSE_IN' THEN NULL ELSE new_batch END,
   updated_at=clock_timestamp() WHERE id=sid;
 END LOOP;
 PERFORM app_private.inventory_audit(p_action,to_jsonb(origin),to_jsonb(new_tx),p_reason);
 UPDATE public.inventory_items SET updated_at=clock_timestamp() WHERE id=item.id;
 RETURN to_jsonb(new_tx);
END $$;
REVOKE ALL ON FUNCTION app_private.write_inventory_in_reversal(text,jsonb,jsonb,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;

-- Keep the released writer untouched for IN/OUT/RETURN/ADJUST.
ALTER FUNCTION public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) SET SCHEMA app_private;
ALTER FUNCTION app_private.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz)
 RENAME TO write_inventory_before_in_reversal;
REVOKE ALL ON FUNCTION app_private.write_inventory_before_in_reversal(text,jsonb,jsonb,uuid,text,timestamptz)
 FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.write_inventory_transaction_atomic(
 p_action text,p_data jsonb DEFAULT '{}',p_serials jsonb DEFAULT '[]',p_transaction_id uuid DEFAULT NULL,
 p_reason text DEFAULT NULL,p_expected_updated_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_action IN ('REVERSE_IN','REENTER_IN') THEN
  PERFORM app_private.inventory_actor();
  LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
  RETURN app_private.write_inventory_in_reversal(p_action,p_data,p_serials,p_transaction_id,p_reason,p_expected_updated_at);
 END IF;
 IF p_action IN ('EDIT','VOID') AND EXISTS(SELECT 1 FROM public.inventory_transactions t
  WHERE t.id=p_transaction_id AND (t.transaction_type='IN_REVERSAL'
   OR t.reenters_reversal_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.inventory_transactions r WHERE r.reverses_transaction_id=t.id)))
 THEN RAISE EXCEPTION 'APPEND_ONLY_IN_REVERSAL' USING ERRCODE='23514'; END IF;
 RETURN app_private.write_inventory_before_in_reversal(p_action,p_data,p_serials,p_transaction_id,p_reason,p_expected_updated_at);
END $$;
REVOKE ALL ON FUNCTION public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) TO authenticated;

-- One request, one database transaction: receipt event, Inventory event, serial
-- transition, staging projection and idempotency cache all commit together.
CREATE FUNCTION public.reverse_receiving_inventory_in(
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
 IF receipt.source_type='ARRIVAL' THEN
  PERFORM 1 FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
   WHERE l.id=receipt.arrival_line_id
    AND l.receipt_id=app_private.receiving_arrival_anchor_receipt(receipt.id)
    AND l.resolution_state='POSTED' AND a.voided_at IS NULL FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'ARRIVAL_RECEIPT_INACTIVE' USING ERRCODE='23514'; END IF;
  UPDATE public.receiving_arrivals SET version=version WHERE id=(
   SELECT arrival_id FROM public.receiving_arrival_lines WHERE id=receipt.arrival_line_id);
  PERFORM 1 FROM public.receiving_arrival_lines WHERE id=receipt.arrival_line_id FOR UPDATE;
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
 IF receipt.source_type='ARRIVAL' THEN
  INSERT INTO public.material_receipts(source_type,arrival_line_id,event_type,reversal_of_id,
   quantity_received,received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
  VALUES('ARRIVAL',receipt.arrival_line_id,'REVERSAL',receipt.id,p_quantity,actor.id,p_reversed_at,
   p_reason,'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO reversal;
 ELSE
  SELECT * INTO reversal FROM app_private.append_receiving_reversal(receipt.id,p_quantity,p_reversed_at,p_reason);
  UPDATE public.material_receipts SET receipt_location='OFFICE',inventory_linked=true,
   inventory_transaction_id=(tx->>'id')::uuid WHERE id=reversal.id RETURNING * INTO reversal;
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
REVOKE ALL ON FUNCTION public.reverse_receiving_inventory_in(uuid,uuid,numeric,uuid[],timestamptz,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.reverse_receiving_inventory_in(uuid,uuid,numeric,uuid[],timestamptz,text)
 TO authenticated;

CREATE FUNCTION public.reenter_receiving_inventory(
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
 IF reversed.source_type='ARRIVAL' THEN
  PERFORM 1 FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
   WHERE l.id=reversed.arrival_line_id
    AND l.receipt_id=app_private.receiving_arrival_anchor_receipt(original.id)
    AND l.resolution_state='POSTED' AND a.voided_at IS NULL FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'ARRIVAL_RECEIPT_INACTIVE' USING ERRCODE='23514'; END IF;
  UPDATE public.receiving_arrivals SET version=version WHERE id=(
   SELECT arrival_id FROM public.receiving_arrival_lines WHERE id=reversed.arrival_line_id);
  PERFORM 1 FROM public.receiving_arrival_lines WHERE id=reversed.arrival_line_id FOR UPDATE;
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
 IF reversed.source_type='ARRIVAL' THEN
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
REVOKE ALL ON FUNCTION public.reenter_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.reenter_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text)
 TO authenticated;

-- Existing SE/SITE handoff can read a second Arrival RECEIVE linked to its
-- original posted line; the first line receipt remains the historical anchor.
CREATE OR REPLACE FUNCTION app_private.receiving_handoff_scope(p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.material_receipts; l public.receiving_arrival_lines; a public.receiving_arrivals;
 item public.inventory_items; iid uuid; received numeric; se numeric; site numeric; available numeric; ids uuid[];
BEGIN
 SELECT * INTO r FROM public.material_receipts WHERE id=p_receipt_id;
 IF r.id IS NULL OR r.event_type<>'RECEIVE' OR r.receipt_location IS DISTINCT FROM 'OFFICE' OR NOT r.inventory_linked
 THEN RAISE EXCEPTION 'HANDOFF_REQUIRES_OFFICE_RECEIPT' USING ERRCODE='PT409'; END IF;
 IF r.source_type='ARRIVAL' THEN
  SELECT * INTO l FROM public.receiving_arrival_lines WHERE id=r.arrival_line_id;
  SELECT * INTO a FROM public.receiving_arrivals WHERE id=l.arrival_id;
  IF l.receipt_id IS DISTINCT FROM app_private.receiving_arrival_anchor_receipt(r.id)
   OR l.resolution_state<>'POSTED' OR a.id IS NULL OR a.voided_at IS NOT NULL
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

-- Staging is a projection of the same ledger and receipt events, never another balance.
CREATE VIEW public.receiving_in_reversal_staging WITH (security_invoker=true) AS
 SELECT r.id AS reversal_receipt_id,r.reversal_of_id AS original_receipt_id,
  r.arrival_line_id,r.project_material_id,r.se_supply_record_id,
  t.item_id,t.id AS reversal_transaction_id,
  t.quantity-COALESCE((SELECT sum(i.quantity) FROM public.inventory_transactions i
   WHERE i.reenters_reversal_id=t.id AND NOT i.is_voided
    AND i.excluded_by_initialization_id IS NULL),0) AS staged_quantity
 FROM public.material_receipts r JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id
 WHERE r.event_type='REVERSAL' AND t.transaction_type='IN_REVERSAL'
  AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL;
REVOKE ALL ON public.receiving_in_reversal_staging FROM PUBLIC,anon;
GRANT SELECT ON public.receiving_in_reversal_staging TO authenticated;
COMMIT;
