-- UI Integration LOOP 2. Candidate first. The owner identity below is the
-- already protected member from 20260820163251_protect_owner_team_member.sql.
CREATE TABLE app_private.system_owner_identity (
  member_id uuid PRIMARY KEY REFERENCES public.team_members(id) ON DELETE RESTRICT,
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  established_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_private.system_owner_identity FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_member uuid; v_auth uuid;
BEGIN
  SELECT m.id INTO v_member FROM public.team_members m
  WHERE m.id = '65916798-f0ec-4d41-8b17-785c4189bd83'::uuid
    AND lower(btrim(m.email)) = 'shypomelo@gmail.com'
    AND lower(m.role) = 'admin' AND m.is_active AND m.deleted_at IS NULL;
  SELECT a.id INTO v_auth FROM auth.users a
  WHERE lower(a.email) = 'shypomelo@gmail.com';
  -- A fresh schema replay has no user rows. A partially provisioned or
  -- mismatched environment must stop rather than infer another owner.
  IF v_member IS NULL AND v_auth IS NULL THEN RETURN; END IF;
  IF v_member IS NULL OR v_auth IS NULL THEN
    RAISE EXCEPTION 'Protected system owner identity is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.team_members'::regclass
      AND tgname = 'protect_owner_team_member' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Protected system owner trigger is unavailable';
  END IF;
  INSERT INTO app_private.system_owner_identity(member_id, auth_user_id)
  VALUES (v_member, v_auth);
END $$;

CREATE FUNCTION app_private.is_system_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_private.system_owner_identity identity
    JOIN public.team_members member ON member.id = identity.member_id
    WHERE identity.auth_user_id = auth.uid()
      AND member.is_active AND member.deleted_at IS NULL
      AND lower(member.role) = 'admin'
  );
$$;
REVOKE ALL ON FUNCTION app_private.is_system_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.is_system_owner() TO authenticated;

CREATE FUNCTION public.is_system_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT app_private.is_system_owner();
$$;
REVOKE ALL ON FUNCTION public.is_system_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_system_owner() TO authenticated;

-- The canonical initializer is already a security-definer wrapper. Change only
-- its entry check; its existing inventory algorithm and data remain untouched.
CREATE OR REPLACE FUNCTION public.initialize_inventory(items jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT COALESCE(app_private.is_system_owner(), false) THEN
    RAISE EXCEPTION 'System owner required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.inventory_items ORDER BY id FOR UPDATE;
  RETURN app_private.initialize_inventory(items);
END $$;
REVOKE ALL ON FUNCTION public.initialize_inventory(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.initialize_inventory(jsonb) TO authenticated;

-- Keep the detailed preview algorithm intact behind an owner-only wrapper.
ALTER FUNCTION public.preview_inventory_initialization(jsonb) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.preview_inventory_initialization(jsonb)
  FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.preview_inventory_initialization(items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT COALESCE(app_private.is_system_owner(), false) THEN
    RAISE EXCEPTION 'System owner required' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.preview_inventory_initialization(items);
END $$;
REVOKE ALL ON FUNCTION public.preview_inventory_initialization(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_inventory_initialization(jsonb) TO authenticated;

-- Existing shared tools have no trustworthy creator field. Leave them NULL;
-- old PERSONAL ownership remains private, and old shared content is admin-managed.
ALTER TABLE public.tool_links
  ADD COLUMN created_by_member_id uuid REFERENCES public.team_members(id) ON DELETE RESTRICT;
CREATE INDEX tool_links_creator_idx ON public.tool_links(created_by_member_id)
  WHERE created_by_member_id IS NOT NULL;

CREATE FUNCTION app_private.guard_tool_link_creator() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_member uuid := app_private.current_member_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_member IS NULL THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
    NEW.created_by_member_id := v_member;
  ELSIF NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id THEN
    RAISE EXCEPTION 'Tool creator is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.scope = 'PERSONAL' AND NEW.created_by_member_id IS NOT NULL
      AND NEW.owner_member_id IS DISTINCT FROM NEW.created_by_member_id THEN
    RAISE EXCEPTION 'Personal tool owner mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.created_by_member_id IS NULL
      AND (NEW.scope IS DISTINCT FROM OLD.scope OR NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id) THEN
    RAISE EXCEPTION 'Legacy tool ownership requires separate review' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_tool_link_creator() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_tool_link_creator BEFORE INSERT OR UPDATE ON public.tool_links
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_tool_link_creator();

DROP POLICY tool_links_read ON public.tool_links;
DROP POLICY tool_links_insert ON public.tool_links;
DROP POLICY tool_links_update ON public.tool_links;
DROP POLICY tool_links_delete ON public.tool_links;
CREATE POLICY tool_links_read ON public.tool_links FOR SELECT TO authenticated USING (
  (SELECT app_private.is_normal_toolbox_member()) AND (
    (scope='PERSONAL' AND owner_member_id=(SELECT app_private.current_member_id())) OR
    (scope='DEPARTMENT' AND (
      (SELECT app_private.is_admin_member()) OR EXISTS (
        SELECT 1 FROM public.member_work_groups membership
        WHERE membership.member_id=(SELECT app_private.current_member_id())
          AND membership.work_group_id=tool_links.work_group_id
      )
    )) OR scope='GLOBAL'
  )
);
CREATE POLICY tool_links_insert ON public.tool_links FOR INSERT TO authenticated WITH CHECK (
  (SELECT app_private.is_normal_toolbox_member())
  AND created_by_member_id=(SELECT app_private.current_member_id())
  AND (
    (scope='PERSONAL' AND owner_member_id=(SELECT app_private.current_member_id())) OR
    (scope='DEPARTMENT' AND EXISTS (
      SELECT 1 FROM public.member_work_groups membership
      WHERE membership.member_id=(SELECT app_private.current_member_id())
        AND membership.work_group_id=tool_links.work_group_id
    )) OR
    (scope='DEPARTMENT' AND (SELECT app_private.is_admin_member())) OR scope='GLOBAL'
  )
);
CREATE POLICY tool_links_update ON public.tool_links FOR UPDATE TO authenticated
USING ((SELECT app_private.is_normal_toolbox_member()) AND (
  created_by_member_id=(SELECT app_private.current_member_id()) OR
  (created_by_member_id IS NULL AND scope='PERSONAL'
    AND owner_member_id=(SELECT app_private.current_member_id())) OR
  ((SELECT app_private.is_admin_member()) AND scope<>'PERSONAL')
))
WITH CHECK ((SELECT app_private.is_normal_toolbox_member()) AND (
  created_by_member_id=(SELECT app_private.current_member_id()) OR
  (created_by_member_id IS NULL AND scope='PERSONAL'
    AND owner_member_id=(SELECT app_private.current_member_id())) OR
  ((SELECT app_private.is_admin_member()) AND scope<>'PERSONAL')
) AND (
  scope='GLOBAL' OR
  (scope='PERSONAL' AND owner_member_id=(SELECT app_private.current_member_id())) OR
  (scope='DEPARTMENT' AND ((SELECT app_private.is_admin_member()) OR EXISTS (
    SELECT 1 FROM public.member_work_groups membership
    WHERE membership.member_id=(SELECT app_private.current_member_id())
      AND membership.work_group_id=tool_links.work_group_id
  )))
));
CREATE POLICY tool_links_delete ON public.tool_links FOR DELETE TO authenticated USING (
  (SELECT app_private.is_normal_toolbox_member()) AND (
    created_by_member_id=(SELECT app_private.current_member_id()) OR
    (created_by_member_id IS NULL AND scope='PERSONAL'
      AND owner_member_id=(SELECT app_private.current_member_id())) OR
    ((SELECT app_private.is_admin_member()) AND scope<>'PERSONAL')
  )
);

CREATE TABLE public.tool_link_personal_order (
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  tool_link_id uuid NOT NULL REFERENCES public.tool_links(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, tool_link_id)
);
CREATE INDEX tool_link_personal_order_member_position_idx
  ON public.tool_link_personal_order(member_id, position);
ALTER TABLE public.tool_link_personal_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tool_link_personal_order FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tool_link_personal_order TO authenticated;
CREATE POLICY tool_link_personal_order_read ON public.tool_link_personal_order
  FOR SELECT TO authenticated USING (
    (SELECT app_private.is_normal_toolbox_member())
    AND member_id=(SELECT app_private.current_member_id())
  );

CREATE FUNCTION public.reorder_my_tool_links(p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_member uuid := app_private.current_member_id(); v_visible uuid[];
BEGIN
  IF v_member IS NULL OR NOT app_private.is_normal_toolbox_member() THEN
    RAISE EXCEPTION 'Active member required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tool-order:'||v_member::text,0));
  SELECT coalesce(array_agg(link.id ORDER BY link.id),'{}'::uuid[]) INTO v_visible
  FROM public.tool_links link WHERE
    (link.scope='PERSONAL' AND link.owner_member_id=v_member) OR
    (link.scope='GLOBAL') OR
    (link.scope='DEPARTMENT' AND (app_private.is_admin_member() OR EXISTS (
      SELECT 1 FROM public.member_work_groups membership
      WHERE membership.member_id=v_member AND membership.work_group_id=link.work_group_id
    )));
  IF p_ids IS NULL OR cardinality(p_ids)<>cardinality(v_visible)
    OR cardinality(p_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
    OR (SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) FROM unnest(p_ids) id) IS DISTINCT FROM v_visible THEN
    RAISE EXCEPTION 'Tool visibility changed; reload before sorting' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.tool_link_personal_order(member_id,tool_link_id,position,updated_at)
  SELECT v_member,id,ordinality::integer,now() FROM unnest(p_ids) WITH ORDINALITY AS item(id,ordinality)
  ON CONFLICT (member_id,tool_link_id) DO UPDATE
    SET position=EXCLUDED.position,updated_at=now();
  DELETE FROM public.tool_link_personal_order
  WHERE member_id=v_member AND NOT(tool_link_id=ANY(p_ids));
END $$;
REVOKE ALL ON FUNCTION public.reorder_my_tool_links(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_my_tool_links(uuid[]) TO authenticated;

-- A single order ledger references the existing canonical rows; it carries
-- no duplicate task content or progress status.
CREATE TABLE public.project_work_item_positions (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('MILESTONE','CONSTRUCTION')),
  item_id uuid NOT NULL,
  position bigint NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_kind,item_id)
);
CREATE INDEX project_work_item_positions_project_idx
  ON public.project_work_item_positions(project_id,position);
ALTER TABLE public.project_work_item_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_work_item_positions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.project_work_item_positions TO authenticated;
CREATE POLICY project_work_item_positions_read ON public.project_work_item_positions
  FOR SELECT TO authenticated USING ((SELECT app_private.is_active_member()));

INSERT INTO public.project_work_item_positions(project_id,item_kind,item_id,position)
SELECT project_id,item_kind,item_id,
  row_number() OVER (PARTITION BY project_id ORDER BY group_order,source_order,created_at,item_id)*100
FROM (
  SELECT project_id,'MILESTONE'::text item_kind,id item_id,0 group_order,
    sort_order source_order,created_at FROM public.project_milestones
  UNION ALL
  SELECT project_id,'CONSTRUCTION',id,1,sort_order,created_at
    FROM public.project_construction_progress
) existing_items;

CREATE FUNCTION app_private.seed_project_work_item_position() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text := CASE TG_TABLE_NAME WHEN 'project_milestones' THEN 'MILESTONE'
  ELSE 'CONSTRUCTION' END; v_position bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('project-item-order:'||NEW.project_id::text,0));
  SELECT coalesce(max(position),0)+100 INTO v_position
    FROM public.project_work_item_positions WHERE project_id=NEW.project_id;
  INSERT INTO public.project_work_item_positions(project_id,item_kind,item_id,position)
    VALUES (NEW.project_id,v_kind,NEW.id,v_position);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.seed_project_work_item_position()
  FROM PUBLIC,anon,authenticated;
CREATE TRIGGER seed_milestone_position AFTER INSERT ON public.project_milestones
  FOR EACH ROW EXECUTE FUNCTION app_private.seed_project_work_item_position();
CREATE TRIGGER seed_construction_position AFTER INSERT ON public.project_construction_progress
  FOR EACH ROW EXECUTE FUNCTION app_private.seed_project_work_item_position();

CREATE FUNCTION public.reorder_project_work_items(p_project_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_expected text[]; v_received text[]; v_updated integer;
BEGIN
  IF NOT app_private.is_editor_member() THEN
    RAISE EXCEPTION 'Editor required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order must be an array' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('project-item-order:'||p_project_id::text,0));
  SELECT coalesce(array_agg(item_kind||':'||item_id::text ORDER BY item_kind,item_id),'{}'::text[])
    INTO v_expected FROM (
      SELECT 'MILESTONE'::text item_kind,id item_id FROM public.project_milestones
        WHERE project_id=p_project_id AND deleted_at IS NULL AND archived_at IS NULL
          AND milestone_key<>'SITE_ENTRY'
      UNION ALL
      SELECT 'CONSTRUCTION',id FROM public.project_construction_progress
        WHERE project_id=p_project_id AND deleted_at IS NULL
          AND status_override IS DISTINCT FROM 'disabled'
    ) active_items;
  SELECT coalesce(array_agg(item->>'kind'||':'||item->>'id' ORDER BY item->>'kind',item->>'id'),'{}'::text[])
    INTO v_received FROM jsonb_array_elements(p_items) item;
  IF cardinality(v_expected)<>cardinality(v_received)
    OR cardinality(v_received)<>(SELECT count(DISTINCT item) FROM unnest(v_received) item)
    OR v_expected IS DISTINCT FROM v_received THEN
    RAISE EXCEPTION 'Project items changed; reload before sorting' USING ERRCODE='40001';
  END IF;
  UPDATE public.project_work_item_positions position_row
  SET position=ordered.ordinality*100,updated_at=now()
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS ordered(item,ordinality)
  WHERE position_row.project_id=p_project_id
    AND position_row.item_kind=ordered.item->>'kind'
    AND position_row.item_id=(ordered.item->>'id')::uuid;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated<>cardinality(v_expected) THEN
    RAISE EXCEPTION 'Project order rows missing' USING ERRCODE='40001';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.reorder_project_work_items(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reorder_project_work_items(uuid,jsonb) TO authenticated;

-- General milestones get their own contractor relation, while construction
-- contractor columns remain unchanged.
ALTER TABLE public.project_milestones
  ADD COLUMN contractor_id uuid REFERENCES public.contractors(id) ON DELETE SET NULL,
  ADD COLUMN contractor_name text;
CREATE FUNCTION app_private.set_milestone_contractor_name() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.contractor_id IS NULL THEN NEW.contractor_name := NULL;
  ELSE
    SELECT name INTO STRICT NEW.contractor_name FROM public.contractors
      WHERE id=NEW.contractor_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.set_milestone_contractor_name() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER set_milestone_contractor_name BEFORE INSERT OR UPDATE OF contractor_id
  ON public.project_milestones FOR EACH ROW
  EXECUTE FUNCTION app_private.set_milestone_contractor_name();

-- Equipment registration is one canonical milestone, independent of meter.
-- Add a template step for future projects and an incomplete row for each
-- already initialized project. Existing business dates and statuses are kept.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_workflow_templates template
    WHERE template.is_active AND NOT EXISTS (
      SELECT 1 FROM public.project_workflow_template_steps step
      WHERE step.template_id=template.id AND step.step_key='METER_INSTALLATION'
    )
  ) THEN RAISE EXCEPTION 'Active workflow template lacks meter step'; END IF;
END $$;
INSERT INTO public.project_workflow_template_steps
  (template_id,step_key,label,phase_id,type_id,sort_order,default_is_applicable,is_active)
SELECT meter.template_id,'EQUIPMENT_REGISTRATION','設備登記',meter.phase_id,
  meter.type_id,meter.sort_order+1,true,true
FROM public.project_workflow_template_steps meter
WHERE meter.step_key='METER_INSTALLATION'
ON CONFLICT (template_id,step_key) DO NOTHING;

INSERT INTO public.project_milestones
  (workflow_instance_id,project_id,origin,source_template_step_id,milestone_key,
   label,source_phase_id,phase_key_snapshot,phase_name_snapshot,
   source_type_id,type_key_snapshot,type_name_snapshot,sort_order,is_applicable,status)
SELECT instance.id,instance.project_id,'TEMPLATE',step.id,step.step_key,step.label,
  phase.id,phase.phase_key,phase.name,workflow_type.id,workflow_type.type_key,
  workflow_type.name,step.sort_order,true,'NOT_STARTED'
FROM public.project_workflow_instances instance
JOIN public.project_workflow_template_steps step
  ON step.template_id=instance.source_template_id AND step.step_key='EQUIPMENT_REGISTRATION'
JOIN public.project_workflow_phases phase ON phase.id=step.phase_id
JOIN public.project_workflow_types workflow_type ON workflow_type.id=step.type_id
WHERE instance.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM public.project_milestones existing
  WHERE existing.workflow_instance_id=instance.id
    AND existing.milestone_key='EQUIPMENT_REGISTRATION' AND existing.deleted_at IS NULL
)
ON CONFLICT (workflow_instance_id,source_template_step_id)
  WHERE origin='TEMPLATE' AND deleted_at IS NULL DO NOTHING;

CREATE FUNCTION app_private.guard_milestone_actual_date() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.milestone_key IN ('METER_INSTALLATION','EQUIPMENT_REGISTRATION')
    AND NEW.actual_date > (now() AT TIME ZONE 'Asia/Taipei')::date THEN
    RAISE EXCEPTION 'Actual completion cannot be in the future' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_milestone_actual_date() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_milestone_actual_date BEFORE INSERT OR UPDATE OF status,actual_date
  ON public.project_milestones FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_milestone_actual_date();

-- Table-wide activity SELECT is OWNER-only. Narrow read RPCs preserve task,
-- transaction, and own dashboard history without reopening the whole table.
DROP POLICY IF EXISTS "Enable read access for active members" ON public.activity_logs;
CREATE POLICY activity_logs_owner_read ON public.activity_logs FOR SELECT
  TO authenticated USING ((SELECT app_private.is_system_owner()));

CREATE FUNCTION public.read_activity_logs(
  p_kind text,p_target_id text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS SETOF public.activity_logs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_member uuid := app_private.current_member_id();
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Invalid activity limit' USING ERRCODE='22023';
  END IF;
  IF p_kind='ALL' THEN
    IF NOT app_private.is_system_owner() THEN
      RAISE EXCEPTION 'System owner required' USING ERRCODE='42501';
    END IF;
    RETURN QUERY SELECT log.* FROM public.activity_logs log
      ORDER BY log.created_at DESC,log.id DESC LIMIT p_limit;
  ELSIF p_kind='SELF' THEN
    IF v_member IS NULL THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT log.* FROM public.activity_logs log
      WHERE log.actor_user_id=v_member::text OR log.user_id=v_member::text
      ORDER BY log.created_at DESC,log.id DESC LIMIT p_limit;
  ELSIF p_kind='SCHEDULE' THEN
    IF v_member IS NULL OR p_target_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.schedule_tasks task WHERE task.id::text=p_target_id
    ) THEN RAISE EXCEPTION 'Schedule not accessible' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT log.* FROM public.activity_logs log
      WHERE log.target_type='ScheduleTask' AND log.target_id=p_target_id
        AND (app_private.is_admin_member() OR COALESCE(log.action_type,log.action)<>'DELETE_TASK')
      ORDER BY log.created_at DESC,log.id DESC LIMIT p_limit;
  ELSIF p_kind='SCHEDULE_DELETED' THEN
    IF NOT app_private.is_admin_member() THEN
      RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT log.* FROM public.activity_logs log
      WHERE log.target_type='ScheduleTask'
        AND COALESCE(log.action_type,log.action)='DELETE_TASK'
      ORDER BY log.created_at DESC,log.id DESC LIMIT p_limit;
  ELSIF p_kind='INVENTORY_TRANSACTION' THEN
    IF NOT (app_private.is_active_member() OR app_private.is_procurement_member())
      OR p_target_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.inventory_transactions tx WHERE tx.id::text=p_target_id
    ) THEN RAISE EXCEPTION 'Transaction not accessible' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT log.* FROM public.activity_logs log
      WHERE log.target_type='INVENTORY_TRANSACTION' AND log.target_id=p_target_id
      ORDER BY log.created_at DESC,log.id DESC LIMIT p_limit;
  ELSE
    RAISE EXCEPTION 'Unknown activity scope' USING ERRCODE='22023';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.read_activity_logs(text,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_activity_logs(text,text,integer) TO authenticated;

NOTIFY pgrst,'reload schema';
