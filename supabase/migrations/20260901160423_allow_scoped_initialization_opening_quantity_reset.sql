CREATE OR REPLACE FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  scoped_initialization_id text;
BEGIN
  IF OLD.opening_quantity IS NOT DISTINCT FROM NEW.opening_quantity THEN
    RETURN NEW;
  END IF;

  scoped_initialization_id := NULLIF(
    pg_catalog.current_setting('app.inventory_initialization_id', true),
    ''
  );

  IF scoped_initialization_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.inventory_initializations initialization
       WHERE initialization.id = scoped_initialization_id::uuid
         AND initialization.initialized_by = auth.uid()::text
     ) THEN
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
$function$;

REVOKE ALL ON FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change() FROM PUBLIC;
