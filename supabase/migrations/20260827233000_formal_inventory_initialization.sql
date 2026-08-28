-- 建立 formal inventory initialization 的紀錄
CREATE TABLE inventory_initializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_date date NOT NULL,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  initialized_by text,
  archived_transaction_count integer NOT NULL DEFAULT 0,
  deleted_void_transaction_count integer NOT NULL DEFAULT 0,
  preserved_serial_count integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_initialization_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initialization_id uuid NOT NULL REFERENCES inventory_initializations(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  previous_opening_quantity integer NOT NULL,
  new_opening_quantity integer NOT NULL,
  in_stock_serial_count integer NOT NULL DEFAULT 0,
  pending_serial_count integer NOT NULL DEFAULT 0,
  retained_in_stock_serial_count integer NOT NULL DEFAULT 0,
  removed_from_stock_serial_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_initialization_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initialization_id uuid NOT NULL REFERENCES inventory_initializations(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  serial_id uuid NOT NULL REFERENCES inventory_serials(id) ON DELETE CASCADE,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  is_retained boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (initialization_id, serial_id)
);
-- 為了將舊的 transactions 標記為 legacy
ALTER TABLE inventory_transactions
ADD COLUMN excluded_by_initialization_id uuid REFERENCES inventory_initializations(id) ON DELETE SET NULL;

-- 確保只有 2026-08-31 被允許作為基準日 (這版限定)
ALTER TABLE inventory_initializations
ADD CONSTRAINT inventory_initializations_baseline_date_check CHECK (baseline_date = '2026-08-31');

-- One-time initialization safety: 確保此表最多只能有一筆紀錄
CREATE UNIQUE INDEX inventory_initializations_singleton_idx ON inventory_initializations ((true));

-- Preview RPC
CREATE OR REPLACE FUNCTION preview_inventory_initialization(items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item record;
  v_item_data jsonb;
  v_in_stock_count integer;
  v_pending_count integer;
  v_can_initialize boolean;
  v_error_reason text;
  v_result jsonb := '[]'::jsonb;
  v_new_opening integer;
  v_existing_items_count integer;
  v_input_items_count integer;

  v_out_count integer;
  v_used_count integer;
  v_returned_count integer;
  v_scrapped_count integer;
  v_voided_count integer;
  v_retained_ids jsonb;
  v_retained_count integer;
  v_in_stock_serials jsonb;
BEGIN
  -- 檢查身份
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- One-time initialization check for preview
  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    DECLARE
      v_init record;
    BEGIN
      SELECT * INTO v_init FROM inventory_initializations LIMIT 1;
      RETURN jsonb_build_object(
        'already_initialized', true,
        'initialized_at', v_init.initialized_at,
        'baseline_date', v_init.baseline_date
      );
    END;
  END IF;

  v_input_items_count := jsonb_array_length(items);

  IF v_input_items_count = 0 THEN
    RETURN jsonb_build_object(
      'already_initialized', false,
      'can_execute_now', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date >= DATE '2026-08-31',
      'earliest_initialization_date', '2026-08-31',
      'items', '[]'::jsonb
    );
  END IF;

  SELECT count(*) INTO v_existing_items_count FROM inventory_items WHERE deleted_at IS NULL;

  IF v_input_items_count <> v_existing_items_count THEN
    RAISE EXCEPTION 'Missing or extra inventory items. Expected %, got %', v_existing_items_count, v_input_items_count;
  END IF;

  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_error_reason := NULL;
    v_can_initialize := true;
    v_pending_count := 0;

    SELECT * INTO v_item FROM inventory_items WHERE id = (v_item_data->>'id')::uuid AND deleted_at IS NULL;
    IF v_item IS NULL THEN
      v_error_reason := 'Item not found';
      v_can_initialize := false;
      CONTINUE;
    END IF;

    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
    IF v_new_opening < 0 THEN
      v_error_reason := 'Quantity cannot be negative';
      v_can_initialize := false;
    END IF;

    IF v_item.requires_serial THEN
      -- 計算真實在庫序號
      SELECT count(*) INTO v_in_stock_count FROM inventory_serials WHERE item_id = v_item.id AND status = '在庫';

      SELECT count(*) INTO v_out_count FROM inventory_serials WHERE item_id = v_item.id AND status = '已出庫';
      SELECT count(*) INTO v_used_count FROM inventory_serials WHERE item_id = v_item.id AND status = '已使用';
      SELECT count(*) INTO v_returned_count FROM inventory_serials WHERE item_id = v_item.id AND status = '已退回';
      SELECT count(*) INTO v_scrapped_count FROM inventory_serials WHERE item_id = v_item.id AND status = '報廢';
      SELECT count(*) INTO v_voided_count FROM inventory_serials WHERE item_id = v_item.id AND status = '作廢';

      -- 取得目前在庫序號清單
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'serial_number', serial_number)), '[]'::jsonb)
      INTO v_in_stock_serials
      FROM inventory_serials
      WHERE item_id = v_item.id AND status = '在庫';

      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      IF v_retained_ids IS NOT NULL AND jsonb_typeof(v_retained_ids) = 'array' THEN
        v_retained_count := jsonb_array_length(v_retained_ids);
      ELSE
        v_retained_count := v_in_stock_count;
      END IF;

      IF v_new_opening < v_retained_count THEN
        v_can_initialize := false;
        v_error_reason := 'New opening quantity cannot be less than retained serial count';
      ELSE
        v_pending_count := v_new_opening - v_retained_count;
      END IF;
    ELSE
      v_in_stock_count := 0;
      v_out_count := 0;
      v_used_count := 0;
      v_returned_count := 0;
      v_scrapped_count := 0;
      v_voided_count := 0;
      v_in_stock_serials := '[]'::jsonb;
    END IF;

    v_result := v_result || jsonb_build_object(
      'item_id', v_item.id,
      'name', v_item.name,
      'requires_serial', v_item.requires_serial,
      'current_opening_quantity', v_item.opening_quantity,
      'new_opening_quantity', v_new_opening,
      'in_stock_serial_count', v_in_stock_count,
      'out_serial_count', v_out_count,
      'used_serial_count', v_used_count,
      'returned_serial_count', v_returned_count,
      'scrapped_serial_count', v_scrapped_count,
      'voided_serial_count', v_voided_count,
      'pending_serial_count', v_pending_count,
      'can_initialize', v_can_initialize,
      'error_reason', v_error_reason,
      'in_stock_serials', v_in_stock_serials
    );
  END LOOP;

  RETURN jsonb_build_object(
    'already_initialized', false,
    'can_execute_now', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date >= DATE '2026-08-31',
    'earliest_initialization_date', '2026-08-31',
    'items', v_result
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION preview_inventory_initialization(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION preview_inventory_initialization(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION preview_inventory_initialization(jsonb) TO authenticated;
ALTER FUNCTION preview_inventory_initialization SET search_path = public;

-- Initialize RPC
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
  v_invalid_count integer;

  v_initial_serial_count integer;
  v_final_serial_count integer;

  v_archived_tx_count integer := 0;
  v_deleted_void_tx_count integer := 0;
  v_existing_items_count integer;
BEGIN
  -- 1. ADMIN 驗證
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- 1.5 One-time initialization safety: 確保不會重複執行
  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    RAISE EXCEPTION 'Inventory has already been initialized.';
  END IF;

  -- 1.8 Early-Date Guard: 禁止提早執行
  IF (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date < DATE '2026-08-31' THEN
    RAISE EXCEPTION 'Cannot initialize inventory before 2026-08-31 (Asia/Taipei).';
  END IF;

  -- 2. 鎖定需要的表
  LOCK TABLE inventory_items IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_serials IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_transactions IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_monthly_closings IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_monthly_closing_items IN ROW EXCLUSIVE MODE;

  -- 3. 再次驗證
  SELECT count(*) INTO v_existing_items_count FROM inventory_items WHERE deleted_at IS NULL;
  IF jsonb_array_length(items) <> v_existing_items_count THEN
    RAISE EXCEPTION 'Item count mismatch';
  END IF;

  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
    IF v_new_opening < 0 THEN
      RAISE EXCEPTION 'Negative quantity not allowed for %', v_item_data->>'id';
    END IF;

    SELECT * INTO v_item FROM inventory_items WHERE id = (v_item_data->>'id')::uuid;
    IF v_item.requires_serial THEN
      SELECT count(*) INTO v_in_stock_count FROM inventory_serials WHERE item_id = v_item.id AND status = '在庫';

      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      IF v_retained_ids IS NOT NULL AND jsonb_typeof(v_retained_ids) = 'array' THEN
        v_retained_count := jsonb_array_length(v_retained_ids);

        -- Validate retained IDs
        IF v_retained_count > 0 THEN
          SELECT count(*) INTO v_invalid_count
          FROM jsonb_array_elements_text(v_retained_ids) AS rid
          WHERE NOT EXISTS (
            SELECT 1 FROM inventory_serials
            WHERE id = rid::uuid AND item_id = v_item.id AND status = '在庫'
          );
          IF v_invalid_count > 0 THEN
            RAISE EXCEPTION 'Invalid retained serial IDs provided for item %', v_item.name;
          END IF;
        END IF;
      ELSE
        v_retained_count := v_in_stock_count;
        v_retained_ids := '[]'::jsonb;
        IF v_new_opening < v_in_stock_count THEN
          RAISE EXCEPTION 'Opening quantity < in-stock serial count for %. Must explicitly specify retained serials.', v_item.name;
        END IF;
      END IF;

      IF v_new_opening < v_retained_count THEN
        RAISE EXCEPTION 'Opening quantity < retained serial count for %', v_item.name;
      END IF;
    END IF;
  END LOOP;

  -- 4. 記錄初始化前 serial row count
  SELECT count(*) INTO v_initial_serial_count FROM inventory_serials;

  -- 5. 建立 inventory_initializations header
  INSERT INTO inventory_initializations (baseline_date, initialized_by)
  VALUES ('2026-08-31', auth.uid())
  RETURNING id INTO v_init_id;

  -- 6. 建立 audit
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    SELECT * INTO v_item FROM inventory_items WHERE id = (v_item_data->>'id')::uuid;
    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;

    IF v_item.requires_serial THEN
      SELECT count(*) INTO v_in_stock_count FROM inventory_serials WHERE item_id = v_item.id AND status = '在庫';
      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      IF v_retained_ids IS NOT NULL AND jsonb_typeof(v_retained_ids) = 'array' THEN
        v_retained_count := jsonb_array_length(v_retained_ids);
      ELSE
        v_retained_count := v_in_stock_count;
      END IF;

      -- Record serial audit before updating status
      IF v_retained_ids IS NOT NULL AND jsonb_array_length(v_retained_ids) > 0 THEN
        INSERT INTO inventory_initialization_serials (
          initialization_id, inventory_item_id, serial_id, previous_status, new_status, is_retained
        )
        SELECT
          v_init_id, v_item.id, s.id, '在庫',
          CASE WHEN s.id IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid) THEN '在庫' ELSE '已出庫' END,
          CASE WHEN s.id IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid) THEN true ELSE false END
        FROM inventory_serials s
        WHERE s.item_id = v_item.id AND s.status = '在庫';
      ELSE
        INSERT INTO inventory_initialization_serials (
          initialization_id, inventory_item_id, serial_id, previous_status, new_status, is_retained
        )
        SELECT
          v_init_id, v_item.id, s.id, '在庫',
          CASE WHEN v_retained_ids IS NULL THEN '在庫' ELSE '已出庫' END,
          CASE WHEN v_retained_ids IS NULL THEN true ELSE false END
        FROM inventory_serials s
        WHERE s.item_id = v_item.id AND s.status = '在庫';
      END IF;

      -- Update excluded serials to '已出庫'
      IF v_retained_count < v_in_stock_count THEN
        IF v_retained_ids IS NOT NULL AND jsonb_array_length(v_retained_ids) > 0 THEN
          UPDATE inventory_serials
          SET status = '已出庫', updated_at = now()
          WHERE item_id = v_item.id
            AND status = '在庫'
            AND id NOT IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid);
        ELSE
          UPDATE inventory_serials
          SET status = '已出庫', updated_at = now()
          WHERE item_id = v_item.id
            AND status = '在庫';
        END IF;
      END IF;
    ELSE
      v_in_stock_count := 0;
      v_retained_count := 0;
    END IF;

    INSERT INTO inventory_initialization_items (
      initialization_id, inventory_item_id, previous_opening_quantity,
      new_opening_quantity, in_stock_serial_count, pending_serial_count,
      retained_in_stock_serial_count, removed_from_stock_serial_count
    ) VALUES (
      v_init_id, v_item.id, v_item.opening_quantity,
      v_new_opening, v_in_stock_count, GREATEST(0, v_new_opening - v_retained_count),
      v_retained_count, v_in_stock_count - v_retained_count
    );
  END LOOP;

  -- 7. 清除目前測試 monthly closing / closing items (2026-03, 2026-07, 2026-08)
  DELETE FROM inventory_monthly_closing_items
  WHERE monthly_closing_id IN (
    SELECT id FROM inventory_monthly_closings WHERE closing_month IN ('2026-03', '2026-07', '2026-08')
  );
  DELETE FROM inventory_monthly_closings
  WHERE closing_month IN ('2026-03', '2026-07', '2026-08');

  -- 8. 將目前所有未作廢的 ledger 標記為 initialization
  WITH archived AS (
    UPDATE inventory_transactions
    SET excluded_by_initialization_id = v_init_id
    WHERE is_voided = false AND excluded_by_initialization_id IS NULL
    RETURNING id
  )
  SELECT count(*) INTO v_archived_tx_count FROM archived;

  -- 9. 清除 is_voided = true transactions
  WITH deleted_void AS (
    DELETE FROM inventory_transactions
    WHERE is_voided = true
    RETURNING id
  )
  SELECT count(*) INTO v_deleted_void_tx_count FROM deleted_void;

  -- 10. 更新全部 inventory_items.opening_quantity
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE inventory_items
    SET opening_quantity = (v_item_data->>'new_opening_quantity')::integer
    WHERE id = (v_item_data->>'id')::uuid;
  END LOOP;

  -- 11. 建立正式 2026-08 CLOSED monthly closing
  DECLARE
    v_closing_id uuid;
  BEGIN
    INSERT INTO inventory_monthly_closings (closing_month, status, closed_at, closed_by)
    VALUES ('2026-08', 'CLOSED', now(), auth.uid())
    RETURNING id INTO v_closing_id;

    FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
    LOOP
      v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
      INSERT INTO inventory_monthly_closing_items (
        monthly_closing_id, inventory_item_id,
        opening_quantity, in_quantity, out_quantity, return_quantity, adjust_quantity, closing_quantity
      ) VALUES (
        v_closing_id, (v_item_data->>'id')::uuid,
        v_new_opening, 0, 0, 0, 0, v_new_opening
      );
    END LOOP;
  END;

  -- 12. 驗證 serial 數量不變
  SELECT count(*) INTO v_final_serial_count FROM inventory_serials;
  IF v_final_serial_count <> v_initial_serial_count THEN
    RAISE EXCEPTION 'Serial count mismatch! Expected %, found %', v_initial_serial_count, v_final_serial_count;
  END IF;

  -- 13. 完成 audit 統計
  UPDATE inventory_initializations
  SET archived_transaction_count = v_archived_tx_count,
      deleted_void_transaction_count = v_deleted_void_tx_count,
      preserved_serial_count = v_final_serial_count
  WHERE id = v_init_id;

  RETURN v_init_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION initialize_inventory(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION initialize_inventory(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION initialize_inventory(jsonb) TO authenticated;
ALTER FUNCTION initialize_inventory SET search_path = public;

-- Cutoff Guard Trigger (Phase 2C)
CREATE OR REPLACE FUNCTION enforce_inventory_cutoff_guard() RETURNS trigger AS $$
DECLARE
  v_baseline_date date;
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    SELECT baseline_date INTO v_baseline_date FROM inventory_initializations LIMIT 1;
    IF v_baseline_date IS NOT NULL THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.transaction_date::date <= v_baseline_date THEN
          RAISE EXCEPTION 'Cannot insert transaction on or before baseline date (%)', v_baseline_date;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.transaction_date::date <> OLD.transaction_date::date AND NEW.transaction_date::date <= v_baseline_date THEN
          RAISE EXCEPTION 'Cannot change transaction date to on or before baseline date (%)', v_baseline_date;
        END IF;

        IF OLD.transaction_date::date <= v_baseline_date AND NEW.transaction_date::date <= v_baseline_date THEN
          IF NEW.quantity <> OLD.quantity OR NEW.item_id <> OLD.item_id OR NEW.transaction_type <> OLD.transaction_type THEN
            RAISE EXCEPTION 'Cannot modify formal ledger fields of legacy transactions on or before baseline date (%)', v_baseline_date;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_transactions_cutoff_guard ON inventory_transactions;
CREATE TRIGGER inventory_transactions_cutoff_guard
BEFORE INSERT OR UPDATE ON inventory_transactions
FOR EACH ROW EXECUTE FUNCTION enforce_inventory_cutoff_guard();
