ALTER TABLE public.todos
  ADD COLUMN scope text NOT NULL DEFAULT 'TEAM';

ALTER TABLE public.todos
  ADD CONSTRAINT todos_scope_check
    CHECK (scope IN ('TEAM', 'PRIVATE')),
  ADD CONSTRAINT todos_private_contract_check
    CHECK (
      scope = 'TEAM'
      OR (
        created_by IS NOT NULL
        AND project_id IS NULL
        AND task_type IS NULL
        AND assigned_to IS NULL
        AND assigned_by IS NULL
        AND converted_task_id IS NULL
        AND rejected_by IS NULL
        AND rejected_at IS NULL
        AND rejection_reason IS NULL
        AND status IN ('待安排', '已完成')
      )
    );

COMMENT ON COLUMN public.todos.scope IS
  'TEAM rows are shared schedule todos; PRIVATE rows are visible and mutable only by their creator.';

CREATE OR REPLACE FUNCTION app_private.current_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
  SELECT member.id
  FROM public.team_members AS member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL
  ORDER BY member.id
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION app_private.current_member_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.current_member_id() TO authenticated;

DROP POLICY IF EXISTS "Enable read access for active members" ON public.todos;
DROP POLICY IF EXISTS "Enable insert access for editor members" ON public.todos;
DROP POLICY IF EXISTS "Enable update access for editor members" ON public.todos;
DROP POLICY IF EXISTS "Enable delete access for editor members" ON public.todos;

CREATE POLICY "Active members can read team todos"
ON public.todos FOR SELECT
TO authenticated
USING (
  (SELECT app_private.is_active_member())
  AND scope = 'TEAM'
);

CREATE POLICY "Creators can read private todos"
ON public.todos FOR SELECT
TO authenticated
USING (
  (SELECT app_private.is_active_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Editors can insert team todos"
ON public.todos FOR INSERT
TO authenticated
WITH CHECK (
  (SELECT app_private.is_editor_member())
  AND scope = 'TEAM'
);

CREATE POLICY "Editors can insert their private todos"
ON public.todos FOR INSERT
TO authenticated
WITH CHECK (
  (SELECT app_private.is_editor_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Editors can update team todos"
ON public.todos FOR UPDATE
TO authenticated
USING (
  (SELECT app_private.is_editor_member())
  AND scope = 'TEAM'
)
WITH CHECK (
  (SELECT app_private.is_editor_member())
  AND scope = 'TEAM'
);

CREATE POLICY "Editors can update their private todos"
ON public.todos FOR UPDATE
TO authenticated
USING (
  (SELECT app_private.is_editor_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
)
WITH CHECK (
  (SELECT app_private.is_editor_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Editors can delete team todos"
ON public.todos FOR DELETE
TO authenticated
USING (
  (SELECT app_private.is_editor_member())
  AND scope = 'TEAM'
);

CREATE POLICY "Editors can delete their private todos"
ON public.todos FOR DELETE
TO authenticated
USING (
  (SELECT app_private.is_editor_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
);

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
  IF TG_OP = 'INSERT' AND NEW.scope = 'PRIVATE' THEN
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND (OLD.scope = 'PRIVATE' OR NEW.scope = 'PRIVATE') THEN
    RETURN NEW;
  END IF;

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
    AND todo.scope = 'TEAM'
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
    AND scope = 'TEAM'
  RETURNING * INTO target_todo;

  RETURN target_todo;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reject_todo(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reject_todo(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_todo(uuid, text) TO authenticated;
