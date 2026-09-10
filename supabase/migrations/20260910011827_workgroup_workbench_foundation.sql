-- Work Group + Office Workbench DB contract foundation.
-- Candidate migration only: do not apply directly to Production.

CREATE TABLE public.work_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  google_calendar_sync_enabled boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_groups_key_unique UNIQUE (key),
  CONSTRAINT work_groups_key_canonical CHECK (key = upper(key) AND key ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT work_groups_name_not_blank CHECK (btrim(name) <> '')
);

INSERT INTO public.work_groups (key, name, google_calendar_sync_enabled, is_active, sort_order)
VALUES ('ENGINEERING', '工程', true, true, 10),
       ('PROJECT', '專案設計', false, true, 20)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    google_calendar_sync_enabled = EXCLUDED.google_calendar_sync_enabled,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

CREATE TABLE public.member_work_groups (
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  work_group_id uuid NOT NULL REFERENCES public.work_groups(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, work_group_id)
);
CREATE UNIQUE INDEX member_work_groups_one_default_per_member
  ON public.member_work_groups (member_id) WHERE is_default;
CREATE INDEX member_work_groups_group_member_idx
  ON public.member_work_groups (work_group_id, member_id);

ALTER TABLE public.schedule_tasks ADD COLUMN work_group_id uuid;
ALTER TABLE public.schedule_tasks ADD CONSTRAINT schedule_tasks_work_group_id_fkey
  FOREIGN KEY (work_group_id) REFERENCES public.work_groups(id) ON DELETE RESTRICT;
UPDATE public.schedule_tasks
SET work_group_id = (SELECT id FROM public.work_groups WHERE key = 'ENGINEERING')
WHERE work_group_id IS NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schedule_tasks WHERE work_group_id IS NULL) THEN
    RAISE EXCEPTION 'schedule_tasks work_group_id backfill incomplete';
  END IF;
END
$$;
ALTER TABLE public.schedule_tasks ALTER COLUMN work_group_id SET NOT NULL;
CREATE INDEX schedule_tasks_work_group_date_status_idx
  ON public.schedule_tasks (work_group_id, task_date, status);

ALTER TABLE public.todos ADD COLUMN work_group_id uuid, ADD COLUMN received_at timestamptz;
ALTER TABLE public.todos ADD CONSTRAINT todos_work_group_id_fkey
  FOREIGN KEY (work_group_id) REFERENCES public.work_groups(id) ON DELETE RESTRICT;
UPDATE public.todos
SET work_group_id = (SELECT id FROM public.work_groups WHERE key = 'ENGINEERING')
WHERE scope = 'TEAM' AND work_group_id IS NULL;
UPDATE public.todos SET work_group_id = NULL WHERE scope = 'PRIVATE';
UPDATE public.todos SET received_at = created_at WHERE received_at IS NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.todos
    WHERE received_at IS NULL
       OR (scope = 'TEAM' AND work_group_id IS NULL)
       OR (scope = 'PRIVATE' AND work_group_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'todos work-group or received-at backfill incomplete';
  END IF;
END
$$;
ALTER TABLE public.todos
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL;
ALTER TABLE public.todos
  DROP CONSTRAINT IF EXISTS todos_status_check,
  DROP CONSTRAINT IF EXISTS todos_private_contract_check,
  DROP CONSTRAINT IF EXISTS todos_stored_status_scope_check,
  DROP CONSTRAINT IF EXISTS todos_work_group_scope_check;
ALTER TABLE public.todos
  ADD CONSTRAINT todos_status_check CHECK (
    status IN ('待安排', '已排程', '已完成', '取消', '已退件')
    OR (scope = 'PRIVATE' AND status = '已收納')
  ),
  ADD CONSTRAINT todos_private_contract_check CHECK (
    scope <> 'PRIVATE'
    OR (
      created_by IS NOT NULL
      AND project_id IS NULL AND task_type IS NULL
      AND assigned_to IS NULL AND assigned_by IS NULL
      AND converted_task_id IS NULL
      AND rejected_by IS NULL AND rejected_at IS NULL
      AND rejection_reason IS NULL
      AND work_group_id IS NULL
      AND status IN ('待安排', '已收納', '已完成')
    )
  ),
  ADD CONSTRAINT todos_stored_status_scope_check CHECK (
    status <> '已收納' OR scope = 'PRIVATE'
  ),
  ADD CONSTRAINT todos_work_group_scope_check CHECK (
    (scope = 'TEAM' AND work_group_id IS NOT NULL)
    OR (scope = 'PRIVATE' AND work_group_id IS NULL)
  );
CREATE INDEX todos_team_work_group_status_created_idx
  ON public.todos (work_group_id, status, created_at DESC) WHERE scope = 'TEAM';
DO $$
BEGIN
  IF EXISTS (
    SELECT converted_task_id FROM public.todos WHERE converted_task_id IS NOT NULL
    GROUP BY converted_task_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate todos.converted_task_id values exist';
  END IF;
END
$$;
CREATE UNIQUE INDEX todos_converted_task_id_unique
  ON public.todos (converted_task_id) WHERE converted_task_id IS NOT NULL;

CREATE TABLE public.work_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  name text NOT NULL,
  sort_order integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_zones_owner_id_unique UNIQUE (id, owner_member_id),
  CONSTRAINT work_zones_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT work_zones_sort_order_positive CHECK (sort_order > 0)
);
CREATE UNIQUE INDEX work_zones_active_sort_unique
  ON public.work_zones (owner_member_id, sort_order) WHERE is_active;
CREATE INDEX work_zones_owner_active_order_idx
  ON public.work_zones (owner_member_id, is_active, sort_order);

CREATE TABLE public.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  work_zone_id uuid NOT NULL,
  title text NOT NULL,
  content text,
  source_todo_id uuid REFERENCES public.todos(id) ON DELETE RESTRICT,
  source_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  expected_start_date date,
  due_date date,
  status text NOT NULL DEFAULT '待處理',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_items_zone_owner_fkey
    FOREIGN KEY (work_zone_id, owner_member_id)
    REFERENCES public.work_zones(id, owner_member_id) ON DELETE RESTRICT,
  CONSTRAINT work_items_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT work_items_status_check CHECK (status IN ('待處理', '進行中', '已完成')),
  CONSTRAINT work_items_source_pair_check CHECK (
    (source_todo_id IS NULL AND source_created_at IS NULL)
    OR (source_todo_id IS NOT NULL AND source_created_at IS NOT NULL)
  ),
  CONSTRAINT work_items_completed_consistency_check CHECK (
    (status = '已完成' AND completed_at IS NOT NULL)
    OR (status <> '已完成' AND completed_at IS NULL)
  )
);
CREATE UNIQUE INDEX work_items_source_todo_id_unique
  ON public.work_items (source_todo_id) WHERE source_todo_id IS NOT NULL;
CREATE INDEX work_items_owner_zone_status_due_idx
  ON public.work_items (owner_member_id, work_zone_id, status, due_date);
CREATE INDEX work_items_zone_owner_idx ON public.work_items (work_zone_id, owner_member_id);
CREATE INDEX work_items_project_id_idx ON public.work_items (project_id) WHERE project_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.set_workbench_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.set_workbench_updated_at() FROM PUBLIC;
CREATE TRIGGER work_groups_set_updated_at BEFORE UPDATE ON public.work_groups
FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();
CREATE TRIGGER member_work_groups_set_updated_at BEFORE UPDATE ON public.member_work_groups
FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();
CREATE TRIGGER work_zones_set_updated_at BEFORE UPDATE ON public.work_zones
FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();
CREATE TRIGGER work_items_set_updated_at BEFORE UPDATE ON public.work_items
FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();

CREATE OR REPLACE FUNCTION app_private.enforce_active_work_zone_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_owner_member_id uuid;
  v_active_count integer;
BEGIN
  v_owner_member_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.owner_member_id ELSE NEW.owner_member_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner_member_id::text, 0));
  SELECT count(*) INTO v_active_count
  FROM public.work_zones
  WHERE owner_member_id = v_owner_member_id AND is_active;
  IF v_active_count > 3 THEN
    RAISE EXCEPTION 'member % cannot have more than 3 active work zones (found %)',
      v_owner_member_id, v_active_count USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_private.enforce_active_work_zone_limit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER work_zones_active_limit_guard
AFTER INSERT OR UPDATE OR DELETE ON public.work_zones
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.enforce_active_work_zone_limit();

CREATE OR REPLACE FUNCTION app_private.prepare_work_item_todo_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_todo public.todos;
BEGIN
  IF NEW.source_todo_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT todo.* INTO v_todo
  FROM public.todos AS todo
  WHERE todo.id = NEW.source_todo_id
    AND todo.scope = 'PRIVATE'
    AND todo.created_by = NEW.owner_member_id
    AND todo.status = '待安排'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible private Todo source not found'
      USING ERRCODE = '23514';
  END IF;

  NEW.source_created_at := v_todo.created_at;
  NEW.received_at := v_todo.received_at;

  UPDATE public.todos
  SET status = '已收納', updated_at = now()
  WHERE id = v_todo.id;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.prepare_work_item_todo_provenance() FROM PUBLIC;
CREATE TRIGGER work_items_prepare_todo_provenance
BEFORE INSERT ON public.work_items
FOR EACH ROW EXECUTE FUNCTION app_private.prepare_work_item_todo_provenance();

CREATE OR REPLACE FUNCTION app_private.protect_work_item_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id
     OR NEW.source_todo_id IS DISTINCT FROM OLD.source_todo_id
     OR NEW.source_created_at IS DISTINCT FROM OLD.source_created_at THEN
    RAISE EXCEPTION 'work item owner and source provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.protect_work_item_provenance() FROM PUBLIC;
CREATE TRIGGER work_items_provenance_guard BEFORE UPDATE ON public.work_items
FOR EACH ROW EXECUTE FUNCTION app_private.protect_work_item_provenance();

ALTER TABLE public.work_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_work_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.work_groups FROM anon, authenticated;
REVOKE ALL ON public.member_work_groups FROM anon, authenticated;
REVOKE ALL ON public.work_zones FROM anon, authenticated;
REVOKE ALL ON public.work_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.work_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_work_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_zones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_items TO authenticated;

CREATE POLICY work_groups_active_read ON public.work_groups FOR SELECT TO authenticated
USING (
  ((SELECT app_private.is_active_member()) AND is_active)
  OR (SELECT app_private.is_admin_member())
);
CREATE POLICY work_groups_admin_insert ON public.work_groups FOR INSERT TO authenticated
WITH CHECK ((SELECT app_private.is_admin_member()));
CREATE POLICY work_groups_admin_update ON public.work_groups FOR UPDATE TO authenticated
USING ((SELECT app_private.is_admin_member()))
WITH CHECK ((SELECT app_private.is_admin_member()));
CREATE POLICY member_work_groups_active_read ON public.member_work_groups FOR SELECT TO authenticated
USING (
  (SELECT app_private.is_admin_member())
  OR (
    (SELECT app_private.is_active_member())
    AND EXISTS (
      SELECT 1 FROM public.work_groups wg
      WHERE wg.id = work_group_id AND wg.is_active
    )
  )
);
CREATE POLICY member_work_groups_admin_insert ON public.member_work_groups
FOR INSERT TO authenticated WITH CHECK ((SELECT app_private.is_admin_member()));
CREATE POLICY member_work_groups_admin_update ON public.member_work_groups
FOR UPDATE TO authenticated
USING ((SELECT app_private.is_admin_member()))
WITH CHECK ((SELECT app_private.is_admin_member()));
CREATE POLICY member_work_groups_admin_delete ON public.member_work_groups
FOR DELETE TO authenticated USING ((SELECT app_private.is_admin_member()));

CREATE POLICY work_zones_owner_select ON public.work_zones FOR SELECT TO authenticated
USING (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_zones_owner_insert ON public.work_zones FOR INSERT TO authenticated
WITH CHECK (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_zones_owner_update ON public.work_zones FOR UPDATE TO authenticated
USING (owner_member_id = (SELECT app_private.current_member_id()))
WITH CHECK (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_zones_owner_delete ON public.work_zones FOR DELETE TO authenticated
USING (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_items_owner_select ON public.work_items FOR SELECT TO authenticated
USING (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_items_owner_insert ON public.work_items FOR INSERT TO authenticated
WITH CHECK (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_items_owner_update ON public.work_items FOR UPDATE TO authenticated
USING (owner_member_id = (SELECT app_private.current_member_id()))
WITH CHECK (owner_member_id = (SELECT app_private.current_member_id()));
CREATE POLICY work_items_owner_delete ON public.work_items FOR DELETE TO authenticated
USING (owner_member_id = (SELECT app_private.current_member_id()));

CREATE OR REPLACE FUNCTION public.promote_private_todo_to_work_item(
  p_todo_id uuid,
  p_work_zone_id uuid,
  p_project_id uuid DEFAULT NULL,
  p_expected_start_date date DEFAULT NULL,
  p_due_date date DEFAULT NULL
)
RETURNS public.work_items
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_todo public.todos;
  v_result public.work_items;
BEGIN
  v_member_id := app_private.current_member_id();
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'active member context required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_todo FROM public.todos
  WHERE id = p_todo_id
    AND scope = 'PRIVATE'
    AND created_by = v_member_id
    AND status = '待安排'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible private todo not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.work_zones
  WHERE id = p_work_zone_id
    AND owner_member_id = v_member_id
    AND is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible work zone not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.work_items (
    owner_member_id, project_id, work_zone_id, title, content,
    source_todo_id, source_created_at, received_at,
    expected_start_date, due_date
  )
  VALUES (
    v_member_id, p_project_id, p_work_zone_id, v_todo.title, v_todo.content,
    v_todo.id, v_todo.created_at, v_todo.received_at,
    p_expected_start_date, p_due_date
  )
  RETURNING * INTO v_result;
  RETURN v_result;
END;
$$;
ALTER FUNCTION public.promote_private_todo_to_work_item(uuid, uuid, uuid, date, date)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.promote_private_todo_to_work_item(
  uuid, uuid, uuid, date, date
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_private_todo_to_work_item(
  uuid, uuid, uuid, date, date
) TO authenticated;

COMMENT ON TABLE public.work_groups IS
  'Assignment and schedule-sync classification; not a data segregation boundary.';
COMMENT ON TABLE public.member_work_groups IS
  'Member-to-work-group assignment metadata; not an authorization boundary.';
COMMENT ON TABLE public.work_zones IS
  'Owner-private Office Workbench zones. DB permits 0-3 active zones; completed configuration requires 2-3.';
COMMENT ON TABLE public.work_items IS
  'Owner-private Office Workbench items with immutable Todo provenance.';
COMMENT ON COLUMN public.todos.received_at IS
  'Stable intake timestamp; historical rows inherit created_at.';
COMMENT ON FUNCTION public.promote_private_todo_to_work_item(uuid, uuid, uuid, date, date) IS
  'Atomically promotes an owned pending PRIVATE Todo into an owned active Work Zone.';
NOTIFY pgrst, 'reload schema';
