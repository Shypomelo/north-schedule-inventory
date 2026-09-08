-- Run against the linked database as postgres. All fixtures and writes roll back.
-- supabase db query --linked --file supabase/tests/todo-scope-rls.sql
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $test$
BEGIN
  IF (SELECT count(*) FROM public.team_members
      WHERE is_active = true AND deleted_at IS NULL
        AND lower(role) IN ('admin', 'engineer')) < 2 THEN
    RAISE EXCEPTION 'Todo scope RLS test needs two existing active editors';
  END IF;
  IF (SELECT count(*) FROM public.team_members
      WHERE is_active = true AND deleted_at IS NULL
        AND lower(role) = 'viewer') < 1 THEN
    RAISE EXCEPTION 'Todo scope RLS test needs one existing active viewer';
  END IF;
END;
$test$;

SELECT set_config('test.editor1_id', id::text, true),
       set_config('test.editor1_email', email, true)
FROM public.team_members
WHERE is_active = true AND deleted_at IS NULL
  AND lower(role) IN ('admin', 'engineer')
ORDER BY id
LIMIT 1;

SELECT set_config('test.editor2_id', id::text, true),
       set_config('test.editor2_email', email, true)
FROM public.team_members
WHERE is_active = true AND deleted_at IS NULL
  AND lower(role) IN ('admin', 'engineer')
  AND id <> current_setting('test.editor1_id')::uuid
ORDER BY id
LIMIT 1;

SELECT set_config('test.viewer_email', email, true)
FROM public.team_members
WHERE is_active = true AND deleted_at IS NULL
  AND lower(role) = 'viewer'
ORDER BY id
LIMIT 1;

CREATE FUNCTION pg_temp.assert_true(value boolean, label text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RAISE NOTICE 'PASS: %', label;
END;
$function$;

CREATE FUNCTION pg_temp.statement_fails(statement text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $function$
BEGIN
  EXECUTE statement;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END;
$function$;

CREATE FUNCTION pg_temp.affected_rows(statement text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $function$
DECLARE affected integer;
BEGIN
  EXECUTE statement;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.statement_fails(text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.affected_rows(text) TO authenticated;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor1_email'))::text,
  true
);
SET LOCAL ROLE authenticated;

INSERT INTO public.todos (id, title, status, scope, created_by, assigned_to, assigned_by)
VALUES (
  '10000000-0000-4000-8000-000000000001', 'Team RLS fixture', '待安排', 'TEAM',
  current_setting('test.editor1_id')::uuid,
  current_setting('test.editor1_id')::uuid,
  current_setting('test.editor1_id')::uuid
);
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.todos WHERE id = '10000000-0000-4000-8000-000000000001'),
  'active editor reads TEAM'
);
UPDATE public.todos SET content = 'team update'
WHERE id = '10000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT content = 'team update' FROM public.todos
   WHERE id = '10000000-0000-4000-8000-000000000001'),
  'editor updates TEAM without breaking existing fields'
);

INSERT INTO public.todos (id, title, status, scope, created_by)
VALUES (
  '20000000-0000-4000-8000-000000000001', 'Private RLS fixture', '待安排', 'PRIVATE',
  current_setting('test.editor1_id')::uuid
);
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.todos WHERE id = '20000000-0000-4000-8000-000000000001'),
  'creator reads own PRIVATE'
);
UPDATE public.todos SET title = 'Private updated', status = '已完成'
WHERE id = '20000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT title = 'Private updated' AND status = '已完成' FROM public.todos
   WHERE id = '20000000-0000-4000-8000-000000000001'),
  'creator updates and completes own PRIVATE'
);

INSERT INTO public.todos (id, title, status, scope, created_by)
VALUES (
  '20000000-0000-4000-8000-000000000002', 'Private delete fixture', '待安排', 'PRIVATE',
  current_setting('test.editor1_id')::uuid
);
DELETE FROM public.todos WHERE id = '20000000-0000-4000-8000-000000000002';
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.todos WHERE id = '20000000-0000-4000-8000-000000000002'),
  'creator deletes own PRIVATE'
);

SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by) VALUES (''Spoof'', ''待安排'', ''PRIVATE'', %L)',
  current_setting('test.editor2_id')
)), 'PRIVATE created_by cannot spoof another member');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by, project_id) VALUES (''Bad project'', ''待安排'', ''PRIVATE'', %L, gen_random_uuid())',
  current_setting('test.editor1_id')
)), 'PRIVATE rejects project_id');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by, task_type) VALUES (''Bad type'', ''待安排'', ''PRIVATE'', %L, ''維修'')',
  current_setting('test.editor1_id')
)), 'PRIVATE rejects task_type');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by, assigned_to) VALUES (''Bad assignee'', ''待安排'', ''PRIVATE'', %L, %L)',
  current_setting('test.editor1_id'), current_setting('test.editor1_id')
)), 'PRIVATE rejects assigned_to');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by, assigned_by) VALUES (''Bad assigner'', ''待安排'', ''PRIVATE'', %L, %L)',
  current_setting('test.editor1_id'), current_setting('test.editor1_id')
)), 'PRIVATE rejects assigned_by');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by, converted_task_id) VALUES (''Bad conversion'', ''待安排'', ''PRIVATE'', %L, gen_random_uuid())',
  current_setting('test.editor1_id')
)), 'PRIVATE rejects converted_task_id');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by, rejected_by, rejected_at, rejection_reason) VALUES (''Bad rejection'', ''待安排'', ''PRIVATE'', %L, %L, now(), ''no'')',
  current_setting('test.editor1_id'), current_setting('test.editor1_id')
)), 'PRIVATE rejects rejection fields');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by) VALUES (''Bad status'', ''已排程'', ''PRIVATE'', %L)',
  current_setting('test.editor1_id')
)), 'PRIVATE rejects TEAM-only status');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  'UPDATE public.todos SET scope = ''PRIVATE'', assigned_to = NULL, assigned_by = NULL WHERE id = ''10000000-0000-4000-8000-000000000001'''
), 'TEAM cannot transition to PRIVATE');
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  'UPDATE public.todos SET scope = ''TEAM'' WHERE id = ''20000000-0000-4000-8000-000000000001'''
), 'PRIVATE cannot transition to TEAM');
UPDATE public.todos SET created_by = current_setting('test.editor2_id')::uuid
WHERE id = '20000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT created_by = current_setting('test.editor1_id')::uuid FROM public.todos
   WHERE id = '20000000-0000-4000-8000-000000000001'),
  'PRIVATE creator cannot change'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.activity_logs
              WHERE target_type = 'Todo'
                AND target_id IN ('20000000-0000-4000-8000-000000000001',
                                  '20000000-0000-4000-8000-000000000002')),
  'PRIVATE insert and update do not produce activity logs'
);
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.activity_logs
          WHERE target_type = 'Todo'
            AND target_id = '10000000-0000-4000-8000-000000000001'
            AND action_type = 'CREATE_TODO')
  AND EXISTS (SELECT 1 FROM public.activity_logs
              WHERE target_type = 'Todo'
                AND target_id = '10000000-0000-4000-8000-000000000001'
                AND action_type = 'UPDATE_TODO'),
  'TEAM insert and update history remains active'
);

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor2_email'))::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.todos WHERE id = '10000000-0000-4000-8000-000000000001'),
  'another active member reads TEAM'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.todos WHERE id = '20000000-0000-4000-8000-000000000001'),
  'another active editor cannot read PRIVATE'
);
SELECT pg_temp.assert_true(
  pg_temp.affected_rows('UPDATE public.todos SET title = ''stolen'' WHERE id = ''20000000-0000-4000-8000-000000000001''') = 0,
  'editor cannot update another creator PRIVATE'
);
SELECT pg_temp.assert_true(
  pg_temp.affected_rows('DELETE FROM public.todos WHERE id = ''20000000-0000-4000-8000-000000000001''') = 0,
  'editor cannot delete another creator PRIVATE'
);
SELECT pg_temp.assert_true(
  pg_temp.statement_fails('SELECT public.reject_todo(''20000000-0000-4000-8000-000000000001'', ''reject private'')'),
  'reject_todo cannot process PRIVATE'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.editor1_email'))::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT public.reject_todo('10000000-0000-4000-8000-000000000001', 'TEAM rejection test');
SELECT pg_temp.assert_true(
  (SELECT status = '已退件' AND rejection_reason = 'TEAM rejection test'
   FROM public.todos WHERE id = '10000000-0000-4000-8000-000000000001'),
  'reject_todo preserves TEAM behavior'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.viewer_email'))::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.todos WHERE id = '10000000-0000-4000-8000-000000000001'),
  'active VIEWER reads TEAM'
);
SELECT pg_temp.assert_true(pg_temp.statement_fails(
  'INSERT INTO public.todos (title, status, scope, created_by) VALUES (''Viewer team'', ''待安排'', ''TEAM'', NULL)'
), 'VIEWER cannot insert TEAM');
SELECT pg_temp.assert_true(pg_temp.statement_fails(format(
  'INSERT INTO public.todos (title, status, scope, created_by) VALUES (''Viewer private'', ''待安排'', ''PRIVATE'', %L)',
  current_setting('test.editor1_id')
)), 'VIEWER cannot insert PRIVATE');

RESET ROLE;
ROLLBACK;
