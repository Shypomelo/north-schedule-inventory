-- Candidate-only atomic personnel/workspace profile mutation.
-- SECURITY INVOKER intentionally preserves the existing ADMIN RLS boundary and
-- the permanent-owner protection trigger on team_members.
CREATE FUNCTION public.update_member_workspace_profile(
  p_member_id uuid,
  p_name text,
  p_email text,
  p_role text,
  p_is_active boolean,
  p_google_calendar_email text,
  p_notes text,
  p_position_ids uuid[],
  p_work_group_ids uuid[],
  p_default_work_group_id uuid,
  p_dashboard_view_ids uuid[],
  p_default_dashboard_view_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid := coalesce(p_member_id, gen_random_uuid());
  v_position_ids uuid[] := coalesce(p_position_ids, '{}'::uuid[]);
  v_work_group_ids uuid[] := coalesce(p_work_group_ids, '{}'::uuid[]);
  v_dashboard_view_ids uuid[] := coalesce(p_dashboard_view_ids, '{}'::uuid[]);
  v_role text := lower(btrim(coalesce(p_role, '')));
BEGIN
  IF NOT coalesce(app_private.is_admin_member(), false) THEN
    RAISE EXCEPTION 'Only admin members may update personnel workspace profiles'
      USING ERRCODE = '42501';
  END IF;

  IF btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_email, '')) = '' THEN
    RAISE EXCEPTION 'Name and email are required' USING ERRCODE = '23514';
  END IF;
  IF v_role NOT IN ('admin', 'engineer', 'viewer') THEN
    RAISE EXCEPTION 'Invalid system role' USING ERRCODE = '23514';
  END IF;
  IF cardinality(v_position_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_position_ids)))
    OR cardinality(v_work_group_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_work_group_ids)))
    OR cardinality(v_dashboard_view_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_dashboard_view_ids))) THEN
    RAISE EXCEPTION 'Duplicate profile assignment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_position_ids) requested(id)
    WHERE requested.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.positions position
      WHERE position.id = requested.id AND position.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive position assignment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_work_group_ids) requested(id)
    WHERE requested.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.work_groups work_group
      WHERE work_group.id = requested.id AND work_group.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive work group assignment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_dashboard_view_ids) requested(id)
    WHERE requested.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.dashboard_views dashboard_view
      WHERE dashboard_view.id = requested.id AND dashboard_view.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive dashboard view assignment' USING ERRCODE = '23514';
  END IF;
  IF (cardinality(v_work_group_ids) = 0 AND p_default_work_group_id IS NOT NULL)
    OR (cardinality(v_work_group_ids) > 0 AND (
      p_default_work_group_id IS NULL OR NOT p_default_work_group_id = ANY(v_work_group_ids)
    )) THEN
    RAISE EXCEPTION 'Default work group must be one selected work group' USING ERRCODE = '23514';
  END IF;
  IF (cardinality(v_dashboard_view_ids) = 0 AND p_default_dashboard_view_id IS NOT NULL)
    OR (cardinality(v_dashboard_view_ids) > 0 AND (
      p_default_dashboard_view_id IS NULL OR NOT p_default_dashboard_view_id = ANY(v_dashboard_view_ids)
    )) THEN
    RAISE EXCEPTION 'Default dashboard view must be one selected view' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-workspace-profile:' || v_member_id::text, 0)
  );

  IF p_member_id IS NULL THEN
    INSERT INTO public.team_members (
      id, name, email, role, category, is_active, google_calendar_email, notes
    ) VALUES (
      v_member_id,
      btrim(p_name),
      lower(btrim(p_email)),
      v_role,
      'other',
      p_is_active,
      nullif(btrim(coalesce(p_google_calendar_email, '')), ''),
      nullif(btrim(coalesce(p_notes, '')), '')
    );
  ELSE
    UPDATE public.team_members
    SET name = btrim(p_name),
        email = lower(btrim(p_email)),
        role = v_role,
        is_active = p_is_active,
        google_calendar_email = nullif(btrim(coalesce(p_google_calendar_email, '')), ''),
        notes = nullif(btrim(coalesce(p_notes, '')), ''),
        updated_at = now()
    WHERE id = v_member_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Team member not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  DELETE FROM public.member_positions WHERE member_id = v_member_id;
  INSERT INTO public.member_positions (member_id, position_id)
  SELECT v_member_id, requested.id FROM unnest(v_position_ids) requested(id);

  DELETE FROM public.member_work_groups WHERE member_id = v_member_id;
  INSERT INTO public.member_work_groups (member_id, work_group_id, is_default)
  SELECT v_member_id, requested.id, requested.id = p_default_work_group_id
  FROM unnest(v_work_group_ids) requested(id);

  DELETE FROM public.member_dashboard_views WHERE member_id = v_member_id;
  INSERT INTO public.member_dashboard_views (member_id, dashboard_view_id, is_default)
  SELECT v_member_id, requested.id, requested.id = p_default_dashboard_view_id
  FROM unnest(v_dashboard_view_ids) requested(id);

  RETURN v_member_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_member_workspace_profile(
  uuid, text, text, text, boolean, text, text, uuid[], uuid[], uuid, uuid[], uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_member_workspace_profile(
  uuid, text, text, text, boolean, text, text, uuid[], uuid[], uuid, uuid[], uuid
) TO authenticated;

COMMENT ON FUNCTION public.update_member_workspace_profile(
  uuid, text, text, text, boolean, text, text, uuid[], uuid[], uuid, uuid[], uuid
) IS 'Atomically updates one personnel record and its position, work-group, and dashboard-view memberships under caller RLS.';
