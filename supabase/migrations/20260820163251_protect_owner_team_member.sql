-- Protect the permanent system owner from privilege downgrade or removal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.team_members
    WHERE id = '65916798-f0ec-4d41-8b17-785c4189bd83'::uuid
      AND lower(btrim(email)) = 'shypomelo@gmail.com'
      AND role = 'admin'
      AND is_active = true
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'System owner team member row is missing or not in the expected active admin state';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.reject_owner_team_member_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  owner_team_member_id constant uuid := '65916798-f0ec-4d41-8b17-785c4189bd83'::uuid;
  owner_email constant text := 'shypomelo@gmail.com';
BEGIN
  IF TG_OP = 'DELETE' AND OLD.id = owner_team_member_id THEN
    RAISE EXCEPTION 'System owner team member cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.id = owner_team_member_id THEN
    IF lower(btrim(NEW.email)) <> owner_email THEN
      RAISE EXCEPTION 'System owner email cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'System owner role cannot be changed from admin'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'System owner cannot be deactivated'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'System owner cannot be soft deleted'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_owner_team_member ON public.team_members;

CREATE TRIGGER protect_owner_team_member
BEFORE UPDATE OR DELETE ON public.team_members
FOR EACH ROW
EXECUTE FUNCTION app_private.reject_owner_team_member_changes();
