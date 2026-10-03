-- Align ARRIVAL_ROUTE_POST target_id with the canonical Inventory IN transaction.
CREATE OR REPLACE FUNCTION public.post_receiving_arrival_line(
 p_request_id uuid,p_line_id uuid,p_quantity numeric,p_entry_ids uuid[],p_posting_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('ROUTE_ARRIVAL_POST',p_line_id,p_quantity,p_entry_ids,p_posting_date);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; item public.inventory_items;
 entry public.receiving_serial_entries; serial public.inventory_serials; lookup record;
 names jsonb:='[]'; tx jsonb; receipt public.material_receipts; posted numeric; net_posted numeric; selected integer;
 posting date:=COALESCE(p_posting_date,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date);
 result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_line_id IS NULL OR p_quantity IS NULL OR p_quantity<=0
  OR p_quantity::text IN ('NaN','Infinity','-Infinity') OR posting IS NULL OR NOT isfinite(posting)
 THEN RAISE EXCEPTION 'INVALID_ROUTE_ARRIVAL_POST' USING ERRCODE='22023'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict' USING ERRCODE='PT409'; END IF;
  RETURN cached.response;
 END IF;
 SELECT a.* INTO arrival FROM public.receiving_arrivals a JOIN public.receiving_arrival_lines l ON l.arrival_id=a.id
  WHERE l.id=p_line_id FOR UPDATE OF a;
 SELECT * INTO line FROM public.receiving_arrival_lines WHERE id=p_line_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state NOT IN ('STAGED','POSTED')
 THEN RAISE EXCEPTION 'ARRIVAL_NOT_STAGED' USING ERRCODE='PT409'; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=line.inventory_item_id FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active OR item.unit IS DISTINCT FROM line.unit
 THEN RAISE EXCEPTION 'ARRIVAL_ITEM_UNIT_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(quantity_received),0) INTO posted FROM public.material_receipts
  WHERE route_arrival_line_id=line.id AND source_type='ARRIVAL_ROUTE' AND event_type='RECEIVE'
   AND reentry_of_reversal_id IS NULL;
 IF posted+p_quantity>line.quantity THEN RAISE EXCEPTION 'ARRIVAL_POST_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer
   OR (SELECT count(DISTINCT x) FROM unnest(p_entry_ids)x)<>p_quantity
  THEN RAISE EXCEPTION 'ARRIVAL_POST_SERIAL_COUNT' USING ERRCODE='PT409'; END IF;
  SELECT count(*) INTO selected FROM public.receiving_serial_entries
   WHERE id=ANY(p_entry_ids) AND arrival_line_id=line.id AND retired_at IS NULL
    AND inventory_serial_id IS NULL AND active_receipt_id IS NULL;
  IF selected<>p_quantity THEN RAISE EXCEPTION 'ARRIVAL_POST_SERIAL_SCOPE' USING ERRCODE='PT409'; END IF;
  IF EXISTS(SELECT 1 FROM public.receiving_serial_entries a JOIN public.receiving_serial_entries b
   ON a.arrival_line_id=b.arrival_line_id AND a.id<>b.id
   AND public.derive_inventory_serial_short_key(a.raw_serial)=public.derive_inventory_serial_short_key(b.raw_serial)
   WHERE a.arrival_line_id=line.id AND public.classify_inventory_serial_format(a.raw_serial)='short')
  THEN RAISE EXCEPTION 'ARRIVAL_AMBIGUOUS_SERIAL' USING ERRCODE='PT409'; END IF;
  FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids)
   ORDER BY normalized_serial FOR UPDATE LOOP
   SELECT * INTO lookup FROM public.lookup_inventory_serial(entry.raw_serial,NULL,NULL);
   IF lookup.result_type IS DISTINCT FROM 'no_match'
   THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_IDENTITY_CONFLICT: %',lookup.result_type USING ERRCODE='PT409'; END IF;
   names:=names||jsonb_build_array(entry.normalized_serial);
  END LOOP;
 ELSE
  IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION 'ARRIVAL_NONSERIAL_HAS_SERIAL'; END IF;
 END IF;
 tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object(
  'item_id',item.id,'transaction_type','IN','quantity',p_quantity,'unit',item.unit,
  'transaction_date',posting,'project_id',arrival.project_id,'source','ARRIVAL_ROUTE','notes',arrival.notes),names);
 INSERT INTO public.material_receipts(source_type,route_arrival_line_id,event_type,quantity_received,
  received_by,received_at,notes,receipt_location,inventory_linked,inventory_transaction_id)
 VALUES('ARRIVAL_ROUTE',line.id,'RECEIVE',p_quantity,actor.id,clock_timestamp(),arrival.notes,
  'OFFICE',true,(tx->>'id')::uuid) RETURNING * INTO receipt;
 IF item.requires_serial THEN
  FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) ORDER BY id LOOP
   SELECT * INTO STRICT serial FROM public.inventory_serials WHERE normalized_full=entry.normalized_serial;
   INSERT INTO public.material_receipt_serials(receipt_id,entry_id,inventory_serial_id,linked_existing,inventory_snapshot)
    VALUES(receipt.id,entry.id,serial.id,false,to_jsonb(serial));
   UPDATE public.receiving_serial_entries SET inventory_serial_id=serial.id,active_receipt_id=receipt.id,
    updated_at=clock_timestamp() WHERE id=entry.id;
  END LOOP;
 END IF;
 SELECT COALESCE(sum(CASE WHEN event_type='RECEIVE' THEN quantity_received ELSE -quantity_received END),0)
 INTO net_posted FROM public.material_receipts WHERE route_arrival_line_id=line.id;
 UPDATE public.receiving_arrival_lines SET
  resolution_state=CASE WHEN net_posted=line.quantity THEN 'POSTED' ELSE 'STAGED' END,
  receipt_id=COALESCE(line.receipt_id,receipt.id),posting_date=COALESCE(line.posting_date,posting),
  version=version+1,updated_at=clock_timestamp() WHERE id=line.id RETURNING * INTO line;
 result:=jsonb_build_object('line',to_jsonb(line),'receipt',to_jsonb(receipt),
  'inventory_transaction',tx,'remaining_staged_quantity',line.quantity-net_posted);
 PERFORM app_private.inventory_audit('ARRIVAL_ROUTE_POST',NULL,
  result||jsonb_build_object('id',tx->>'id'),'Explicit Inventory Receipt');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
