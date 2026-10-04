CREATE OR REPLACE FUNCTION app_private.write_inventory_in_reversal(
 p_action text,p_data jsonb,p_serials jsonb,p_transaction_id uuid,p_reason text,
 p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); origin public.inventory_transactions;
 item public.inventory_items; new_tx public.inventory_transactions; serial public.inventory_serials;
 serial_ids uuid[]:='{}'; names text[]:='{}'; name text; sid uuid;
 qty numeric; already numeric; v_receipt_id uuid; new_batch uuid;
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
  SELECT r.id INTO v_receipt_id FROM public.material_receipts r WHERE r.inventory_transaction_id=origin.id LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM app_private.inventory_reversal_context c
   WHERE c.backend=pg_backend_pid() AND c.transaction_id=txid_current() AND c.receipt_id=v_receipt_id)
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
      -- The IN reversed by this origin is the legal parent of REENTER_IN.
      AND NOT (p_action='REENTER_IN' AND t.id=origin.reverses_transaction_id
       AND t.transaction_type='IN')
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
   CASE WHEN v_receipt_id IS NULL THEN 'IN_REVERSAL' ELSE 'RECEIVING_IN_REVERSAL' END
   ELSE CASE WHEN v_receipt_id IS NULL THEN 'IN_REENTRY' ELSE 'RECEIVING_REENTRY' END END,
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
