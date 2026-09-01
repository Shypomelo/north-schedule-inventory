-- Preserve the complete inventory ledger during the one-time initialization.
-- Serialized items must explicitly declare the serial rows retained in stock.
-- Any opening quantity without a retained serial gets a zero-impact pending IN
-- transaction so the existing pending-serial screen can complete it later.

CREATE OR REPLACE FUNCTION initialize_inventory(items jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_init_id uuid;
  v_item_data jsonb;
  v_item record;
  v_new_opening integer;
  v_in_stock_count integer;
  v_retained_ids jsonb;
  v_retained_count integer;
  v_unique_retained_count integer;
  v_invalid_count integer;
  v_pending_count integer;
  v_pending_tx_id uuid;

  v_initial_serial_count integer;
  v_final_serial_count integer;

  v_archived_tx_count integer := 0;
  v_existing_items_count integer;
  v_input_items_unique_count integer;
BEGIN
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    RAISE EXCEPTION 'Inventory has already been initialized.';
  END IF;

  IF (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date < DATE '2026-08-31' THEN
    RAISE EXCEPTION 'Cannot initialize inventory before 2026-08-31 (Asia/Taipei).';
  END IF;

  LOCK TABLE inventory_items IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_serials IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_transactions IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_transaction_serials IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_monthly_closings IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_monthly_closing_items IN ROW EXCLUSIVE MODE;

  SELECT count(*) INTO v_existing_items_count FROM inventory_items;

  SELECT count(DISTINCT value->>'id')
  INTO v_input_items_unique_count
  FROM jsonb_array_elements(items);

  IF v_input_items_unique_count <> jsonb_array_length(items) THEN
    RAISE EXCEPTION 'Duplicate item IDs found in payload';
  END IF;

  IF jsonb_array_length(items) <> v_existing_items_count THEN
    RAISE EXCEPTION 'Item count mismatch';
  END IF;

  -- Validate the complete payload before changing any row.
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
    IF v_new_opening < 0 THEN
      RAISE EXCEPTION 'Negative quantity not allowed for %', v_item_data->>'id';
    END IF;

    SELECT * INTO v_item
    FROM inventory_items
    WHERE id = (v_item_data->>'id')::uuid;

    IF v_item IS NULL THEN
      RAISE EXCEPTION 'Item not found: %', v_item_data->>'id';
    END IF;

    IF v_item.requires_serial THEN
      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      IF v_retained_ids IS NULL OR jsonb_typeof(v_retained_ids) <> 'array' THEN
        RAISE EXCEPTION 'Serialized item % must explicitly specify retained serial IDs', v_item.name;
      END IF;

      v_retained_count := jsonb_array_length(v_retained_ids);

      SELECT count(DISTINCT value)
      INTO v_unique_retained_count
      FROM jsonb_array_elements_text(v_retained_ids);

      IF v_retained_count <> v_unique_retained_count THEN
        RAISE EXCEPTION 'Duplicate retained serial IDs provided for item %', v_item.name;
      END IF;

      IF v_retained_count > 0 THEN
        SELECT count(*) INTO v_invalid_count
        FROM jsonb_array_elements_text(v_retained_ids) AS rid
        WHERE NOT EXISTS (
          SELECT 1
          FROM inventory_serials serial
          WHERE serial.id = rid::uuid
            AND serial.item_id = v_item.id
            AND serial.status = '在庫'
            AND serial.short_key IS NOT NULL
        );

        IF v_invalid_count > 0 THEN
          RAISE EXCEPTION 'Invalid, non-stock, or non-standard retained serial IDs provided for item %', v_item.name;
        END IF;
      END IF;

      IF v_new_opening < v_retained_count THEN
        RAISE EXCEPTION 'Opening quantity < retained serial count for %', v_item.name;
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_initial_serial_count FROM inventory_serials;

  INSERT INTO inventory_initializations (baseline_date, initialized_by)
  VALUES (DATE '2026-08-31', auth.uid()::text)
  RETURNING id INTO v_init_id;

  -- Audit every current in-stock serial. Explicitly retained rows stay in stock;
  -- every other candidate leaves current stock but remains in serial history.
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    SELECT * INTO v_item
    FROM inventory_items
    WHERE id = (v_item_data->>'id')::uuid;

    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;

    IF v_item.requires_serial THEN
      SELECT count(*) INTO v_in_stock_count
      FROM inventory_serials
      WHERE item_id = v_item.id AND status = '在庫';

      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      v_retained_count := jsonb_array_length(v_retained_ids);
      v_pending_count := v_new_opening - v_retained_count;

      INSERT INTO inventory_initialization_serials (
        initialization_id,
        inventory_item_id,
        serial_id,
        previous_status,
        new_status,
        is_retained
      )
      SELECT
        v_init_id,
        v_item.id,
        serial.id,
        '在庫',
        CASE
          WHEN serial.id IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid) THEN '在庫'
          ELSE '已出庫'
        END,
        serial.id IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid)
      FROM inventory_serials serial
      WHERE serial.item_id = v_item.id AND serial.status = '在庫';

      UPDATE inventory_serials serial
      SET status = '已出庫', updated_at = now()
      WHERE serial.item_id = v_item.id
        AND serial.status = '在庫'
        AND serial.id NOT IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid);
    ELSE
      v_in_stock_count := 0;
      v_retained_count := 0;
      v_pending_count := 0;
    END IF;

    INSERT INTO inventory_initialization_items (
      initialization_id,
      inventory_item_id,
      previous_opening_quantity,
      new_opening_quantity,
      in_stock_serial_count,
      pending_serial_count,
      retained_in_stock_serial_count,
      removed_from_stock_serial_count
    ) VALUES (
      v_init_id,
      v_item.id,
      v_item.opening_quantity,
      v_new_opening,
      v_in_stock_count,
      v_pending_count,
      v_retained_count,
      v_in_stock_count - v_retained_count
    );
  END LOOP;

  -- Remove only rebuildable closing snapshots, never transaction ledger rows.
  DELETE FROM inventory_monthly_closing_items
  WHERE closing_id IN (
    SELECT id
    FROM inventory_monthly_closings
    WHERE year = '2026' AND month IN ('03', '07', '08')
  );

  DELETE FROM inventory_monthly_closings
  WHERE year = '2026' AND month IN ('03', '07', '08');

  -- All old transactions, including voided transactions, remain queryable and
  -- are excluded from the new stock calculation through the initialization ID.
  WITH archived AS (
    UPDATE inventory_transactions
    SET excluded_by_initialization_id = v_init_id
    WHERE excluded_by_initialization_id IS NULL
    RETURNING id
  )
  SELECT count(*) INTO v_archived_tx_count FROM archived;

  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE inventory_items
    SET opening_quantity = (v_item_data->>'new_opening_quantity')::integer
    WHERE id = (v_item_data->>'id')::uuid;
  END LOOP;

  -- Reuse the existing pending-serial workflow. These synthetic IN rows are
  -- excluded from stock calculation because the quantity is already included
  -- in opening_quantity; their pending links remain fillable after initialization.
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    SELECT * INTO v_item
    FROM inventory_items
    WHERE id = (v_item_data->>'id')::uuid;

    IF v_item.requires_serial THEN
      v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      v_pending_count := v_new_opening - jsonb_array_length(v_retained_ids);

      IF v_pending_count > 0 THEN
        INSERT INTO inventory_transactions (
          item_id,
          transaction_type,
          transaction_date,
          quantity,
          unit,
          handler,
          source,
          notes,
          pending_serial_count,
          is_voided,
          excluded_by_initialization_id
        ) VALUES (
          v_item.id,
          'IN',
          DATE '2026-09-01',
          v_pending_count,
          v_item.unit,
          '系統',
          'INVENTORY_INITIALIZATION_PENDING',
          '初始化基準待補序號（數量已包含於期初庫存，不重複計算）',
          v_pending_count,
          false,
          v_init_id
        )
        RETURNING id INTO v_pending_tx_id;

        INSERT INTO inventory_transaction_serials (
          transaction_id,
          serial_id,
          serial_no,
          is_pending
        )
        SELECT v_pending_tx_id, NULL, NULL, true
        FROM generate_series(1, v_pending_count);
      END IF;
    END IF;
  END LOOP;

  DECLARE
    v_closing_id uuid;
  BEGIN
    INSERT INTO inventory_monthly_closings (year, month, status, closed_at, closed_by)
    VALUES ('2026', '08', 'CLOSED', now(), auth.uid()::text)
    RETURNING id INTO v_closing_id;

    FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
    LOOP
      v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
      SELECT * INTO v_item
      FROM inventory_items
      WHERE id = (v_item_data->>'id')::uuid;

      INSERT INTO inventory_monthly_closing_items (
        closing_id,
        inventory_item_id,
        stock_category,
        source,
        item_name,
        item_type,
        unit,
        opening_quantity,
        monthly_in,
        monthly_out,
        monthly_return,
        monthly_adjust,
        usage_quantity,
        closing_quantity,
        status
      ) VALUES (
        v_closing_id,
        v_item.id,
        COALESCE(v_item.category, ''),
        COALESCE(v_item.source_type, ''),
        v_item.name,
        COALESCE(v_item.item_category, ''),
        v_item.unit,
        v_new_opening,
        0,
        0,
        0,
        0,
        0,
        v_new_opening,
        CASE WHEN v_item.is_active THEN '啟用' ELSE '停用' END
      );
    END LOOP;
  END;

  SELECT count(*) INTO v_final_serial_count FROM inventory_serials;
  IF v_final_serial_count <> v_initial_serial_count THEN
    RAISE EXCEPTION 'Serial count mismatch! Expected %, found %', v_initial_serial_count, v_final_serial_count;
  END IF;

  UPDATE inventory_initializations
  SET archived_transaction_count = v_archived_tx_count,
      deleted_void_transaction_count = 0,
      preserved_serial_count = v_final_serial_count
  WHERE id = v_init_id;

  RETURN v_init_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION initialize_inventory(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION initialize_inventory(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION initialize_inventory(jsonb) TO authenticated;
ALTER FUNCTION initialize_inventory SET search_path = pg_catalog, public;
