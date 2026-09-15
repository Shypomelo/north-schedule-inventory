-- Run against Candidate as postgres. All fixtures and writes roll back.
-- supabase db query --linked --file supabase/tests/schedule-activity-history-rls.sql
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active = true AND deleted_at IS NULL AND lower(role) = 'admin'
  ) THEN
    RAISE EXCEPTION 'Schedule audit RLS test needs an active ADMIN';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE is_active = true AND deleted_at IS NULL AND lower(role) = 'engineer'
  ) THEN
    RAISE EXCEPTION 'Schedule audit RLS test needs an active ENGINEER';
  END IF;
END;
$test$;

SELECT set_config('test.admin_email', email, true)
FROM public.team_members
WHERE is_active = true AND deleted_at IS NULL AND lower(role) = 'admin'
ORDER BY id LIMIT 1;

SELECT set_config('test.engineer_email', email, true)
FROM public.team_members
WHERE is_active = true AND deleted_at IS NULL AND lower(role) = 'engineer'
ORDER BY id LIMIT 1;

INSERT INTO public.activity_logs (
  action, action_type, target_type, target_id, description, changes,
  user_id, user_name, actor_user_id, actor_name, target_label, message
) VALUES
  (
    'UPDATE_TASK', 'UPDATE_TASK', 'ScheduleTask', 'schedule-audit-rls-update',
    'Schedule audit RLS fixture', '{"before":{"title":"A"},"after":{"title":"B"}}',
    'test', 'Test', 'test', 'Test', 'Visible update', 'Schedule audit RLS fixture'
  ),
  (
    'DELETE_TASK', 'DELETE_TASK', 'ScheduleTask', 'schedule-audit-rls-delete',
    'Schedule delete RLS fixture', '{"before":{"site":"Site","title":"Deleted"},"after":null}',
    'test', 'Test', 'test', 'Test', 'Hidden delete', 'Schedule delete RLS fixture'
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.engineer_email'))::text,
  true
);

DO $test$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.activity_logs WHERE target_id = 'schedule-audit-rls-update') THEN
    RAISE EXCEPTION 'FAIL: ENGINEER cannot read normal Schedule history';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activity_logs WHERE target_id = 'schedule-audit-rls-delete') THEN
    RAISE EXCEPTION 'FAIL: ENGINEER can read Schedule deletion snapshot';
  END IF;
  IF has_table_privilege('authenticated', 'public.activity_logs', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.activity_logs', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL: authenticated audit rows are not append-only';
  END IF;
  RAISE NOTICE 'PASS: ENGINEER history visible, deletion hidden, audit append-only';
END;
$test$;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'email', current_setting('test.admin_email'))::text,
  true
);

DO $test$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.activity_logs WHERE target_id = 'schedule-audit-rls-update')
     OR NOT EXISTS (SELECT 1 FROM public.activity_logs WHERE target_id = 'schedule-audit-rls-delete') THEN
    RAISE EXCEPTION 'FAIL: ADMIN cannot read complete Schedule audit';
  END IF;
  RAISE NOTICE 'PASS: ADMIN reads normal history and deletion snapshots';
END;
$test$;

RESET ROLE;
ROLLBACK;
