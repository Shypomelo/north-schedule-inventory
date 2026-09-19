-- Inserts have no ledger yet; updates already hold the same item mutex used by RPCs.
CREATE OR REPLACE FUNCTION app_private.inventory_opening_balance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE initializing boolean := false;
BEGIN
  IF NEW.opening_quantity::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid opening quantity' USING ERRCODE='22023';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.opening_quantity<0 THEN RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: negative opening quantity' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.opening_quantity IS DISTINCT FROM OLD.opening_quantity THEN
    SELECT COALESCE(app_private.is_admin_member(),false) AND EXISTS(
      SELECT 1 FROM public.inventory_initializations i
      WHERE i.id::text=NULLIF(current_setting('app.inventory_initialization_id',true),'')
    ) INTO initializing;
    IF NOT initializing AND app_private.inventory_effective_balance(OLD.id)-OLD.opening_quantity+NEW.opening_quantity<0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: opening change would make stock negative' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER inventory_opening_balance_guard ON public.inventory_items;
CREATE TRIGGER inventory_opening_balance_guard BEFORE INSERT OR UPDATE OF opening_quantity ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION app_private.inventory_opening_balance_guard();
