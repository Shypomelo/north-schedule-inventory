CREATE OR REPLACE FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
BEGIN
  IF OLD.opening_quantity IS NOT DISTINCT FROM NEW.opening_quantity THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_monthly_closing_items closing_item
    WHERE closing_item.inventory_item_id = OLD.id
  ) THEN
    RAISE EXCEPTION '此品項已有月結紀錄，初始庫存已鎖定，請使用庫存調整'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS reject_locked_inventory_item_opening_quantity_change
ON public.inventory_items;

CREATE TRIGGER reject_locked_inventory_item_opening_quantity_change
BEFORE UPDATE OF opening_quantity ON public.inventory_items
FOR EACH ROW
EXECUTE FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change();
