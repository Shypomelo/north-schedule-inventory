CREATE OR REPLACE FUNCTION app_private.reject_closed_month_inventory_transaction_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  checked_date date;
  checked_month text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    checked_date := NEW.transaction_date;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_monthly_closings closing
      WHERE closing.year = to_char(checked_date, 'YYYY')
        AND closing.month = to_char(checked_date, 'MM')
        AND closing.status = 'CLOSED'
    ) THEN
      checked_month := to_char(checked_date, 'YYYY-MM');
      RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    checked_date := OLD.transaction_date;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_monthly_closings closing
      WHERE closing.year = to_char(checked_date, 'YYYY')
        AND closing.month = to_char(checked_date, 'MM')
        AND closing.status = 'CLOSED'
    ) THEN
      checked_month := to_char(checked_date, 'YYYY-MM');
      RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
        USING ERRCODE = 'check_violation';
    END IF;

    checked_date := NEW.transaction_date;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_monthly_closings closing
      WHERE closing.year = to_char(checked_date, 'YYYY')
        AND closing.month = to_char(checked_date, 'MM')
        AND closing.status = 'CLOSED'
    ) THEN
      checked_month := to_char(checked_date, 'YYYY-MM');
      RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  checked_date := OLD.transaction_date;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_monthly_closings closing
    WHERE closing.year = to_char(checked_date, 'YYYY')
      AND closing.month = to_char(checked_date, 'MM')
      AND closing.status = 'CLOSED'
  ) THEN
    checked_month := to_char(checked_date, 'YYYY-MM');
    RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION app_private.reject_closed_month_inventory_transaction_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS reject_closed_month_inventory_transaction_write
ON public.inventory_transactions;

CREATE TRIGGER reject_closed_month_inventory_transaction_write
BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION app_private.reject_closed_month_inventory_transaction_write();
