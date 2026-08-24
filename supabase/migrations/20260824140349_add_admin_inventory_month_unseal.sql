CREATE OR REPLACE FUNCTION app_private.enforce_inventory_monthly_closing_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'CLOSED' THEN
      RAISE EXCEPTION '已封存月結不可刪除，請先解除封存'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status NOT IN ('OPEN', 'CLOSED') THEN
    RAISE EXCEPTION '不支援的月結狀態：%', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'CLOSED'
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION '只有管理員可以解除庫存月結封存'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.enforce_inventory_monthly_closing_state() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_inventory_monthly_closing_state
ON public.inventory_monthly_closings;

CREATE TRIGGER enforce_inventory_monthly_closing_state
BEFORE UPDATE OR DELETE ON public.inventory_monthly_closings
FOR EACH ROW
EXECUTE FUNCTION app_private.enforce_inventory_monthly_closing_state();

CREATE OR REPLACE FUNCTION public.unseal_inventory_month(
  p_year text,
  p_month text
)
RETURNS public.inventory_monthly_closings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  closing public.inventory_monthly_closings%ROWTYPE;
BEGIN
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION '只有管理員可以解除庫存月結封存'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT *
  INTO closing
  FROM public.inventory_monthly_closings
  WHERE year = p_year
    AND month = p_month
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '%-% 找不到月結紀錄', p_year, p_month
      USING ERRCODE = 'no_data_found';
  END IF;

  IF closing.status <> 'CLOSED' THEN
    RAISE EXCEPTION '%-% 尚未封存', p_year, p_month
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.inventory_monthly_closings
  SET status = 'OPEN'
  WHERE id = closing.id
  RETURNING * INTO closing;

  RETURN closing;
END;
$$;

REVOKE ALL ON FUNCTION public.unseal_inventory_month(text, text)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.unseal_inventory_month(text, text)
TO authenticated;

NOTIFY pgrst, 'reload schema';
