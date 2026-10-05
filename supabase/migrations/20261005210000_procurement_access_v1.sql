-- Procurement is an active identity with a separate read-only capability.
-- Existing ADMIN / ENGINEER / VIEWER membership semantics remain unchanged.
CREATE OR REPLACE FUNCTION app_private.is_procurement_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members m
    WHERE lower(m.email) = lower(auth.jwt() ->> 'email')
      AND m.is_active AND m.deleted_at IS NULL
      AND lower(m.role) = 'procurement'
  );
$$;
REVOKE ALL ON FUNCTION app_private.is_procurement_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_procurement_member() TO authenticated;

CREATE OR REPLACE FUNCTION app_private.is_active_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members m
    WHERE lower(m.email) = lower(auth.jwt() ->> 'email')
      AND m.is_active AND m.deleted_at IS NULL
      AND lower(m.role) IN ('admin', 'engineer', 'viewer')
  );
$$;

-- Owner-scoped workbench policies and RPCs use this helper directly.
CREATE OR REPLACE FUNCTION app_private.current_member_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT m.id FROM public.team_members m
  WHERE lower(m.email) = lower(auth.jwt() ->> 'email')
    AND m.is_active AND m.deleted_at IS NULL
    AND lower(m.role) IN ('admin', 'engineer', 'viewer')
  ORDER BY m.id LIMIT 1;
$$;

-- Keep the single admin profile mutation path as the role parser.
CREATE OR REPLACE FUNCTION public.update_member_workspace_profile(p_member_id uuid, p_name text, p_email text, p_role text, p_is_active boolean, p_google_calendar_email text, p_notes text, p_position_ids uuid[], p_work_group_ids uuid[], p_default_work_group_id uuid, p_dashboard_view_ids uuid[], p_default_dashboard_view_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  IF v_role NOT IN ('admin', 'engineer', 'viewer', 'procurement') THEN
    RAISE EXCEPTION 'Invalid system role' USING ERRCODE = '23514';
  END IF;
  IF v_role = 'procurement' AND (
    cardinality(v_position_ids) > 0 OR cardinality(v_work_group_ids) > 0
    OR cardinality(v_dashboard_view_ids) > 0
    OR p_default_work_group_id IS NOT NULL OR p_default_dashboard_view_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Procurement cannot have workspace assignments' USING ERRCODE = '23514';
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
$function$;

-- Procurement can read only its own identity from team_members.
CREATE POLICY procurement_own_member_read ON public.team_members
FOR SELECT TO authenticated
USING (app_private.is_procurement_member()
  AND lower(email) = lower(auth.jwt() ->> 'email'));
CREATE POLICY procurement_read ON public.inventory_items FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_transactions FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_serials FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_batches FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_transaction_serials FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_monthly_closings FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_monthly_closing_items FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_initializations FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.inventory_initialization_items FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_arrivals FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_arrival_lines FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_arrival_matches FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_arrival_match_serials FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_arrival_stage_cancellations FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_serial_entries FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.receiving_inventory_allocations FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.material_receipts FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.material_receipt_serials FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()));
CREATE POLICY procurement_read ON public.project_materials FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()) AND delivery_destination = 'OFFICE');
CREATE POLICY procurement_read ON public.project_material_batches FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()) AND EXISTS (
  SELECT 1 FROM public.project_materials m
  WHERE m.batch_id = project_material_batches.id AND m.delivery_destination = 'OFFICE'
));
CREATE POLICY procurement_read ON public.se_supply_records FOR SELECT TO authenticated
USING ((SELECT app_private.is_procurement_member()) AND (
  receiving_only OR EXISTS (
    SELECT 1 FROM public.receiving_inventory_allocations a
    WHERE a.se_supply_record_id = se_supply_records.id
  )
));

-- Project names are reference labels; the Projects table itself stays denied.
CREATE OR REPLACE FUNCTION public.get_procurement_project_labels()
RETURNS TABLE (id uuid, name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT app_private.is_procurement_member() THEN
    RAISE EXCEPTION 'Procurement role required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT p.id, p.project_name FROM public.projects p
  WHERE p.id IN (
    SELECT t.project_id FROM public.inventory_transactions t WHERE t.project_id IS NOT NULL
    UNION SELECT a.project_id FROM public.receiving_arrivals a WHERE a.project_id IS NOT NULL
    UNION SELECT m.project_id FROM public.project_materials m
      WHERE m.delivery_destination = 'OFFICE' AND m.project_id IS NOT NULL
    UNION SELECT s.project_id FROM public.se_supply_records s
      WHERE s.receiving_only AND s.project_id IS NOT NULL
  );
END $$;
REVOKE ALL ON FUNCTION public.get_procurement_project_labels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_procurement_project_labels() TO authenticated;

-- Receiving history only needs actor names, not team member profiles.
CREATE OR REPLACE FUNCTION public.get_procurement_actor_labels()
RETURNS TABLE (id uuid, name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT app_private.is_procurement_member() THEN
    RAISE EXCEPTION 'Procurement role required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT m.id, m.name FROM public.team_members m WHERE m.id IN (
    SELECT a.created_by FROM public.receiving_arrivals a
    UNION SELECT c.created_by FROM public.receiving_arrival_stage_cancellations c
  );
END $$;
REVOKE ALL ON FUNCTION public.get_procurement_actor_labels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_procurement_actor_labels() TO authenticated;

-- These legacy invoker RPCs mutate material and schedule rows. Require an
-- editor explicitly, so a read-only caller gets a permission error.
CREATE OR REPLACE FUNCTION public.reschedule_material_receipt_group(p_schedule_task_id uuid, p_expected_delivery_at timestamp with time zone)
 RETURNS SETOF schedule_tasks
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_task public.schedule_tasks%ROWTYPE;
    v_batch public.project_material_batches%ROWTYPE;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN
  RAISE EXCEPTION 'Editor role required' USING ERRCODE='42501';
 END IF;
    IF p_expected_delivery_at IS NULL THEN RAISE EXCEPTION 'Receipt group time is required' USING ERRCODE = '23502'; END IF;
    SELECT * INTO v_task FROM public.schedule_tasks WHERE id = p_schedule_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt schedule not found' USING ERRCODE = 'P0002'; END IF;
    IF v_task.source_material_batch_id IS NULL OR v_task.source_material_receipt_at IS NULL
       OR lower(btrim(replace(v_task.task_type, chr(12288), ' '))) <> lower('收料') THEN
        RAISE EXCEPTION 'Schedule is not linked to a receipt-time group' USING ERRCODE = '23514';
    END IF;
    IF v_task.status = '取消' OR v_task.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Cancelled receipt schedule cannot be rescheduled' USING ERRCODE = '23514'; END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = v_task.source_material_batch_id FOR UPDATE;

    UPDATE public.schedule_tasks
    SET status = '取消', updated_at = now()
    WHERE source_material_batch_id = v_batch.id
      AND source_material_receipt_at = p_expected_delivery_at
      AND id <> p_schedule_task_id
      AND status IS DISTINCT FROM '取消' AND status IS DISTINCT FROM '完成'
      AND status IS DISTINCT FROM '已完成' AND deleted_at IS NULL;

    IF v_task.source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at THEN
        UPDATE public.project_material_batches SET planned_receipt_at = p_expected_delivery_at, updated_at = now() WHERE id = v_batch.id;
    ELSE
        UPDATE public.project_materials
        SET expected_delivery_at = CASE WHEN p_expected_delivery_at IS NOT DISTINCT FROM v_batch.planned_receipt_at THEN NULL ELSE p_expected_delivery_at END,
            updated_at = now()
        WHERE batch_id = v_batch.id AND procurement_status <> 'RECEIVED' AND received_at IS NULL
          AND expected_delivery_at IS NOT DISTINCT FROM v_task.source_material_receipt_at;
    END IF;

    UPDATE public.schedule_tasks
    SET source_material_receipt_at = p_expected_delivery_at,
        task_date = (p_expected_delivery_at AT TIME ZONE 'Asia/Taipei')::date,
        start_time = (p_expected_delivery_at AT TIME ZONE 'Asia/Taipei')::time,
        is_all_day = false, updated_at = now()
    WHERE id = p_schedule_task_id;
    RETURN QUERY SELECT task.* FROM public.schedule_tasks AS task WHERE task.id = p_schedule_task_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_material_batch_same_day(p_batch_id uuid, p_same_day_delivery boolean)
 RETURNS SETOF project_material_batches
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_batch public.project_material_batches%ROWTYPE;
    v_keep_task_id uuid;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN
  RAISE EXCEPTION 'Editor role required' USING ERRCODE='42501';
 END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Material receipt batch not found' USING ERRCODE = 'P0002'; END IF;
    IF v_batch.received_at IS NOT NULL THEN RAISE EXCEPTION 'Completed material receipt batch cannot be changed' USING ERRCODE = '23514'; END IF;

    IF p_same_day_delivery THEN
        SELECT task.id INTO v_keep_task_id
        FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = p_batch_id
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
        ORDER BY (task.source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at) DESC, task.created_at, task.id
        LIMIT 1 FOR UPDATE;

        UPDATE public.schedule_tasks
        SET status = '取消', updated_at = now()
        WHERE source_material_batch_id = p_batch_id
          AND id IS DISTINCT FROM v_keep_task_id
          AND lower(btrim(replace(task_type, chr(12288), ' '))) = lower('收料')
          AND status IS DISTINCT FROM '取消' AND status IS DISTINCT FROM '完成'
          AND status IS DISTINCT FROM '已完成' AND deleted_at IS NULL;

        IF v_keep_task_id IS NOT NULL AND v_batch.planned_receipt_at IS NOT NULL THEN
            UPDATE public.schedule_tasks
            SET source_material_receipt_at = v_batch.planned_receipt_at,
                task_date = (v_batch.planned_receipt_at AT TIME ZONE 'Asia/Taipei')::date,
                start_time = (v_batch.planned_receipt_at AT TIME ZONE 'Asia/Taipei')::time,
                is_all_day = false, updated_at = now()
            WHERE id = v_keep_task_id;
        ELSIF v_keep_task_id IS NOT NULL THEN
            UPDATE public.schedule_tasks SET status = '取消', updated_at = now() WHERE id = v_keep_task_id;
        END IF;

        UPDATE public.project_materials
        SET expected_delivery_at = NULL, updated_at = now()
        WHERE batch_id = p_batch_id AND procurement_status <> 'RECEIVED' AND received_at IS NULL;
    END IF;

    UPDATE public.project_material_batches
    SET same_day_delivery = p_same_day_delivery, updated_at = now()
    WHERE id = p_batch_id;
    RETURN QUERY SELECT batch.* FROM public.project_material_batches AS batch WHERE batch.id = p_batch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_material_receipt_override(p_material_id uuid, p_expected_delivery_at timestamp with time zone)
 RETURNS SETOF project_materials
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_material public.project_materials%ROWTYPE;
    v_batch public.project_material_batches%ROWTYPE;
    v_old_effective timestamptz;
    v_new_override timestamptz;
    v_new_effective timestamptz;
    v_old_task_id uuid;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN
  RAISE EXCEPTION 'Editor role required' USING ERRCODE='42501';
 END IF;
    SELECT * INTO v_material FROM public.project_materials WHERE id = p_material_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project material not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = v_material.batch_id FOR UPDATE;
    IF v_batch.same_day_delivery THEN RAISE EXCEPTION 'Same-day batches must edit the batch receipt default' USING ERRCODE = '23514'; END IF;
    IF v_material.procurement_status = 'RECEIVED' OR v_material.received_at IS NOT NULL THEN RAISE EXCEPTION 'Received material cannot be rescheduled' USING ERRCODE = '23514'; END IF;

    v_old_effective := COALESCE(v_material.expected_delivery_at, v_batch.planned_receipt_at);
    v_new_override := CASE WHEN p_expected_delivery_at IS NOT DISTINCT FROM v_batch.planned_receipt_at THEN NULL ELSE p_expected_delivery_at END;
    v_new_effective := COALESCE(v_new_override, v_batch.planned_receipt_at);
    UPDATE public.project_materials SET expected_delivery_at = v_new_override, updated_at = now() WHERE id = p_material_id;

    IF v_old_effective IS DISTINCT FROM v_new_effective AND NOT EXISTS (
        SELECT 1 FROM public.project_materials AS material
        WHERE material.batch_id = v_batch.id AND material.id <> p_material_id
          AND material.procurement_status <> 'RECEIVED' AND material.received_at IS NULL
          AND COALESCE(material.expected_delivery_at, v_batch.planned_receipt_at) IS NOT DISTINCT FROM v_old_effective
    ) THEN
        SELECT task.id INTO v_old_task_id FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = v_batch.id
          AND task.source_material_receipt_at IS NOT DISTINCT FROM v_old_effective
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
        ORDER BY task.created_at, task.id LIMIT 1 FOR UPDATE;
        IF v_old_task_id IS NOT NULL THEN
            IF v_new_effective IS NULL OR EXISTS (
                SELECT 1 FROM public.schedule_tasks AS task
                WHERE task.source_material_batch_id = v_batch.id
                  AND task.source_material_receipt_at IS NOT DISTINCT FROM v_new_effective
                  AND task.id <> v_old_task_id
                  AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
                  AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
            ) THEN
                UPDATE public.schedule_tasks SET status = '取消', updated_at = now() WHERE id = v_old_task_id;
            ELSE
                UPDATE public.schedule_tasks
                SET source_material_receipt_at = v_new_effective,
                    task_date = (v_new_effective AT TIME ZONE 'Asia/Taipei')::date,
                    start_time = (v_new_effective AT TIME ZONE 'Asia/Taipei')::time,
                    is_all_day = false, updated_at = now()
                WHERE id = v_old_task_id;
            END IF;
        END IF;
    END IF;
    RETURN QUERY SELECT material.* FROM public.project_materials AS material WHERE material.id = p_material_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_material_receipt_plan(p_batch_id uuid, p_planned_receipt_at timestamp with time zone)
 RETURNS SETOF project_material_batches
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_batch public.project_material_batches%ROWTYPE;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN
  RAISE EXCEPTION 'Editor role required' USING ERRCODE='42501';
 END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Material receipt batch not found' USING ERRCODE = 'P0002'; END IF;
    IF v_batch.received_at IS NOT NULL THEN RAISE EXCEPTION 'Completed material receipt batch cannot be rescheduled' USING ERRCODE = '23514'; END IF;
    IF p_planned_receipt_at IS NULL AND EXISTS (
        SELECT 1 FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = p_batch_id
          AND task.source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
    ) THEN RAISE EXCEPTION 'A scheduled receipt requires a planned receipt time' USING ERRCODE = '23514'; END IF;

    IF p_planned_receipt_at IS NOT NULL THEN
        UPDATE public.schedule_tasks AS target
        SET status = '取消', updated_at = now()
        WHERE target.source_material_batch_id = p_batch_id
          AND target.source_material_receipt_at = p_planned_receipt_at
          AND target.source_material_receipt_at IS DISTINCT FROM v_batch.planned_receipt_at
          AND lower(btrim(replace(target.task_type, chr(12288), ' '))) = lower('收料')
          AND target.status IS DISTINCT FROM '取消' AND target.status IS DISTINCT FROM '完成'
          AND target.status IS DISTINCT FROM '已完成' AND target.deleted_at IS NULL;
    END IF;

    UPDATE public.project_material_batches
    SET planned_receipt_at = p_planned_receipt_at, updated_at = now()
    WHERE id = p_batch_id;

    IF p_planned_receipt_at IS NOT NULL THEN
        UPDATE public.schedule_tasks
        SET source_material_receipt_at = p_planned_receipt_at,
            task_date = (p_planned_receipt_at AT TIME ZONE 'Asia/Taipei')::date,
            start_time = (p_planned_receipt_at AT TIME ZONE 'Asia/Taipei')::time,
            is_all_day = false, updated_at = now()
        WHERE source_material_batch_id = p_batch_id
          AND source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at
          AND lower(btrim(replace(task_type, chr(12288), ' '))) = lower('收料')
          AND status IS DISTINCT FROM '取消' AND status IS DISTINCT FROM '完成'
          AND status IS DISTINCT FROM '已完成' AND deleted_at IS NULL;
    END IF;

    RETURN QUERY SELECT batch.* FROM public.project_material_batches AS batch WHERE batch.id = p_batch_id;
END;
$function$;
-- Read-only receiving projections admit Procurement after a role check.
CREATE OR REPLACE FUNCTION app_private.source_details_before_handoff(p_source_type text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 IF NOT COALESCE((app_private.is_active_member() OR app_private.is_procurement_member()),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF p_source_type NOT IN ('SE_SUPPLY','PROJECT_MATERIAL') OR p_source_type IS NULL THEN RAISE EXCEPTION 'Invalid source'; END IF;
 WITH receipts AS (SELECT * FROM public.material_receipts WHERE (p_source_type='PROJECT_MATERIAL' AND project_material_id=p_source_id) OR (p_source_type='SE_SUPPLY' AND se_supply_record_id=p_source_id)),
 entries AS (SELECT * FROM public.receiving_serial_entries WHERE (p_source_type='PROJECT_MATERIAL' AND project_material_id=p_source_id) OR (p_source_type='SE_SUPPLY' AND se_supply_record_id=p_source_id)),
 allocations AS (SELECT a.* FROM public.receiving_inventory_allocations a JOIN receipts r ON r.id=a.office_receipt_id)
 SELECT jsonb_build_object(
 'inventoryItem',(SELECT to_jsonb(i) FROM public.inventory_items i WHERE i.id=CASE WHEN p_source_type='SE_SUPPLY' THEN (SELECT inventory_item_id FROM public.se_supply_records WHERE id=p_source_id) ELSE (SELECT inventory_item_id FROM public.project_materials WHERE id=p_source_id) END),
 'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY received_at DESC) FROM receipts r),'[]'),
 'links',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.material_receipt_serials l JOIN receipts r ON r.id=l.receipt_id),'[]'),
 'entries',COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM entries e),'[]'),
 'allocations',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY created_at) FROM allocations a),'[]'),
 'serials',COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.inventory_serials s WHERE s.id IN(SELECT inventory_serial_id FROM entries)),'[]'),
 'seRecords',COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.se_supply_records s WHERE s.id IN(SELECT se_supply_record_id FROM allocations) OR (NOT s.receiving_only AND s.inventory_serial_id IN(SELECT inventory_serial_id FROM entries))),'[]'),
 'siteReceipts',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.material_receipts r WHERE r.id IN(SELECT site_receipt_id FROM allocations)),'[]'),
 'materials',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.project_materials m WHERE m.id IN(SELECT project_material_id FROM allocations)),'[]')
 ) INTO result;
 RETURN result;
END $function$;
CREATE OR REPLACE FUNCTION public.get_receiving_pending_fulfilment(p_project_material_id uuid DEFAULT NULL::uuid, p_se_supply_record_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE source jsonb; total numeric; fulfilled numeric;
 cancellation jsonb; active boolean; state text; kind text; source_id uuid;
BEGIN
 IF NOT COALESCE((app_private.is_active_member() OR app_private.is_procurement_member()),false)
 THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF num_nonnulls(p_project_material_id,p_se_supply_record_id)<>1
 THEN RAISE EXCEPTION 'One pending source required'; END IF;
 source_id:=COALESCE(p_project_material_id,p_se_supply_record_id);
 kind:=CASE WHEN p_project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END;
 IF p_project_material_id IS NOT NULL THEN
  SELECT to_jsonb(m) INTO source FROM public.project_materials m
   WHERE id=p_project_material_id AND delivery_destination='OFFICE';
 ELSE
  SELECT to_jsonb(s) INTO source FROM public.se_supply_records s
   WHERE id=p_se_supply_record_id AND receiving_only;
 END IF;
 IF source IS NULL THEN RAISE EXCEPTION 'Pending not found'; END IF;
 total:=(source->>'quantity')::numeric;
 SELECT COALESCE(sum(m.quantity),0) INTO fulfilled
 FROM public.receiving_arrival_matches m
 JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id
 JOIN public.receiving_arrivals a ON a.id=l.arrival_id
 WHERE m.cancelled_at IS NULL AND a.voided_at IS NULL
  AND l.resolution_state IN ('STAGED','POSTED')
  AND (m.project_material_id=p_project_material_id OR m.se_supply_record_id=p_se_supply_record_id);
 SELECT changes->'after' INTO cancellation FROM public.activity_logs
  WHERE action='PENDING_REMAINING_CANCELLED' AND target_id=source_id::text
   AND changes->'after'->>'source_type'=kind
  ORDER BY created_at DESC,id DESC LIMIT 1;
 active:=source->>'receiving_archived_at' IS NULL AND source->>'cancelled_at' IS NULL
  AND COALESCE(source->>'procurement_status','')<>'RECEIVED' AND total>fulfilled;
 state:=CASE WHEN cancellation IS NOT NULL THEN 'CANCELLED'
  WHEN total<=fulfilled THEN 'FULFILLED' WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END;
 RETURN jsonb_build_object('quantity',total,'expected',total,'fulfilled',fulfilled,
  'physical_arrived',fulfilled,
  'remaining',total-fulfilled,'remaining_status',state,'active',active,'cancellation',cancellation);
END $function$;
CREATE OR REPLACE FUNCTION public.get_receiving_handoff_scope(p_receipt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 IF NOT COALESCE((app_private.is_active_member() OR app_private.is_procurement_member()),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 RETURN app_private.receiving_handoff_scope(p_receipt_id);
END $function$;
CREATE OR REPLACE FUNCTION public.get_receiving_source_details(p_source_type text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE rid uuid; scope jsonb;
BEGIN
 IF NOT COALESCE((app_private.is_active_member() OR app_private.is_procurement_member()),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF p_source_type IS DISTINCT FROM 'ARRIVAL' THEN RETURN app_private.source_details_before_handoff(p_source_type,p_source_id); END IF;
 SELECT receipt_id INTO rid FROM public.receiving_arrival_lines WHERE id=p_source_id;
 scope:=app_private.receiving_handoff_scope(rid);
 RETURN jsonb_build_object('scope',scope,
  'inventoryItem',(SELECT to_jsonb(i) FROM public.inventory_items i WHERE id=(scope->>'item_id')::uuid),
  'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM public.material_receipts r WHERE id=rid OR reversal_of_id=rid),
  'entries',(SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]') FROM public.receiving_serial_entries e WHERE arrival_line_id=p_source_id),
  'links',(SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') FROM public.material_receipt_serials x WHERE receipt_id=rid),
  'allocations',scope->'allocations',
  'serials',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM public.inventory_serials s WHERE id IN(SELECT inventory_serial_id FROM public.receiving_serial_entries WHERE arrival_line_id=p_source_id)),
  'seRecords',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM public.se_supply_records s WHERE id IN(SELECT se_supply_record_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=rid)),
  'materials',(SELECT COALESCE(jsonb_agg(to_jsonb(m)),'[]') FROM public.project_materials m WHERE id IN(SELECT project_material_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=rid)),
  'siteReceipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM public.material_receipts r WHERE id IN(SELECT site_receipt_id FROM public.receiving_inventory_allocations WHERE office_receipt_id=rid)));
END $function$;
