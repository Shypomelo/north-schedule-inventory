-- A partially canceled unknown serialized arrival retains its original physical
-- quantity as history. Resolution validates only the remaining observations.
CREATE OR REPLACE FUNCTION public.complete_receiving_arrival_line(
 p_request_id uuid,p_line_id uuid,p_item_id uuid,p_posting_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); cached app_private.receiving_requests;
 payload jsonb:=jsonb_build_array('STAGE_ARRIVAL_ITEM',p_line_id,p_item_id,p_posting_date);
 line public.receiving_arrival_lines; arrival public.receiving_arrivals; item public.inventory_items;
 serial_count integer; canceled numeric;
BEGIN
 IF p_request_id IS NULL OR p_line_id IS NULL OR p_item_id IS NULL THEN RAISE EXCEPTION 'STAGE_ITEM_REQUEST_REQUIRED'; END IF;
 IF p_posting_date IS NOT NULL THEN
  RAISE EXCEPTION 'ARRIVAL_POSTING_DATE_NOT_APPLICABLE' USING ERRCODE='PT409'; END IF;
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
 SELECT * INTO item FROM public.inventory_items WHERE id=p_item_id FOR UPDATE;
 IF line.id IS NULL OR arrival.voided_at IS NOT NULL OR line.resolution_state<>'UNRESOLVED'
  OR item.id IS NULL OR NOT item.is_active OR (line.unit IS NOT NULL AND line.unit<>item.unit)
 THEN RAISE EXCEPTION 'ARRIVAL_IDENTITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(quantity),0) INTO canceled FROM public.receiving_arrival_stage_cancellations
  WHERE arrival_line_id=line.id AND reversal_receipt_id IS NULL;
 IF canceled>=line.quantity THEN RAISE EXCEPTION 'ARRIVAL_FULLY_CANCELLED' USING ERRCODE='PT409'; END IF;
 SELECT count(*) INTO serial_count FROM public.receiving_serial_entries
  WHERE arrival_line_id=line.id AND retired_at IS NULL;
 IF item.requires_serial AND (line.quantity-canceled<>trunc(line.quantity-canceled)
   OR serial_count<>line.quantity-canceled)
  OR NOT item.requires_serial AND serial_count<>0
 THEN RAISE EXCEPTION 'ARRIVAL_SERIAL_COUNT' USING ERRCODE='PT409'; END IF;
 UPDATE public.receiving_arrival_lines SET inventory_item_id=item.id,unit=item.unit,resolution_state='STAGED',
  version=version+1,updated_at=clock_timestamp() WHERE id=line.id RETURNING * INTO line;
 UPDATE public.receiving_serial_entries SET inventory_item_id=item.id,updated_at=clock_timestamp()
  WHERE arrival_line_id=line.id AND retired_at IS NULL;
 PERFORM app_private.inventory_audit('ARRIVAL_STAGED',NULL,to_jsonb(line),'Item resolved; no Inventory mutation');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,to_jsonb(line),now());
 RETURN to_jsonb(line);
END $$;
REVOKE ALL ON FUNCTION public.complete_receiving_arrival_line(uuid,uuid,uuid,date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.complete_receiving_arrival_line(uuid,uuid,uuid,date) TO authenticated;
