-- Preserve serial corrections in the existing audit, before replacing links.
CREATE OR REPLACE FUNCTION app_private.inventory_transaction_serial_snapshot(p_transaction_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'serial_id',l.serial_id,'serial_no',l.serial_no,'is_pending',l.is_pending,
   'status',s.status,'project_id',s.project_id,'batch_id',s.batch_id
 ) ORDER BY l.serial_no,l.id),'[]'::jsonb)
 FROM public.inventory_transaction_serials l LEFT JOIN public.inventory_serials s ON s.id=l.serial_id
 WHERE l.transaction_id=p_transaction_id
$$;
REVOKE ALL ON FUNCTION app_private.inventory_transaction_serial_snapshot(uuid) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.write_inventory_transaction_atomic(
  p_action text, p_data jsonb DEFAULT '{}'::jsonb, p_serials jsonb DEFAULT '[]'::jsonb,
  p_transaction_id uuid DEFAULT NULL, p_reason text DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  a public.team_members := app_private.inventory_actor();
  old_tx public.inventory_transactions; tx public.inventory_transactions;
  item public.inventory_items; s public.inventory_serials;
  old_item uuid; item_id uuid; project_id uuid; project_name text; kind text;
  qty numeric; current_balance numeric; base_balance numeric; old_delta numeric := 0;
  serial_names text[] := '{}'; serial_ids uuid[] := '{}'; old_serial_ids uuid[] := '{}';
  name text; serial_id uuid; batch_id uuid; pending integer := 0; n integer; old_json jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('CREATE','EDIT','VOID') THEN RAISE EXCEPTION 'Invalid inventory action' USING ERRCODE='22023'; END IF;
  IF p_action<>'CREATE' THEN
    SELECT t.item_id INTO old_item FROM public.inventory_transactions t WHERE t.id=p_transaction_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='P0002'; END IF;
    IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
  ELSIF p_transaction_id IS NOT NULL THEN RAISE EXCEPTION 'Unexpected transaction id' USING ERRCODE='22023'; END IF;
  item_id := CASE WHEN p_action='VOID' THEN old_item ELSE (p_data->>'item_id')::uuid END;
  IF item_id IS NULL THEN RAISE EXCEPTION 'Item required' USING ERRCODE='22023'; END IF;
  -- Universal lock order, including cross-item edits.
  PERFORM 1 FROM public.inventory_items i WHERE i.id IN (item_id,old_item) ORDER BY i.id FOR UPDATE;
  SELECT * INTO item FROM public.inventory_items i WHERE i.id=item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE='P0002'; END IF;
  IF p_action<>'CREATE' THEN
    SELECT * INTO old_tx FROM public.inventory_transactions t WHERE t.id=p_transaction_id FOR UPDATE;
    IF old_tx.item_id IS DISTINCT FROM old_item OR
      (p_expected_updated_at IS NOT NULL AND old_tx.updated_at IS DISTINCT FROM p_expected_updated_at) THEN
      RAISE EXCEPTION 'STALE_INVENTORY: transaction changed; reload' USING ERRCODE='PT409';
    END IF;
    IF old_tx.is_voided THEN RAISE EXCEPTION 'Transaction already voided' USING ERRCODE='23514'; END IF;
    IF old_tx.excluded_by_initialization_id IS NOT NULL THEN
      RAISE EXCEPTION 'Initialization history cannot be reinterpreted' USING ERRCODE='23514'; END IF;
    old_json := to_jsonb(old_tx)||jsonb_build_object('serials',app_private.inventory_transaction_serial_snapshot(old_tx.id));
    old_delta := CASE old_tx.transaction_type WHEN 'OUT' THEN -old_tx.quantity ELSE old_tx.quantity END;
    SELECT COALESCE(array_agg(l.serial_id ORDER BY l.serial_id) FILTER(WHERE l.serial_id IS NOT NULL),'{}')
      INTO old_serial_ids FROM public.inventory_transaction_serials l WHERE l.transaction_id=old_tx.id;
  END IF;
  IF p_action='VOID' THEN
    PERFORM 1 FROM public.inventory_serials x WHERE x.id=ANY(old_serial_ids) ORDER BY x.id FOR UPDATE;
    PERFORM app_private.inventory_assert_terminal(old_tx.id);
    IF app_private.inventory_effective_balance(item_id)-old_delta < 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: void would make balance negative' USING ERRCODE='23514'; END IF;
    IF old_tx.transaction_type='IN' AND NOT app_private.is_admin_member() THEN
      RAISE EXCEPTION 'Only ADMIN may void IN' USING ERRCODE='42501'; END IF;
    -- Existing IN-void trigger preserves history and validates serials.
    UPDATE public.inventory_transactions SET is_voided=true,voided_reason=p_reason,voided_by=a.name,
      voided_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=old_tx.id RETURNING * INTO tx;
    IF old_tx.transaction_type IN ('OUT','RETURN') THEN
      UPDATE public.inventory_serials SET status=CASE old_tx.transaction_type WHEN 'OUT' THEN '在庫' ELSE '已出庫' END,
        project_id=CASE old_tx.transaction_type WHEN 'RETURN' THEN old_tx.project_id ELSE NULL END,
        batch_id=CASE old_tx.transaction_type WHEN 'RETURN' THEN app_private.inventory_previous_batch(old_tx.id,inventory_serials.id) ELSE inventory_serials.batch_id END,
        updated_at=clock_timestamp() WHERE id=ANY(old_serial_ids);
    END IF;
    PERFORM app_private.inventory_audit('VOID_TRANSACTION',old_json,to_jsonb(tx)||jsonb_build_object('serials',app_private.inventory_transaction_serial_snapshot(tx.id)),p_reason);
    RETURN to_jsonb(tx);
  END IF;
  IF NOT item.is_active THEN RAISE EXCEPTION 'Item is inactive' USING ERRCODE='23514'; END IF;
  kind := p_data->>'transaction_type';
  IF kind IS NULL OR kind NOT IN ('IN','OUT','RETURN','ADJUST') THEN RAISE EXCEPTION 'Invalid transaction type' USING ERRCODE='22023'; END IF;
  project_id := NULLIF(p_data->>'project_id','')::uuid;
  IF project_id IS NOT NULL THEN
    SELECT p.project_name INTO project_name FROM public.projects p WHERE p.id=project_id AND p.deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Valid project required' USING ERRCODE='23514'; END IF;
  ELSIF kind IN ('OUT','RETURN') THEN RAISE EXCEPTION 'Valid project required' USING ERRCODE='23514'; END IF;
  current_balance := app_private.inventory_effective_balance(item_id);
  base_balance := current_balance-CASE WHEN old_item=item_id THEN old_delta ELSE 0 END;
  IF old_item IS NOT NULL AND old_item<>item_id AND app_private.inventory_effective_balance(old_item)-old_delta<0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: old item would be negative' USING ERRCODE='23514'; END IF;
  IF kind='ADJUST' THEN
    IF item.requires_serial THEN RAISE EXCEPTION 'Serial items cannot be quantity-adjusted' USING ERRCODE='23514'; END IF;
    IF (p_data->>'expected_balance')::numeric IS DISTINCT FROM current_balance THEN
      RAISE EXCEPTION 'STALE_INVENTORY: 庫存已在盤點期間發生異動，請重新載入後再確認。' USING ERRCODE='PT409'; END IF;
    qty := (p_data->>'counted_quantity')::numeric;
    IF qty IS NULL OR qty<0 OR qty::text IN ('NaN','Infinity','-Infinity') OR NULLIF(btrim(p_data->>'notes'),'') IS NULL THEN
      RAISE EXCEPTION 'Valid counted quantity and notes required' USING ERRCODE='22023'; END IF;
    qty := qty-base_balance;
    IF qty=0 THEN RAISE EXCEPTION 'No adjustment needed' USING ERRCODE='22023'; END IF;
  ELSE
    qty := (p_data->>'quantity')::numeric;
    IF qty IS NULL OR qty<=0 OR qty::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Positive quantity required' USING ERRCODE='22023'; END IF;
  END IF;
  IF base_balance+(CASE kind WHEN 'OUT' THEN -qty ELSE qty END)<0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: insufficient stock' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(p_serials) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Serial array required' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(public.normalize_inventory_serial(value)),'{}') INTO serial_names FROM jsonb_array_elements_text(p_serials);
  n:=cardinality(serial_names);
  IF EXISTS(SELECT 1 FROM unnest(serial_names) x WHERE x IS NULL OR x='' OR public.classify_inventory_serial_format(x)='unknown')
    OR (SELECT count(DISTINCT x) FROM unnest(serial_names) x)<>n THEN RAISE EXCEPTION 'Invalid or duplicate serial' USING ERRCODE='23514'; END IF;
  IF NOT item.requires_serial AND n<>0 THEN RAISE EXCEPTION 'Item does not use serials' USING ERRCODE='23514'; END IF;
  IF item.requires_serial THEN
    IF qty<>trunc(qty) OR n>qty OR (kind IN ('OUT','RETURN') AND n<>qty) THEN RAISE EXCEPTION 'Serial count must match quantity' USING ERRCODE='23514'; END IF;
    pending := CASE WHEN kind='IN' THEN qty::integer-n ELSE 0 END;
  END IF;
  SELECT COALESCE(array_agg(x.id),'{}') INTO serial_ids FROM public.inventory_serials x WHERE x.normalized_full=ANY(serial_names);
  PERFORM 1 FROM public.inventory_serials x WHERE x.id=ANY(serial_ids||old_serial_ids) ORDER BY x.id FOR UPDATE;
  IF p_action='EDIT' THEN
    PERFORM app_private.inventory_assert_terminal(old_tx.id);
    IF cardinality(old_serial_ids)>0 AND old_tx.transaction_type='IN' AND (kind<>'IN' OR item_id<>old_item) THEN
      RAISE EXCEPTION 'Registered receipt origin cannot change item/type' USING ERRCODE='23514'; END IF;
    -- Undo only inside this transaction while all relevant mutexes are held.
    IF old_tx.transaction_type IN ('OUT','RETURN') THEN
      UPDATE public.inventory_serials SET status=CASE old_tx.transaction_type WHEN 'OUT' THEN '在庫' ELSE '已出庫' END,
        project_id=CASE old_tx.transaction_type WHEN 'RETURN' THEN old_tx.project_id ELSE NULL END,
        batch_id=CASE old_tx.transaction_type WHEN 'RETURN' THEN app_private.inventory_previous_batch(old_tx.id,inventory_serials.id) ELSE inventory_serials.batch_id END,
        updated_at=clock_timestamp() WHERE id=ANY(old_serial_ids);
    END IF;
  END IF;
  serial_ids := '{}';
  FOREACH name IN ARRAY serial_names LOOP
    SELECT * INTO s FROM public.inventory_serials x WHERE x.normalized_full=name;
    IF FOUND THEN
      IF s.item_id<>item_id THEN RAISE EXCEPTION 'Serial belongs to another item' USING ERRCODE='23514'; END IF;
      IF kind='IN' THEN
        IF NOT(s.id=ANY(old_serial_ids)) OR old_tx.transaction_type IS DISTINCT FROM 'IN' OR s.status<>'在庫' THEN
          RAISE EXCEPTION 'Serial already exists or has been used' USING ERRCODE='23514'; END IF;
      ELSIF (kind='OUT' AND s.status<>'在庫') OR (kind='RETURN' AND (s.status<>'已出庫' OR s.project_id IS DISTINCT FROM project_id)) THEN
        RAISE EXCEPTION 'Serial is not available for this operation/project' USING ERRCODE='23514';
      END IF;
      serial_id:=s.id;
    ELSE
      IF kind<>'IN' THEN RAISE EXCEPTION 'Serial not found' USING ERRCODE='23514'; END IF;
      INSERT INTO public.inventory_serials(item_id,serial_number,status,notes)
        VALUES(item_id,name,'在庫','入庫時建立') RETURNING id INTO serial_id;
    END IF;
    serial_ids:=array_append(serial_ids,serial_id);
  END LOOP;
  IF p_action='CREATE' THEN
    INSERT INTO public.inventory_transactions(item_id,transaction_type,transaction_date,quantity,unit,project_id,project_name,handler,source,notes,pending_serial_count)
    VALUES(item_id,kind,(p_data->>'transaction_date')::date,qty,COALESCE(p_data->>'unit',item.unit),project_id,project_name,
      COALESCE(NULLIF(p_data->>'handler',''),a.name),p_data->>'source',p_data->>'notes',pending) RETURNING * INTO tx;
  ELSE
    UPDATE public.inventory_transactions t SET item_id=item_id,transaction_type=kind,
      transaction_date=(p_data->>'transaction_date')::date,quantity=qty,unit=COALESCE(p_data->>'unit',item.unit),
      project_id=project_id,project_name=project_name,
      handler=COALESCE(NULLIF(p_data->>'handler',''),a.name),source=p_data->>'source',notes=p_data->>'notes',
      pending_serial_count=pending,updated_at=clock_timestamp() WHERE t.id=old_tx.id RETURNING * INTO tx;
    DELETE FROM public.inventory_transaction_serials l WHERE l.transaction_id=tx.id;
    IF old_tx.transaction_type='IN' THEN
      UPDATE public.inventory_serials SET status='作廢',project_id=NULL,updated_at=clock_timestamp()
      WHERE id=ANY(old_serial_ids) AND NOT(id=ANY(serial_ids));
    END IF;
  END IF;
  SELECT b.id INTO batch_id FROM public.inventory_batches b WHERE b.source_transaction_id=tx.id;
  IF kind IN ('IN','RETURN') AND batch_id IS NOT NULL THEN
    UPDATE public.inventory_batches SET item_id=tx.item_id,quantity=tx.quantity,in_date=tx.transaction_date,
      unit=tx.unit,handler=tx.handler,source=tx.source,notes=tx.notes WHERE id=batch_id;
  END IF;
  FOREACH serial_id IN ARRAY serial_ids LOOP
    UPDATE public.inventory_serials x SET status=CASE kind WHEN 'OUT' THEN '已出庫' ELSE '在庫' END,
      project_id=CASE kind WHEN 'OUT' THEN tx.project_id ELSE NULL END,
      batch_id=CASE WHEN kind IN ('IN','RETURN') THEN batch_id ELSE x.batch_id END,
      updated_at=clock_timestamp() WHERE x.id=serial_id;
    INSERT INTO public.inventory_transaction_serials(transaction_id,serial_id,serial_no,is_pending,created_at)
      SELECT tx.id,x.id,x.serial_number,false,clock_timestamp() FROM public.inventory_serials x WHERE x.id=serial_id;
  END LOOP;
  INSERT INTO public.inventory_transaction_serials(transaction_id,is_pending,created_at)
    SELECT tx.id,true,clock_timestamp() FROM generate_series(1,pending);
  PERFORM app_private.inventory_audit(CASE p_action WHEN 'CREATE' THEN 'CREATE_TRANSACTION' ELSE 'UPDATE_TRANSACTION' END,old_json,to_jsonb(tx)||jsonb_build_object('serials',app_private.inventory_transaction_serial_snapshot(tx.id)),p_reason);
  RETURN to_jsonb(tx);
END $$;
NOTIFY pgrst,'reload schema';
