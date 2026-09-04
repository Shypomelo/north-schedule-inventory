-- Correct only P401-5RM4MRM after the 2026-08-24 physical serial count.
-- Also make future IN/RETURN batch creation atomic with its source transaction.

BEGIN;

DO $$
DECLARE
  v_item_id constant uuid := '4f75e101-8837-4a81-b553-32e903912c1d';
  v_initialization_id constant uuid := 'd4661bea-c4bc-42c5-84fd-a563b01b056a';
  v_synthetic_transaction_id constant uuid := 'ec1cd502-0321-4c70-bbb3-457f065c9285';
  v_real_transaction_four_id constant uuid := '2144ccec-2880-49ff-ac0a-a9b9e1bf2cf3';
  v_real_transaction_one_id constant uuid := '836cd7ac-cd33-4230-a266-9401692402f0';
  v_count integer;
  v_before jsonb;
BEGIN
  PERFORM 1
  FROM public.inventory_items
  WHERE id = v_item_id
    AND code = 'P401-5RM4MRM'
    AND requires_serial = true
    AND opening_quantity = 5
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P401 preflight failed: item identity or opening quantity changed';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_batches
  WHERE item_id = v_item_id
    AND batch_number = ANY (ARRAY[
      'IN-20260625-004', 'IN-20260811-001', 'IN-20260812-001',
      'IN-20260812-003', 'IN-20260812-004'
    ])
    AND source_transaction_id IS NULL;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'P401 preflight failed: expected 5 removable legacy batches, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_serials
  WHERE item_id = v_item_id
    AND serial_number = ANY (ARRAY['1023', '12121224242', '121224242', '7474477272'])
    AND status = '已出庫';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'P401 preflight failed: expected 4 removable test serials, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_serials serial
  JOIN public.inventory_batches batch ON batch.id = serial.batch_id
  WHERE serial.item_id = v_item_id
    AND serial.serial_number LIKE 'SJ%'
    AND batch.batch_number IN ('IN-20260824-001', 'IN-20260824-002')
    AND serial.status = '已出庫';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'P401 preflight failed: expected 5 recoverable 2026-08-24 serials, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE id IN (v_real_transaction_four_id, v_real_transaction_one_id)
    AND item_id = v_item_id
    AND transaction_type = 'IN'
    AND transaction_date = DATE '2026-08-24'
    AND is_voided = false
    AND excluded_by_initialization_id = v_initialization_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'P401 preflight failed: real 2026-08-24 IN transactions changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_transactions
    WHERE id = v_real_transaction_four_id AND quantity = 4 AND pending_serial_count = 4
  ) OR NOT EXISTS (
    SELECT 1 FROM public.inventory_transactions
    WHERE id = v_real_transaction_one_id AND quantity = 1 AND pending_serial_count = 0
  ) THEN
    RAISE EXCEPTION 'P401 preflight failed: real transaction quantities or pending counts changed';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_transactions tx
  JOIN public.inventory_transaction_serials link ON link.transaction_id = tx.id
  WHERE tx.id = v_synthetic_transaction_id
    AND tx.item_id = v_item_id
    AND tx.source = 'INVENTORY_INITIALIZATION_PENDING'
    AND tx.quantity = 5
    AND tx.pending_serial_count = 5
    AND link.is_pending = true
    AND link.serial_id IS NULL;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'P401 preflight failed: expected 5 synthetic pending links, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_initialization_items
    WHERE id = '90bef6c1-b447-4e4b-89ca-476b885d192f'
      AND initialization_id = v_initialization_id
      AND inventory_item_id = v_item_id
      AND new_opening_quantity = 5
      AND retained_in_stock_serial_count = 0
      AND pending_serial_count = 5
  ) THEN
    RAISE EXCEPTION 'P401 preflight failed: initialization item changed';
  END IF;

  SELECT jsonb_build_object(
    'batches', (SELECT jsonb_agg(to_jsonb(batch) ORDER BY batch.batch_number)
                FROM public.inventory_batches batch WHERE batch.item_id = v_item_id),
    'serials', (SELECT jsonb_agg(to_jsonb(serial) ORDER BY serial.serial_number)
                FROM public.inventory_serials serial WHERE serial.item_id = v_item_id),
    'transactions', (SELECT jsonb_agg(to_jsonb(tx) ORDER BY tx.created_at)
                     FROM public.inventory_transactions tx WHERE tx.item_id = v_item_id),
    'transaction_serials', (
      SELECT jsonb_agg(to_jsonb(link) ORDER BY link.created_at)
      FROM public.inventory_transaction_serials link
      JOIN public.inventory_transactions tx ON tx.id = link.transaction_id
      WHERE tx.item_id = v_item_id
    ),
    'initialization_item', (SELECT to_jsonb(initialization_item)
                            FROM public.inventory_initialization_items initialization_item
                            WHERE initialization_item.inventory_item_id = v_item_id),
    'initialization_serials', (SELECT jsonb_agg(to_jsonb(initialization_serial) ORDER BY initialization_serial.serial_id)
                               FROM public.inventory_initialization_serials initialization_serial
                               WHERE initialization_serial.inventory_item_id = v_item_id)
  ) INTO v_before;

  DELETE FROM public.inventory_serials
  WHERE item_id = v_item_id
    AND serial_number = ANY (ARRAY['1023', '12121224242', '121224242', '7474477272']);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 4 THEN RAISE EXCEPTION 'P401 correction aborted: deleted % test serials', v_count; END IF;

  DELETE FROM public.inventory_batches
  WHERE item_id = v_item_id
    AND batch_number = ANY (ARRAY[
      'IN-20260625-004', 'IN-20260811-001', 'IN-20260812-001',
      'IN-20260812-003', 'IN-20260812-004'
    ]);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 5 THEN RAISE EXCEPTION 'P401 correction aborted: deleted % test batches', v_count; END IF;

  DELETE FROM public.inventory_transactions
  WHERE id = v_synthetic_transaction_id
    AND item_id = v_item_id
    AND source = 'INVENTORY_INITIALIZATION_PENDING';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'P401 correction aborted: deleted % synthetic transactions', v_count; END IF;

  UPDATE public.inventory_serials serial
  SET status = '在庫', project_id = NULL, updated_at = now()
  FROM public.inventory_batches batch
  WHERE serial.batch_id = batch.id
    AND serial.item_id = v_item_id
    AND serial.serial_number LIKE 'SJ%'
    AND batch.batch_number IN ('IN-20260824-001', 'IN-20260824-002');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 5 THEN RAISE EXCEPTION 'P401 correction aborted: restored % real serials', v_count; END IF;

  UPDATE public.inventory_batches
  SET source_transaction_id = CASE batch_number
    WHEN 'IN-20260824-001' THEN v_real_transaction_four_id
    WHEN 'IN-20260824-002' THEN v_real_transaction_one_id
  END
  WHERE item_id = v_item_id
    AND batch_number IN ('IN-20260824-001', 'IN-20260824-002')
    AND source_transaction_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 2 THEN RAISE EXCEPTION 'P401 correction aborted: linked % real batches', v_count; END IF;

  UPDATE public.inventory_transactions
  SET pending_serial_count = 0, updated_at = now()
  WHERE id = v_real_transaction_four_id
    AND item_id = v_item_id
    AND pending_serial_count = 4;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'P401 correction aborted: real transaction pending count not updated'; END IF;

  INSERT INTO public.inventory_transaction_serials (transaction_id, serial_id, serial_no, is_pending)
  SELECT v_real_transaction_four_id, serial.id, serial.serial_number, false
  FROM public.inventory_serials serial
  JOIN public.inventory_batches batch ON batch.id = serial.batch_id
  WHERE serial.item_id = v_item_id
    AND batch.batch_number = 'IN-20260824-001'
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_transaction_serials existing
      WHERE existing.transaction_id = v_real_transaction_four_id
        AND existing.serial_id = serial.id
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 4 THEN RAISE EXCEPTION 'P401 correction aborted: inserted % real transaction serial links', v_count; END IF;

  UPDATE public.inventory_initialization_serials initialization_serial
  SET new_status = '在庫', is_retained = true
  FROM public.inventory_serials serial
  WHERE initialization_serial.initialization_id = v_initialization_id
    AND initialization_serial.inventory_item_id = v_item_id
    AND initialization_serial.serial_id = serial.id
    AND serial.item_id = v_item_id
    AND serial.serial_number LIKE 'SJ%';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 5 THEN RAISE EXCEPTION 'P401 correction aborted: retained % initialization serials', v_count; END IF;

  UPDATE public.inventory_initialization_items
  SET new_opening_quantity = 5,
      in_stock_serial_count = 5,
      retained_in_stock_serial_count = 5,
      removed_from_stock_serial_count = 0,
      pending_serial_count = 0
  WHERE initialization_id = v_initialization_id
    AND inventory_item_id = v_item_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'P401 correction aborted: initialization item not updated'; END IF;

  INSERT INTO public.activity_logs (
    action, target_type, target_id, description, changes,
    user_id, user_name, actor_user_id, actor_name, action_type,
    target_label, before_value, after_value, message
  ) VALUES (
    'UPDATE', 'INVENTORY_ITEM', v_item_id::text,
    '依 2026-08-24 真實序號盤點修正 P401 庫存序號資料',
    jsonb_build_object(
      'correction_key', 'P401_2026_08_24_SERIAL_RECONCILIATION',
      'before', v_before,
      'deleted_test_batches', ARRAY['IN-20260625-004', 'IN-20260811-001', 'IN-20260812-001', 'IN-20260812-003', 'IN-20260812-004'],
      'deleted_test_serials', ARRAY['1023', '12121224242', '121224242', '7474477272'],
      'deleted_synthetic_transaction_id', v_synthetic_transaction_id,
      'result', jsonb_build_object('stock', 5, 'in_stock_serials', 5, 'pending_serials', 0)
    ),
    'system', 'Production migration', 'system', 'Production migration',
    'P401_SERIAL_RECONCILIATION', 'P401-5RM4MRM',
    v_before::text,
    jsonb_build_object('stock', 5, 'in_stock_serials', 5, 'pending_serials', 0)::text,
    '保留 2026-08-24 兩筆真實入庫與五個 SJ 序號；未修改月結資料'
  );
END;
$$;

CREATE OR REPLACE FUNCTION app_private.ensure_inventory_batch_for_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_prefix text;
  v_sequence integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.transaction_type IS NOT DISTINCT FROM NEW.transaction_type
  THEN
    RETURN NEW;
  END IF;

  IF NEW.transaction_type NOT IN ('IN', 'RETURN')
     OR NEW.is_voided
     OR NEW.source IS NOT DISTINCT FROM 'INVENTORY_INITIALIZATION_PENDING'
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inventory_batches batch
    WHERE batch.source_transaction_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  v_prefix := 'IN-' || replace(NEW.transaction_date::text, '-', '') || '-';
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory_batch:' || v_prefix, 0));

  SELECT coalesce(max(right(batch.batch_number, 3)::integer), 0) + 1
  INTO v_sequence
  FROM public.inventory_batches batch
  WHERE batch.batch_number LIKE v_prefix || '%'
    AND right(batch.batch_number, 3) ~ '^[0-9]{3}$';

  INSERT INTO public.inventory_batches (
    batch_number, item_id, source_transaction_id, in_date, source,
    quantity, unit, handler, notes
  ) VALUES (
    v_prefix || lpad(v_sequence::text, 3, '0'),
    NEW.item_id,
    NEW.id,
    NEW.transaction_date,
    coalesce(NEW.source, CASE WHEN NEW.transaction_type = 'RETURN' THEN '退料' ELSE NULL END),
    NEW.quantity,
    NEW.unit,
    NEW.handler,
    NEW.notes
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.ensure_inventory_batch_for_transaction() FROM PUBLIC;

DROP TRIGGER IF EXISTS ensure_inventory_batch_for_transaction ON public.inventory_transactions;
CREATE TRIGGER ensure_inventory_batch_for_transaction
AFTER INSERT OR UPDATE OF transaction_type ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION app_private.ensure_inventory_batch_for_transaction();

COMMIT;
