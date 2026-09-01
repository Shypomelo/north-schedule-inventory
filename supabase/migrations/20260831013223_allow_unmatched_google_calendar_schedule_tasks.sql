-- Google Calendar activities may be imported before a project is confirmed.
-- Dropping NOT NULL is backwards-compatible with all existing schedule rows.
ALTER TABLE public.schedule_tasks
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN project_name DROP NOT NULL;
