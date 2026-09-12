ALTER TABLE public.work_items
  ADD COLUMN project_label text;

ALTER TABLE public.work_items
  ADD CONSTRAINT work_items_project_label_not_blank
  CHECK (project_label IS NULL OR btrim(project_label) <> '');

UPDATE public.work_items AS item
SET project_label = project.project_name
FROM public.projects AS project
WHERE item.project_id = project.id
  AND item.project_label IS NULL;

CREATE OR REPLACE FUNCTION app_private.normalize_work_item_project_label()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT project.project_name INTO NEW.project_label
    FROM public.projects AS project
    WHERE project.id = NEW.project_id;
  ELSE
    NEW.project_label := NULLIF(btrim(NEW.project_label), '');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.normalize_work_item_project_label() FROM PUBLIC;

CREATE TRIGGER work_items_normalize_project_label
BEFORE INSERT OR UPDATE OF project_id, project_label ON public.work_items
FOR EACH ROW EXECUTE FUNCTION app_private.normalize_work_item_project_label();

CREATE OR REPLACE FUNCTION public.promote_private_todo_to_work_item(
  p_todo_id uuid,
  p_work_zone_id uuid,
  p_project_id uuid,
  p_project_label text,
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
    owner_member_id, project_id, project_label, work_zone_id, title, content,
    source_todo_id, source_created_at, received_at,
    expected_start_date, due_date
  )
  VALUES (
    v_member_id, p_project_id, p_project_label, p_work_zone_id, v_todo.title, v_todo.content,
    v_todo.id, v_todo.created_at, v_todo.received_at,
    p_expected_start_date, p_due_date
  )
  RETURNING * INTO v_result;
  RETURN v_result;
END;
$$;

ALTER FUNCTION public.promote_private_todo_to_work_item(uuid, uuid, uuid, text, date, date)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.promote_private_todo_to_work_item(uuid, uuid, uuid, text, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_private_todo_to_work_item(uuid, uuid, uuid, text, date, date)
  TO authenticated;

COMMENT ON COLUMN public.work_items.project_label IS
  'Display label for a linked canonical project or an unlinked custom project name.';
COMMENT ON FUNCTION public.promote_private_todo_to_work_item(uuid, uuid, uuid, text, date, date) IS
  'Promotes an owned private Todo while preserving either canonical project linkage or a custom project label.';

NOTIFY pgrst, 'reload schema';
