CREATE OR REPLACE FUNCTION app_private.set_todo_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor_id uuid;
BEGIN
  IF OLD.scope IS DISTINCT FROM NEW.scope THEN
    RAISE EXCEPTION 'Todo scope cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The original creator and first assigner are historical ownership fields.
  IF OLD.created_by IS NOT NULL THEN
    NEW.created_by := OLD.created_by;
  END IF;
  IF OLD.assigned_by IS NOT NULL THEN
    NEW.assigned_by := OLD.assigned_by;
  END IF;

  IF NEW.status = '已退件' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status <> '待安排' THEN
      RAISE EXCEPTION '只有待安排的待辦可以退件'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT member.id
    INTO actor_id
    FROM public.team_members member
    WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
      AND member.is_active = true
      AND member.deleted_at IS NULL
    LIMIT 1;

    IF OLD.assigned_to IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION '只有被指派人可以退件'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF btrim(COALESCE(NEW.rejection_reason, '')) = '' THEN
      RAISE EXCEPTION '退件原因不可空白'
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.rejected_by := actor_id;
    NEW.rejected_at := now();
    NEW.rejection_reason := btrim(NEW.rejection_reason);
  ELSIF OLD.status = '已退件' AND NEW.status = '已退件' THEN
    NEW.rejected_by := OLD.rejected_by;
    NEW.rejected_at := OLD.rejected_at;
    NEW.rejection_reason := OLD.rejection_reason;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.set_todo_updated_at() FROM PUBLIC;
