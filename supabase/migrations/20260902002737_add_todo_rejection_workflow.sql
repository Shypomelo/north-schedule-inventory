-- The production app previously kept todos only in the browser mock store.
-- Create the missing shared table and reuse activity_logs for immutable history.
CREATE TABLE IF NOT EXISTS public.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (btrim(title) <> ''),
  content text,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  task_type text,
  status text NOT NULL DEFAULT '待安排'
    CHECK (status IN ('待安排', '已排程', '已完成', '取消', '已退件')),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  converted_task_id uuid REFERENCES public.schedule_tasks(id) ON DELETE SET NULL,
  rejected_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT todos_rejection_fields_consistent CHECK (
    status <> '已退件'
    OR (
      rejected_by IS NOT NULL
      AND rejected_at IS NOT NULL
      AND btrim(COALESCE(rejection_reason, '')) <> ''
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_todos_assigned_to_status
  ON public.todos (assigned_to, status);

CREATE INDEX IF NOT EXISTS idx_todos_created_by
  ON public.todos (created_by);

ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated;
REVOKE ALL ON public.todos FROM anon;

DROP POLICY IF EXISTS "Enable read access for active members" ON public.todos;
CREATE POLICY "Enable read access for active members"
ON public.todos FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

DROP POLICY IF EXISTS "Enable insert access for editor members" ON public.todos;
CREATE POLICY "Enable insert access for editor members"
ON public.todos FOR INSERT
TO authenticated
WITH CHECK ((SELECT app_private.is_editor_member()));

DROP POLICY IF EXISTS "Enable update access for editor members" ON public.todos;
CREATE POLICY "Enable update access for editor members"
ON public.todos FOR UPDATE
TO authenticated
USING ((SELECT app_private.is_editor_member()))
WITH CHECK ((SELECT app_private.is_editor_member()));

DROP POLICY IF EXISTS "Enable delete access for editor members" ON public.todos;
CREATE POLICY "Enable delete access for editor members"
ON public.todos FOR DELETE
TO authenticated
USING ((SELECT app_private.is_editor_member()));

CREATE OR REPLACE FUNCTION app_private.set_todo_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor_id uuid;
BEGIN
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

DROP TRIGGER IF EXISTS set_todo_updated_at ON public.todos;
CREATE TRIGGER set_todo_updated_at
BEFORE UPDATE ON public.todos
FOR EACH ROW
EXECUTE FUNCTION app_private.set_todo_updated_at();

CREATE OR REPLACE FUNCTION app_private.log_todo_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor record;
  event_action text;
  event_message text;
  assigned_name text;
BEGIN
  SELECT member.id, member.name
  INTO actor
  FROM public.team_members member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL
  LIMIT 1;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.activity_logs (
      action, target_type, target_id, description, changes,
      user_id, user_name, actor_user_id, actor_name, action_type,
      target_label, project_id, before_value, after_value, message
    ) VALUES (
      'CREATE_TODO', 'Todo', NEW.id::text, '建立待辦',
      jsonb_build_object('before', NULL, 'after', to_jsonb(NEW)),
      COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
      COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
      'CREATE_TODO', NEW.title, NEW.project_id::text, NULL, NEW.status, '建立待辦'
    );

    IF NEW.assigned_to IS NOT NULL THEN
      SELECT name INTO assigned_name
      FROM public.team_members
      WHERE id = NEW.assigned_to;

      INSERT INTO public.activity_logs (
        action, target_type, target_id, description, changes,
        user_id, user_name, actor_user_id, actor_name, action_type,
        target_label, project_id, before_value, after_value, message
      ) VALUES (
        'ASSIGN_TODO', 'Todo', NEW.id::text, '指派待辦',
        jsonb_build_object('before', NULL, 'after', NEW.assigned_to),
        COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
        COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
        'ASSIGN_TODO', NEW.title, NEW.project_id::text, NULL, NEW.assigned_to::text,
        format('指派給 %s', COALESCE(assigned_name, '未知人員'))
      );
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status = '已退件' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_action := 'REJECT_TODO';
    event_message := format('退件原因：%s', NEW.rejection_reason);
  ELSIF OLD.status = '已退件' AND NEW.status = '待安排' THEN
    event_action := 'REASSIGN_TODO';
    SELECT name INTO assigned_name FROM public.team_members WHERE id = NEW.assigned_to;
    event_message := format('修改後重新指派給 %s', COALESCE(assigned_name, '未指派'));
  ELSIF NEW.status = '已完成' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_action := 'COMPLETE_TODO';
    event_message := '完成待辦';
  ELSIF NEW.status = '取消' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_action := 'VOID_TODO';
    event_message := '作廢待辦';
  ELSIF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    event_action := 'ASSIGN_TODO';
    SELECT name INTO assigned_name FROM public.team_members WHERE id = NEW.assigned_to;
    event_message := format('指派給 %s', COALESCE(assigned_name, '未指派'));
  ELSE
    event_action := 'UPDATE_TODO';
    event_message := '修改待辦';
  END IF;

  INSERT INTO public.activity_logs (
    action, target_type, target_id, description, changes,
    user_id, user_name, actor_user_id, actor_name, action_type,
    target_label, project_id, before_value, after_value, message
  ) VALUES (
    event_action, 'Todo', NEW.id::text, event_message,
    jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW)),
    COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
    COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
    event_action, NEW.title, NEW.project_id::text, OLD.status, NEW.status, event_message
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.log_todo_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS log_todo_history ON public.todos;
CREATE TRIGGER log_todo_history
AFTER INSERT OR UPDATE ON public.todos
FOR EACH ROW
EXECUTE FUNCTION app_private.log_todo_history();

CREATE OR REPLACE FUNCTION public.reject_todo(p_todo_id uuid, p_reason text)
RETURNS public.todos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor_id uuid;
  target_todo public.todos;
BEGIN
  IF NOT app_private.is_editor_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION '退件原因不可空白'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT member.id
  INTO actor_id
  FROM public.team_members member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL
  LIMIT 1;

  SELECT todo.*
  INTO target_todo
  FROM public.todos todo
  WHERE todo.id = p_todo_id
  FOR UPDATE;

  IF target_todo.id IS NULL THEN
    RAISE EXCEPTION '找不到待辦';
  END IF;

  IF target_todo.assigned_to IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION '只有被指派人可以退件'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF target_todo.status <> '待安排' THEN
    RAISE EXCEPTION '只有待安排的待辦可以退件'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.todos
  SET status = '已退件',
      rejected_by = actor_id,
      rejected_at = now(),
      rejection_reason = btrim(p_reason)
  WHERE id = p_todo_id
  RETURNING * INTO target_todo;

  RETURN target_todo;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reject_todo(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reject_todo(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_todo(uuid, text) TO authenticated;
