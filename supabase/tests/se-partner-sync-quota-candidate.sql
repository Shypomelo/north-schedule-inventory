-- Candidate only. Artificial quota rows and reservations roll back.
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('email',
  (SELECT email FROM public.team_members WHERE lower(role)='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),
  'role','authenticated')::text, true);
-- Prior Taiwan calendar day does not consume today's quota.
INSERT INTO public.se_api_sync_runs(run_id,mode,page_no,requested_at)
SELECT gen_random_uuid(),'SCHEDULED',2,
  (((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date - 1)::timestamp + time '12:00') AT TIME ZONE 'Asia/Taipei'
FROM generate_series(1,8);
SET LOCAL ROLE authenticated;
DO $test$ DECLARE v_run record; BEGIN
  SELECT * INTO v_run FROM public.se_sync_reserve('MANUAL',NULL,1);
  IF v_run.request_id IS NULL THEN RAISE EXCEPTION 'Taiwan day reset failed'; END IF;
  PERFORM public.se_sync_fail_429(v_run.run_id,clock_timestamp() + interval '1 hour');
  IF NOT EXISTS (SELECT 1 FROM public.se_api_sync_runs WHERE run_id = v_run.run_id
    AND state = 'FAILED' AND error_code = 'HTTP_429' AND retry_after_at > clock_timestamp())
    THEN RAISE EXCEPTION 'Retry-After not persisted'; END IF;
END $test$;
RESET ROLE;
-- With the manual reservation, seven more requests reach the shared daily eight.
INSERT INTO public.se_api_sync_runs(run_id,mode,page_no,requested_at)
SELECT gen_random_uuid(),'SCHEDULED',2,clock_timestamp() FROM generate_series(1,7);
SET LOCAL ROLE authenticated;
DO $test$ BEGIN
  BEGIN PERFORM public.se_sync_reserve('SCHEDULED',NULL,1);
    RAISE EXCEPTION 'daily quota accepted ninth GET';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_DAILY_QUOTA%' THEN RAISE; END IF;
  END;
END $test$;
ROLLBACK;
SELECT 'PASS' AS result, (SELECT count(*) FROM public.se_api_sync_runs) AS quota_cleanup;
