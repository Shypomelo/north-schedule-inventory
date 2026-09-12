\set ON_ERROR_STOP on

BEGIN;

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA app_private;

CREATE TABLE public.projects (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.todos (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  content text,
  scope text NOT NULL,
  status text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE public.work_zones (
  id uuid PRIMARY KEY,
  owner_member_id uuid NOT NULL,
  is_active boolean NOT NULL
);

CREATE TABLE public.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_member_id uuid NOT NULL,
  project_id uuid REFERENCES public.projects(id),
  work_zone_id uuid NOT NULL,
  title text NOT NULL,
  content text,
  source_todo_id uuid,
  source_created_at timestamptz,
  received_at timestamptz NOT NULL,
  expected_start_date date,
  due_date date
);

CREATE OR REPLACE FUNCTION app_private.current_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $$;

INSERT INTO public.projects (id, name)
VALUES ('20000000-0000-4000-8000-000000000001', '正式案場');

INSERT INTO public.work_items (
  id, owner_member_id, project_id, work_zone_id, title, received_at
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '既有工作',
  now()
);

\ir ../migrations/20260912020803_add_work_item_project_label.sql

DO $$
BEGIN
  IF (SELECT project_label FROM public.work_items WHERE id = '30000000-0000-4000-8000-000000000001') <> '正式案場' THEN
    RAISE EXCEPTION 'linked row was not backfilled with canonical project name';
  END IF;
END;
$$;

INSERT INTO public.work_items (
  id, owner_member_id, project_id, project_label, work_zone_id, title, received_at
) VALUES (
  '30000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  NULL,
  '  臨時勘查點  ',
  '40000000-0000-4000-8000-000000000001',
  '自訂案場工作',
  now()
);

DO $$
BEGIN
  IF (SELECT project_id IS NOT NULL OR project_label <> '臨時勘查點' FROM public.work_items WHERE id = '30000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'custom project label was not normalized as an unlinked value';
  END IF;
END;
$$;

UPDATE public.work_items
SET project_id = '20000000-0000-4000-8000-000000000001',
    project_label = 'not canonical'
WHERE id = '30000000-0000-4000-8000-000000000002';

DO $$
BEGIN
  IF (SELECT project_label FROM public.work_items WHERE id = '30000000-0000-4000-8000-000000000002') <> '正式案場' THEN
    RAISE EXCEPTION 'official link did not enforce canonical project name';
  END IF;
END;
$$;

INSERT INTO public.work_zones (id, owner_member_id, is_active)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  true
);

INSERT INTO public.todos (
  id, title, content, scope, status, created_by, created_at, received_at
) VALUES (
  '50000000-0000-4000-8000-000000000001',
  '來源待辦',
  NULL,
  'PRIVATE',
  '待安排',
  '10000000-0000-4000-8000-000000000001',
  '2026-09-11T08:00:00+08:00',
  '2026-09-12T08:00:00+08:00'
);

SELECT public.promote_private_todo_to_work_item(
  '50000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  NULL,
  '客製案場',
  '2026-09-13',
  '2026-09-14'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.work_items
    WHERE source_todo_id = '50000000-0000-4000-8000-000000000001'
      AND project_id IS NULL
      AND project_label = '客製案場'
      AND received_at = '2026-09-12T08:00:00+08:00'
      AND expected_start_date = '2026-09-13'
      AND due_date = '2026-09-14'
  ) THEN
    RAISE EXCEPTION 'promotion did not preserve custom project label and canonical dates';
  END IF;
END;
$$;

ROLLBACK;
