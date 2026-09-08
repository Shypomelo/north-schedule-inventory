-- Run only against an empty, disposable LOCAL PostgreSQL database as postgres:
-- psql -X -v ON_ERROR_STOP=1 -f supabase/tests/workflow-refresh-rls.sql
-- Real workflow migrations, policies and triggers; synthetic people/projects.
-- All fixtures and schema changes are rolled back, including on disconnect.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE SCHEMA app_private;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT current_setting('request.jwt.claims', true)::jsonb $$;
CREATE TABLE public.projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    responsible_member_name text,
    deleted_at timestamptz
);
CREATE TABLE public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text, email text, role text, is_active boolean DEFAULT true,
    deleted_at timestamptz
);
CREATE FUNCTION app_private.is_active_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM public.team_members tm
    WHERE lower(tm.email) = lower(auth.jwt()->>'email')
    AND tm.is_active AND tm.deleted_at IS NULL)
$$;
CREATE FUNCTION app_private.is_editor_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM public.team_members tm
    WHERE lower(tm.email) = lower(auth.jwt()->>'email')
    AND tm.is_active AND tm.deleted_at IS NULL
    AND lower(tm.role) IN ('admin', 'engineer'))
$$;
CREATE FUNCTION app_private.is_admin_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM public.team_members tm
    WHERE lower(tm.email) = lower(auth.jwt()->>'email')
    AND tm.is_active AND tm.deleted_at IS NULL AND lower(tm.role) = 'admin')
$$;
GRANT USAGE ON SCHEMA auth, app_private TO authenticated;
GRANT SELECT ON public.projects, public.team_members TO authenticated;
\ir ../migrations/20260904004145_create_project_workflow_v2_schema.sql
\ir ../migrations/20260907131749_add_project_position_responsibilities.sql

INSERT INTO public.team_members (name, email, role) VALUES
    ('Admin', 'admin@example.test', 'admin'),
    ('Engineer', 'engineer@example.test', 'engineer'),
    ('Viewer', 'viewer@example.test', 'viewer');
INSERT INTO public.projects DEFAULT VALUES RETURNING id AS project_id \gset
INSERT INTO public.project_workflow_templates (template_key, name)
VALUES ('RLS_TEST', 'RLS test') RETURNING id AS template_id \gset
INSERT INTO public.project_workflow_phases (phase_key, name, sort_order)
VALUES ('RLS_TEST', 'RLS test', 10) RETURNING id AS phase_id \gset
INSERT INTO public.project_workflow_types (type_key, name, sort_order)
VALUES ('RLS_TEST', 'RLS test', 10) RETURNING id AS type_id \gset
INSERT INTO public.project_workflow_template_steps
    (template_id, step_key, label, phase_id, type_id, sort_order)
VALUES (:'template_id', 'FIRST', 'First', :'phase_id', :'type_id', 10),
       (:'template_id', 'SECOND', 'Second', :'phase_id', :'type_id', 20);
INSERT INTO public.project_workflow_instances
    (project_id, source_template_id, template_key_snapshot, template_name_snapshot)
VALUES (:'project_id', :'template_id', 'RLS_TEST', 'RLS test');

CREATE TEMP TABLE original_policies AS SELECT * FROM pg_policies
WHERE schemaname = 'public';
CREATE TEMP TABLE original_grants AS SELECT * FROM information_schema.role_table_grants
WHERE table_schema = 'public';

-- These helpers are SECURITY INVOKER: INSERT and RPC tests run as authenticated.
CREATE FUNCTION pg_temp.try_insert(p_origin text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_id uuid;
BEGIN
    INSERT INTO public.project_milestones
        (workflow_instance_id, project_id, origin, source_template_step_id,
         label, source_phase_id, source_type_id, sort_order)
    SELECT i.id, i.project_id, p_origin,
           CASE WHEN p_origin = 'TEMPLATE' THEN s.id ELSE NULL END,
           'Custom test', s.phase_id, s.type_id, 15
    FROM public.project_workflow_instances i
    JOIN public.project_workflow_template_steps s ON s.template_id = i.source_template_id
    WHERE s.step_key = 'FIRST'
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.expect_insert(p_name text, p_origin text, p_allow boolean)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
    BEGIN
        IF pg_temp.try_insert(p_origin) IS NULL THEN
            RETURN 'FAIL: ' || p_name || ' inserted no row';
        END IF;
        -- Revert a successful probe without granting DELETE to the caller.
        RAISE EXCEPTION 'successful probe' USING ERRCODE = 'P0002';
    EXCEPTION
        WHEN no_data_found THEN
            RETURN CASE WHEN p_allow THEN 'PASS: ' ELSE 'FAIL: ' END || p_name || ' ALLOW';
        WHEN insufficient_privilege THEN
            RETURN CASE WHEN NOT p_allow THEN 'PASS: ' ELSE 'FAIL: ' END || p_name || ' DENY: ' || SQLERRM;
    END;
END $$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","email":"engineer@example.test"}';
SELECT pg_temp.expect_insert('baseline engineer custom', 'PROJECT_CUSTOM', true);
SET LOCAL request.jwt.claims = '{"role":"authenticated","email":"viewer@example.test"}';
SELECT pg_temp.expect_insert('baseline viewer custom', 'PROJECT_CUSTOM', false);
RESET ROLE;

\ir ../migrations/20260907155524_unify_project_engineering_responsibility.sql
\ir ../migrations/20260908140629_fix_admin_workflow_refresh_rls.sql

SELECT CASE WHEN NOT EXISTS (
    SELECT * FROM original_policies EXCEPT SELECT * FROM pg_policies
) AND (SELECT count(*) FROM pg_policies WHERE schemaname='public') =
      (SELECT count(*) + 1 FROM original_policies)
THEN 'PASS: existing policies preserved; exactly one added' ELSE 'FAIL: policies changed' END;
SELECT CASE WHEN NOT EXISTS (
    (SELECT * FROM original_grants EXCEPT SELECT * FROM information_schema.role_table_grants WHERE table_schema='public')
    UNION ALL
    (SELECT * FROM information_schema.role_table_grants WHERE table_schema='public' EXCEPT SELECT * FROM original_grants)
) THEN 'PASS: table grants unchanged' ELSE 'FAIL: table grants changed' END;
SELECT CASE WHEN NOT prosecdef THEN 'PASS: refresh SECURITY INVOKER'
ELSE 'FAIL: refresh SECURITY DEFINER' END FROM pg_proc
WHERE oid='public.refresh_project_workflow(uuid)'::regprocedure;
SELECT CASE WHEN pg_get_functiondef('public.refresh_project_workflow(uuid)'::regprocedure)
                      NOT LIKE '%FOR UPDATE%'
                 AND pg_get_functiondef('public.refresh_project_workflow(uuid)'::regprocedure)
                      LIKE '%pg_advisory_xact_lock%'
    THEN 'PASS: refresh uses advisory serialization without UPDATE privilege'
    ELSE 'FAIL: refresh locking strategy' END;
SELECT CASE WHEN has_table_privilege(
    'authenticated', 'public.project_workflow_instances', 'UPDATE'
) THEN 'FAIL: authenticated gained workflow instance UPDATE'
ELSE 'PASS: authenticated workflow instance grants not widened' END;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","email":"engineer@example.test"}';
SELECT pg_temp.expect_insert('engineer custom', 'PROJECT_CUSTOM', true);
SELECT pg_temp.expect_insert('engineer template', 'TEMPLATE', false);
SELECT pg_temp.try_insert('PROJECT_CUSTOM') AS custom_id \gset
DO $$ BEGIN
    PERFORM public.refresh_project_workflow((SELECT id FROM public.projects LIMIT 1));
    PERFORM set_config('test.nonadmin_refresh', 'FAIL: nonadmin refresh allowed', true);
EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('test.nonadmin_refresh',
        CASE WHEN SQLERRM='Only admin members can refresh project workflows'
        THEN 'PASS: nonadmin refresh denied by RPC admin guard'
        ELSE 'FAIL: unexpected denial: ' || SQLERRM END, true);
END $$;
SELECT current_setting('test.nonadmin_refresh');
SET LOCAL request.jwt.claims = '{"role":"authenticated","email":"viewer@example.test"}';
SELECT pg_temp.expect_insert('viewer custom', 'PROJECT_CUSTOM', false);
SELECT pg_temp.expect_insert('viewer template', 'TEMPLATE', false);
SET LOCAL request.jwt.claims = '{"role":"authenticated","email":"admin@example.test"}';
SELECT pg_temp.expect_insert('admin template', 'TEMPLATE', true);
SELECT pg_temp.expect_insert('admin custom', 'PROJECT_CUSTOM', true);

DO $$ BEGIN
    PERFORM instance.id
    FROM public.project_workflow_instances AS instance
    WHERE instance.deleted_at IS NULL
    FOR UPDATE;
    PERFORM set_config('test.admin_direct_lock',
        'FAIL: admin direct FOR UPDATE allowed', true);
EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('test.admin_direct_lock',
        'PASS: admin refresh needs no direct FOR UPDATE privilege', true);
END $$;
SELECT current_setting('test.admin_direct_lock');

RESET ROLE;
CREATE TEMP TABLE custom_before AS SELECT * FROM public.project_milestones WHERE origin='PROJECT_CUSTOM';
SET LOCAL ROLE authenticated;
DO $$ DECLARE first_count integer; second_count integer;
BEGIN
    SELECT milestones_created INTO first_count FROM public.refresh_project_workflow((SELECT id FROM public.projects LIMIT 1));
    SELECT milestones_created INTO second_count FROM public.refresh_project_workflow((SELECT id FROM public.projects LIMIT 1));
    PERFORM set_config('test.admin_refresh',
        CASE WHEN first_count=2 AND second_count=0 THEN 'PASS' ELSE 'FAIL' END ||
        ': admin refresh first=' || first_count || ', second=' || second_count, true);
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('test.admin_refresh', 'FAIL: admin refresh ' || SQLSTATE || ': ' || SQLERRM, true);
END $$;
SELECT current_setting('test.admin_refresh');
RESET ROLE;
SELECT CASE WHEN NOT EXISTS (
    (SELECT * FROM custom_before EXCEPT SELECT * FROM public.project_milestones WHERE origin='PROJECT_CUSTOM')
    UNION ALL
    (SELECT * FROM public.project_milestones WHERE origin='PROJECT_CUSTOM' EXCEPT SELECT * FROM custom_before)
) THEN 'PASS: PROJECT_CUSTOM unchanged' ELSE 'FAIL: PROJECT_CUSTOM changed' END;
ROLLBACK;
