-- Run only against an empty, disposable LOCAL PostgreSQL database as postgres:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/workgroup-workbench-foundation.sql
-- By default every write rolls back. KEEP_SCHEMA=1 commits the rehearsal once,
-- then verifies provenance again from a subsequent transaction.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'CREATE ROLE anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'CREATE ROLE authenticated';
  END IF;
END
$roles$;
CREATE SCHEMA auth;
CREATE SCHEMA app_private;

CREATE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
AS $$ SELECT current_setting('request.jwt.claims', true)::jsonb $$;

CREATE TABLE public.team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz
);

CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text
);

CREATE TABLE public.schedule_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  task_date date NOT NULL,
  status text NOT NULL
);

CREATE TABLE public.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (btrim(title) <> ''),
  content text,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  task_type text,
  status text NOT NULL DEFAULT '待安排',
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  converted_task_id uuid REFERENCES public.schedule_tasks(id) ON DELETE SET NULL,
  rejected_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL DEFAULT 'TEAM',
  CONSTRAINT todos_status_check
    CHECK (status IN ('待安排', '已排程', '已完成', '取消', '已退件')),
  CONSTRAINT todos_scope_check CHECK (scope IN ('TEAM', 'PRIVATE')),
  CONSTRAINT todos_private_contract_check CHECK (
    scope = 'TEAM'
    OR (
      created_by IS NOT NULL
      AND project_id IS NULL AND task_type IS NULL
      AND assigned_to IS NULL AND assigned_by IS NULL
      AND converted_task_id IS NULL
      AND rejected_by IS NULL AND rejected_at IS NULL
      AND rejection_reason IS NULL
      AND status IN ('待安排', '已完成')
    )
  )
);

CREATE FUNCTION app_private.is_active_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members member
    WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
      AND member.is_active AND member.deleted_at IS NULL
  )
$$;

CREATE FUNCTION app_private.is_editor_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members member
    WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
      AND member.is_active AND member.deleted_at IS NULL
      AND lower(member.role) IN ('admin', 'engineer')
  )
$$;

CREATE FUNCTION app_private.is_admin_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members member
    WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
      AND member.is_active AND member.deleted_at IS NULL
      AND lower(member.role) = 'admin'
  )
$$;

CREATE FUNCTION app_private.current_member_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'pg_catalog'
AS $$
  SELECT member.id FROM public.team_members member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active AND member.deleted_at IS NULL
  ORDER BY member.id LIMIT 1
$$;

REVOKE ALL ON FUNCTION app_private.is_active_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.is_editor_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.is_admin_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.current_member_id() FROM PUBLIC;
GRANT USAGE ON SCHEMA auth, app_private TO authenticated;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.is_active_member() TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.is_editor_member() TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.is_admin_member() TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.current_member_id() TO authenticated;

ALTER TABLE public.schedule_tasks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.schedule_tasks TO authenticated;
CREATE POLICY schedule_tasks_active_select
ON public.schedule_tasks FOR SELECT TO authenticated
USING ((SELECT app_private.is_active_member()));
CREATE POLICY schedule_tasks_editor_insert
ON public.schedule_tasks FOR INSERT TO authenticated
WITH CHECK ((SELECT app_private.is_editor_member()));
CREATE POLICY schedule_tasks_editor_update
ON public.schedule_tasks FOR UPDATE TO authenticated
USING ((SELECT app_private.is_editor_member()))
WITH CHECK ((SELECT app_private.is_editor_member()));

ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated;
CREATE POLICY todos_team_select ON public.todos FOR SELECT TO authenticated
USING ((SELECT app_private.is_active_member()) AND scope = 'TEAM');
CREATE POLICY todos_private_select ON public.todos FOR SELECT TO authenticated
USING (
  (SELECT app_private.is_active_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
);
CREATE POLICY todos_team_insert ON public.todos FOR INSERT TO authenticated
WITH CHECK ((SELECT app_private.is_editor_member()) AND scope = 'TEAM');
CREATE POLICY todos_private_insert ON public.todos FOR INSERT TO authenticated
WITH CHECK (
  (SELECT app_private.is_editor_member())
  AND scope = 'PRIVATE'
  AND created_by = (SELECT app_private.current_member_id())
);
CREATE POLICY todos_team_update ON public.todos FOR UPDATE TO authenticated
USING ((SELECT app_private.is_editor_member()) AND scope = 'TEAM')
WITH CHECK ((SELECT app_private.is_editor_member()) AND scope = 'TEAM');
CREATE POLICY todos_private_update ON public.todos FOR UPDATE TO authenticated
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

INSERT INTO public.team_members (id, name, email, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Admin', 'admin@example.test', 'admin'),
  ('10000000-0000-4000-8000-000000000002', 'Owner One', 'owner1@example.test', 'engineer'),
  ('10000000-0000-4000-8000-000000000003', 'Owner Two', 'owner2@example.test', 'engineer'),
  ('10000000-0000-4000-8000-000000000004', 'Viewer', 'viewer@example.test', 'viewer');
INSERT INTO public.projects (id, name)
VALUES ('20000000-0000-4000-8000-000000000001', 'Project fixture');
INSERT INTO public.schedule_tasks (id, title, task_date, status) VALUES
  ('30000000-0000-4000-8000-000000000001', 'Existing schedule one', DATE '2026-09-10', '待處理'),
  ('30000000-0000-4000-8000-000000000002', 'Existing schedule two', DATE '2026-09-11', '已完成');
INSERT INTO public.todos (
  id, title, scope, status, created_by, assigned_to, assigned_by, created_at
) VALUES (
  '40000000-0000-4000-8000-000000000001', 'Existing team', 'TEAM', '待安排',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  TIMESTAMPTZ '2026-09-01 08:00:00+08'
), (
  '40000000-0000-4000-8000-000000000002', 'Existing private', 'PRIVATE', '待安排',
  '10000000-0000-4000-8000-000000000002', NULL, NULL,
  TIMESTAMPTZ '2026-09-02 09:00:00+08'
);

\ir ../migrations/20260910011827_workgroup_workbench_foundation.sql

CREATE FUNCTION pg_temp.assert_true(value boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RAISE NOTICE 'PASS: %', label;
END
$$;

CREATE FUNCTION pg_temp.statement_fails(statement text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  EXECUTE statement;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END
$$;

CREATE FUNCTION pg_temp.affected_rows(statement text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  affected integer;
BEGIN
  EXECUTE statement;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.statement_fails(text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.affected_rows(text) TO authenticated;

SELECT id AS engineering_id FROM public.work_groups WHERE key = 'ENGINEERING' \gset
SELECT id AS project_group_id FROM public.work_groups WHERE key = 'PROJECT' \gset

SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.work_groups WHERE key IN ('ENGINEERING', 'PROJECT')),
  'ENGINEERING and PROJECT are seeded'
);
SELECT pg_temp.assert_true(
  (SELECT google_calendar_sync_enabled FROM public.work_groups WHERE key = 'ENGINEERING'),
  'ENGINEERING is Google-sync eligible'
);
SELECT pg_temp.assert_true(
  NOT (SELECT google_calendar_sync_enabled FROM public.work_groups WHERE key = 'PROJECT'),
  'PROJECT is not Google-sync eligible'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.schedule_tasks),
  'migration preserves all existing Schedule rows'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.todos),
  'migration preserves all existing Todo rows'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.schedule_tasks
    WHERE work_group_id <> :'engineering_id' OR work_group_id IS NULL
  ),
  'existing schedules backfill to ENGINEERING'
);
SELECT pg_temp.assert_true(
  (SELECT is_nullable = 'NO' FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'schedule_tasks'
     AND column_name = 'work_group_id'),
  'schedule work_group_id is NOT NULL'
);
INSERT INTO public.schedule_tasks (id, title, task_date, status) VALUES (
  '30000000-0000-4000-8000-000000000003',
  'Legacy schedule without group', DATE '2026-09-12', '待處理'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'engineering_id' FROM public.schedule_tasks
   WHERE id = '30000000-0000-4000-8000-000000000003'),
  'new schedule without a work group defaults to ENGINEERING'
);

SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'engineering_id' FROM public.todos
   WHERE id = '40000000-0000-4000-8000-000000000001'),
  'existing TEAM Todo backfills to ENGINEERING'
);
SELECT pg_temp.assert_true(
  (SELECT status = '待安排' FROM public.todos
   WHERE id = '40000000-0000-4000-8000-000000000001'),
  'migration preserves existing Todo status'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id IS NULL FROM public.todos
   WHERE id = '40000000-0000-4000-8000-000000000002'),
  'existing PRIVATE Todo keeps a null work group'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.todos
    WHERE id IN (
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002'
    ) AND received_at IS DISTINCT FROM created_at
  ),
  'existing Todo received_at backfills from created_at'
);

INSERT INTO public.todos (
  id, title, scope, status, created_by, assigned_to, assigned_by, work_group_id
) VALUES (
  '40000000-0000-4000-8000-000000000003', 'New team', 'TEAM', '待安排',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', :'engineering_id'
);
SELECT pg_temp.assert_true(
  (SELECT received_at IS NOT NULL FROM public.todos
   WHERE id = '40000000-0000-4000-8000-000000000003'),
  'new Todo received_at defaults to now'
);

INSERT INTO public.todos (id, title, scope, status, created_by) VALUES
  ('41000000-0000-4000-8000-000000000001', 'Private pending', 'PRIVATE', '待安排',
   '10000000-0000-4000-8000-000000000002'),
  ('41000000-0000-4000-8000-000000000002', 'Private stored', 'PRIVATE', '已收納',
   '10000000-0000-4000-8000-000000000002'),
  ('41000000-0000-4000-8000-000000000003', 'Private complete', 'PRIVATE', '已完成',
   '10000000-0000-4000-8000-000000000002');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM public.todos
   WHERE id IN (
     '41000000-0000-4000-8000-000000000001',
     '41000000-0000-4000-8000-000000000002',
     '41000000-0000-4000-8000-000000000003'
   )),
  'PRIVATE pending, stored, and complete statuses are legal'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, scope, status, created_by, work_group_id) VALUES (''Bad private group'', ''PRIVATE'', ''待安排'', %L, %L)',
  '10000000-0000-4000-8000-000000000002', :'engineering_id'
)), 'PRIVATE Todo rejects a work group');
INSERT INTO public.todos (id, title, scope, status, created_by) VALUES (
  '40000000-0000-4000-8000-000000000004',
  'Legacy team Todo without group', 'TEAM', '待安排',
  '10000000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'engineering_id' FROM public.todos
   WHERE id = '40000000-0000-4000-8000-000000000004'),
  'new TEAM Todo without a work group defaults to ENGINEERING'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, scope, status, created_by, project_id) VALUES (''Bad private project'', ''PRIVATE'', ''待安排'', %L, %L)',
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001'
)), 'PRIVATE Todo rejects TEAM-only fields');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, scope, status, created_by, assigned_to, assigned_by, work_group_id) VALUES (''Bad team stored'', ''TEAM'', ''已收納'', %L, %L, %L, %L)',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', :'engineering_id'
)), 'TEAM Todo rejects the PRIVATE-only stored status');

INSERT INTO public.member_work_groups (member_id, work_group_id, is_default) VALUES
  ('10000000-0000-4000-8000-000000000002', :'engineering_id', true),
  ('10000000-0000-4000-8000-000000000002', :'project_group_id', false);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'UPDATE public.member_work_groups SET is_default = true WHERE member_id = %L AND work_group_id = %L',
  '10000000-0000-4000-8000-000000000002', :'project_group_id'
)), 'member has at most one default work group');

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', 'viewer@example.test')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.work_groups),
  'active member reads active Work Groups'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.member_work_groups),
  'active member reads Work Group membership needed by UI'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.schedule_tasks
   WHERE id IN (
     '30000000-0000-4000-8000-000000000001',
     '30000000-0000-4000-8000-000000000002'
   )),
  'existing Schedule active-member SELECT remains permissive'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.todos
   WHERE id IN (
     '40000000-0000-4000-8000-000000000001',
     '40000000-0000-4000-8000-000000000003'
   )),
  'existing TEAM Todo active-member SELECT remains permissive'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.todos WHERE scope = 'PRIVATE'),
  'existing PRIVATE Todo remains hidden from another member'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.member_work_groups (member_id, work_group_id) VALUES (%L, %L)',
  '10000000-0000-4000-8000-000000000004', :'engineering_id'
)), 'non-admin cannot mutate Work Group membership');
RESET ROLE;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', 'owner1@example.test')::text,
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.schedule_tasks (id, title, task_date, status)
VALUES (
  '31000000-0000-4000-8000-000000000001',
  'Legacy schedule', DATE '2026-09-20', '待處理'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'engineering_id' FROM public.schedule_tasks
   WHERE id = '31000000-0000-4000-8000-000000000001'),
  'legacy Schedule insert defaults to ENGINEERING'
);
INSERT INTO public.schedule_tasks (id, title, task_date, status, work_group_id)
VALUES (
  '31000000-0000-4000-8000-000000000002',
  'Explicit project schedule', DATE '2026-09-21', '待處理', :'project_group_id'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'project_group_id' FROM public.schedule_tasks
   WHERE id = '31000000-0000-4000-8000-000000000002'),
  'explicit PROJECT Schedule is preserved'
);

INSERT INTO public.todos (
  id, title, scope, status, created_by, assigned_to, assigned_by
) VALUES (
  '44000000-0000-4000-8000-000000000001', 'Legacy TEAM Todo', 'TEAM', '待安排',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'engineering_id' FROM public.todos
   WHERE id = '44000000-0000-4000-8000-000000000001'),
  'legacy TEAM Todo insert defaults to ENGINEERING'
);
INSERT INTO public.todos (
  id, title, scope, status, created_by, assigned_to, assigned_by, work_group_id
) VALUES (
  '44000000-0000-4000-8000-000000000002', 'Explicit PROJECT Todo', 'TEAM', '待安排',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', :'project_group_id'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'project_group_id' FROM public.todos
   WHERE id = '44000000-0000-4000-8000-000000000002'),
  'explicit PROJECT TEAM Todo is preserved'
);

INSERT INTO public.todos (id, title, scope, status, created_by)
VALUES (
  '45000000-0000-4000-8000-000000000001', 'Legacy PRIVATE Todo',
  'PRIVATE', '待安排', '10000000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(
  (SELECT work_group_id IS NULL FROM public.todos
   WHERE id = '45000000-0000-4000-8000-000000000001'),
  'legacy PRIVATE Todo keeps a null work group'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, scope, status, created_by, work_group_id) VALUES (''Illegal PRIVATE group'', ''PRIVATE'', ''待安排'', %L, %L)',
  '10000000-0000-4000-8000-000000000002', :'project_group_id'
)), 'explicit PRIVATE work group remains rejected');

UPDATE public.schedule_tasks
SET title = 'Legacy schedule updated', task_date = DATE '2026-09-22'
WHERE id = '31000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT title = 'Legacy schedule updated'
          AND work_group_id = :'engineering_id'
   FROM public.schedule_tasks
   WHERE id = '31000000-0000-4000-8000-000000000001'),
  'legacy Schedule update preserves ENGINEERING'
);
UPDATE public.todos
SET scope = 'TEAM', title = 'Legacy TEAM Todo updated', status = '已完成'
WHERE id = '44000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT title = 'Legacy TEAM Todo updated'
          AND status = '已完成'
          AND work_group_id = :'engineering_id'
   FROM public.todos WHERE id = '44000000-0000-4000-8000-000000000001'),
  'legacy TEAM Todo update preserves ENGINEERING'
);
UPDATE public.todos
SET title = 'Legacy PRIVATE Todo updated', status = '已完成'
WHERE id = '45000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT title = 'Legacy PRIVATE Todo updated'
          AND status = '已完成'
          AND work_group_id IS NULL
   FROM public.todos WHERE id = '45000000-0000-4000-8000-000000000001'),
  'legacy PRIVATE Todo update preserves null work group'
);

INSERT INTO public.todos (
  id, title, scope, status, created_by, assigned_to, assigned_by
) VALUES (
  '44000000-0000-4000-8000-000000000003', 'Legacy conversion Todo', 'TEAM', '待安排',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002'
);
INSERT INTO public.schedule_tasks (id, title, task_date, status)
VALUES (
  '31000000-0000-4000-8000-000000000003',
  'Legacy converted schedule', DATE '2026-09-23', '待處理'
);
UPDATE public.todos
SET scope = 'TEAM', status = '已排程',
    converted_task_id = '31000000-0000-4000-8000-000000000003'
WHERE id = '44000000-0000-4000-8000-000000000003';
SELECT pg_temp.assert_true(
  (SELECT work_group_id = :'engineering_id' FROM public.schedule_tasks
   WHERE id = '31000000-0000-4000-8000-000000000003')
  AND (SELECT work_group_id = :'engineering_id'
              AND converted_task_id = '31000000-0000-4000-8000-000000000003'
       FROM public.todos WHERE id = '44000000-0000-4000-8000-000000000003'),
  'legacy Todo to Schedule conversion remains ENGINEERING-compatible'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.schedule_tasks
    WHERE id IN (
      '31000000-0000-4000-8000-000000000001',
      '31000000-0000-4000-8000-000000000003'
    ) AND work_group_id IS DISTINCT FROM :'engineering_id'
  ),
  'legacy schedules preserve current Google behavior through ENGINEERING fallback'
);
SELECT pg_temp.assert_true(
  (SELECT bool_and(NOT procedure.prosecdef)
   FROM pg_proc AS procedure
   JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = 'app_private'
     AND procedure.proname IN (
       'default_legacy_schedule_work_group',
       'default_legacy_team_todo_work_group'
     )),
  'legacy compatibility triggers are SECURITY INVOKER'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.work_zones),
  'zero active Work Zones is legal before initialization'
);
SET CONSTRAINTS work_zones_active_limit_guard DEFERRED;
INSERT INTO public.work_zones (id, owner_member_id, name, sort_order)
VALUES (
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002', 'Zone A', 1
);
SET CONSTRAINTS work_zones_active_limit_guard IMMEDIATE;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.work_zones),
  'one active Work Zone is legal at DB level'
);
INSERT INTO public.work_zones (id, owner_member_id, name, sort_order)
VALUES (
  '50000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', 'Zone B', 2
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.work_zones),
  'two active Work Zones are legal'
);
INSERT INTO public.work_zones (id, owner_member_id, name, sort_order)
VALUES (
  '50000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000002', 'Zone C', 3
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM public.work_zones),
  'three active Work Zones are legal'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$INSERT INTO public.work_zones (owner_member_id, name, sort_order)
    VALUES ('10000000-0000-4000-8000-000000000002', 'Duplicate slot', 1)$$
), 'duplicate active sort order is rejected');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$INSERT INTO public.work_zones (owner_member_id, name, sort_order)
    VALUES ('10000000-0000-4000-8000-000000000002', 'Zone D', 4)$$
), 'the fourth active Work Zone is rejected');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$INSERT INTO public.work_zones (owner_member_id, name, sort_order)
    VALUES ('10000000-0000-4000-8000-000000000003', 'Spoofed owner zone', 1)$$
), 'Work Zone ownership is enforced');

INSERT INTO public.todos (id, title, scope, status, created_by)
VALUES (
  '42000000-0000-4000-8000-000000000003', 'Atomic rollback fixture',
  'PRIVATE', '待安排', '10000000-0000-4000-8000-000000000002'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$SELECT public.promote_private_todo_to_work_item(
      '42000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000001',
      '29999999-0000-4000-8000-000000000001')$$
), 'promotion rolls back when Work Item insert fails');
SELECT pg_temp.assert_true(
  (SELECT status = '待安排' FROM public.todos
   WHERE id = '42000000-0000-4000-8000-000000000003')
  AND NOT EXISTS (
    SELECT 1 FROM public.work_items
    WHERE source_todo_id = '42000000-0000-4000-8000-000000000003'
  ),
  'failed promotion leaves neither stored Todo nor Work Item'
);

INSERT INTO public.todos (id, title, content, scope, status, created_by, received_at)
VALUES (
  '42000000-0000-4000-8000-000000000001', 'Promote me', 'Inbox detail',
  'PRIVATE', '待安排', '10000000-0000-4000-8000-000000000002',
  TIMESTAMPTZ '2026-09-03 10:00:00+08'
);
SELECT (public.promote_private_todo_to_work_item(
  '42000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  DATE '2026-09-11', DATE '2026-09-15'
)).id AS promoted_work_item_id \gset
SELECT pg_temp.assert_true(
  (SELECT status = '已收納' FROM public.todos
   WHERE id = '42000000-0000-4000-8000-000000000001'),
  'promotion marks the source Todo stored'
);
SELECT pg_temp.assert_true(
  (SELECT source_todo_id = '42000000-0000-4000-8000-000000000001'
          AND source_created_at IS NOT NULL
          AND received_at = TIMESTAMPTZ '2026-09-03 10:00:00+08'
   FROM public.work_items WHERE id = :'promoted_work_item_id'),
  'promotion preserves Todo linkage and intake provenance'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$SELECT public.promote_private_todo_to_work_item(
      '42000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001')$$
), 'the same Todo cannot be promoted twice');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.work_items (owner_member_id, work_zone_id, title, source_todo_id, source_created_at) VALUES (%L, %L, ''Duplicate source'', %L, now())',
  '10000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001'
)), 'work_item source_todo_id is unique');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$INSERT INTO public.work_items (owner_member_id, work_zone_id, title, status)
    VALUES (
      '10000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001', 'Bad completion', '已完成'
    )$$
), 'completed Work Item requires completed_at');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$INSERT INTO public.work_items (
      owner_member_id, work_zone_id, title, status, completed_at
    ) VALUES (
      '10000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001', 'Bad open item', '進行中', now()
    )$$
), 'incomplete Work Item rejects completed_at');

INSERT INTO public.todos (id, title, scope, status, created_by)
VALUES (
  '42000000-0000-4000-8000-000000000002', 'Owner one private', 'PRIVATE', '待安排',
  '10000000-0000-4000-8000-000000000002'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', 'owner2@example.test')::text,
  true
);
SET LOCAL ROLE authenticated;
SET CONSTRAINTS work_zones_active_limit_guard DEFERRED;
INSERT INTO public.work_zones (id, owner_member_id, name, sort_order) VALUES
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'Zone A', 1),
  ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 'Zone B', 2);
SET CONSTRAINTS work_zones_active_limit_guard IMMEDIATE;
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.work_zones
    WHERE owner_member_id = '10000000-0000-4000-8000-000000000002'
  ),
  'another owner cannot read private Work Zones'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.work_items
    WHERE owner_member_id = '10000000-0000-4000-8000-000000000002'
  ),
  'another owner cannot read private Work Items'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$SELECT public.promote_private_todo_to_work_item(
      '42000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000003')$$
), 'a non-owner cannot promote another member Todo');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$INSERT INTO public.work_items (
      owner_member_id, work_zone_id, title, source_todo_id, source_created_at
    ) VALUES (
      '10000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000003', 'Spoofed source',
      '42000000-0000-4000-8000-000000000002', now()
    )$$
), 'direct Work Item insert cannot spoof another member Todo source');

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', 'admin@example.test')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  pg_temp.affected_rows(
    'UPDATE public.work_groups SET sort_order = sort_order WHERE key = ''PROJECT'''
  ) = 1,
  'ADMIN can manage Work Groups'
);
INSERT INTO public.member_work_groups (member_id, work_group_id)
VALUES ('10000000-0000-4000-8000-000000000001', :'engineering_id');
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM public.member_work_groups
    WHERE member_id = '10000000-0000-4000-8000-000000000001'
  ),
  'ADMIN can manage Work Group membership'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.work_zones)
  AND NOT EXISTS (SELECT 1 FROM public.work_items),
  'ADMIN does not automatically read private Workbench data'
);

RESET ROLE;
INSERT INTO public.todos (
  id, title, scope, status, created_by, assigned_to, assigned_by,
  work_group_id, converted_task_id
) VALUES (
  '43000000-0000-4000-8000-000000000001', 'Converted once', 'TEAM', '已排程',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', :'engineering_id',
  '30000000-0000-4000-8000-000000000001'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, scope, status, created_by, assigned_to, assigned_by, work_group_id, converted_task_id) VALUES (''Converted twice'', ''TEAM'', ''已排程'', %L, %L, %L, %L, %L)',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000003', :'engineering_id',
  '30000000-0000-4000-8000-000000000001'
)), 'one schedule task can trace back to at most one Todo');

\if :{?KEEP_SCHEMA}
COMMIT;
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', 'owner1@example.test')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  (SELECT status = '已收納' FROM public.todos
   WHERE id = '42000000-0000-4000-8000-000000000001')
  AND (SELECT source_todo_id = '42000000-0000-4000-8000-000000000001'
       FROM public.work_items WHERE id = :'promoted_work_item_id'),
  'post-promotion linkage remains valid in a subsequent transaction'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  $$SELECT public.promote_private_todo_to_work_item(
      '42000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001')$$
), 'subsequent transaction still rejects repeated promotion');
RESET ROLE;
ROLLBACK;
\else
ROLLBACK;
\endif
