ALTER TABLE public.schedule_tasks
  ADD COLUMN created_by_user_id uuid
    REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN created_by_name text,
  ADD COLUMN creation_source text NOT NULL DEFAULT 'LEGACY';

ALTER TABLE public.schedule_tasks
  ADD CONSTRAINT schedule_tasks_creation_source_check
  CHECK (creation_source IN ('APP', 'GOOGLE_IMPORT', 'SYSTEM', 'LEGACY'));

CREATE INDEX schedule_tasks_created_by_user_id_idx
  ON public.schedule_tasks (created_by_user_id);

CREATE INDEX schedule_tasks_creation_source_idx
  ON public.schedule_tasks (creation_source);

CREATE OR REPLACE FUNCTION app_private.preserve_schedule_task_creation_metadata()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.created_by_user_id := OLD.created_by_user_id;
  NEW.created_by_name := OLD.created_by_name;
  NEW.creation_source := OLD.creation_source;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preserve_schedule_task_creation_metadata
BEFORE UPDATE OF created_by_user_id, created_by_name, creation_source
ON public.schedule_tasks
FOR EACH ROW
EXECUTE FUNCTION app_private.preserve_schedule_task_creation_metadata();

COMMENT ON COLUMN public.schedule_tasks.created_by_user_id IS
  'Team member who created the task when that identity can be established safely.';
COMMENT ON COLUMN public.schedule_tasks.created_by_name IS
  'Immutable display-name snapshot captured when the task is created.';
COMMENT ON COLUMN public.schedule_tasks.creation_source IS
  'Creation origin: APP, GOOGLE_IMPORT, SYSTEM, or LEGACY for pre-migration rows.';

NOTIFY pgrst, 'reload schema';
