ALTER TABLE public.inventory_batches
ADD COLUMN source_transaction_id uuid NULL;

ALTER TABLE public.inventory_batches
ADD CONSTRAINT inventory_batches_source_transaction_id_fkey
FOREIGN KEY (source_transaction_id)
REFERENCES public.inventory_transactions(id)
ON DELETE RESTRICT;

CREATE UNIQUE INDEX inventory_batches_source_transaction_id_idx
ON public.inventory_batches(source_transaction_id)
WHERE source_transaction_id IS NOT NULL;

COMMENT ON COLUMN public.inventory_batches.source_transaction_id IS
'建立此批次的 IN/RETURN inventory transaction；舊資料可為 NULL。批次是否作廢以來源 transaction.is_voided 為準。';

CREATE OR REPLACE FUNCTION app_private.safely_void_inventory_in_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, app_private
AS $$
BEGIN
  IF OLD.transaction_type <> 'IN'
     OR OLD.is_voided IS TRUE
     OR NEW.is_voided IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION '僅限管理員作廢入庫紀錄';
  END IF;

  IF NULLIF(BTRIM(NEW.voided_reason), '') IS NULL THEN
    RAISE EXCEPTION '作廢入庫必須填寫原因';
  END IF;

  -- Lock linked serial rows in a stable order before validating/updating them.
  PERFORM 1
  FROM public.inventory_serials serial
  JOIN public.inventory_transaction_serials origin_link
    ON origin_link.serial_id = serial.id
  WHERE origin_link.transaction_id = OLD.id
  ORDER BY serial.id
  FOR UPDATE OF serial;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_transaction_serials origin_link
    JOIN public.inventory_serials serial
      ON serial.id = origin_link.serial_id
    WHERE origin_link.transaction_id = OLD.id
      AND (
        serial.status <> '在庫'
        OR EXISTS (
          SELECT 1
          FROM public.inventory_transaction_serials later_link
          JOIN public.inventory_transactions later_transaction
            ON later_transaction.id = later_link.transaction_id
          WHERE later_link.serial_id = origin_link.serial_id
            AND later_link.transaction_id <> OLD.id
            AND later_transaction.is_voided IS NOT TRUE
        )
      )
  ) THEN
    RAISE EXCEPTION '此入庫批次已有序號被使用，請先處理相關序號後再作廢入庫。';
  END IF;

  UPDATE public.inventory_serials serial
  SET status = '作廢',
      project_id = NULL,
      updated_at = NOW()
  WHERE EXISTS (
    SELECT 1
    FROM public.inventory_transaction_serials origin_link
    WHERE origin_link.transaction_id = OLD.id
      AND origin_link.serial_id = serial.id
  );

  NEW.voided_at := COALESCE(NEW.voided_at, NOW());
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS safely_void_inventory_in_transaction
ON public.inventory_transactions;

CREATE TRIGGER safely_void_inventory_in_transaction
BEFORE UPDATE OF is_voided
ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION app_private.safely_void_inventory_in_transaction();

COMMENT ON FUNCTION app_private.safely_void_inventory_in_transaction() IS
'ADMIN 作廢 IN 時保留序號歷史並將序號標記為作廢；若序號仍被有效後續交易使用則拒絕。';

CREATE OR REPLACE FUNCTION app_private.protect_voided_inventory_serial_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> '作廢' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '作廢序號必須保留歷史，不可刪除';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION '作廢序號的狀態、序號與來源批次不可修改';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_voided_inventory_serial_history
ON public.inventory_serials;

CREATE TRIGGER protect_voided_inventory_serial_history
BEFORE UPDATE OR DELETE
ON public.inventory_serials
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_voided_inventory_serial_history();

COMMENT ON FUNCTION app_private.protect_voided_inventory_serial_history() IS
'保護作廢序號的歷史識別與來源關聯，禁止刪除或重新啟用。';
