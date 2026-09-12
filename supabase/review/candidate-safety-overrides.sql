-- Candidate-only statements. This file is embedded inside the refresh transaction.
-- The caller and transaction must validate review_private.environment_guard first.

-- Preserve Production rows while making Calendar eligibility false in Candidate.
UPDATE public.work_groups
SET google_calendar_sync_enabled = false
WHERE google_calendar_sync_enabled;

-- This workflow never copies cron configuration. Fail closed if Candidate has
-- acquired an active job through another path, so its scope can be reviewed.
DO $cron_safety$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE active) THEN
    RAISE EXCEPTION 'candidate safety guard failed: active cron job exists';
  END IF;
END
$cron_safety$;

-- Keep pg_net installed for schema parity, but fail if any App-owned database
-- routine could invoke it (net is not one of this App's exposed API schemas).
DO $network_safety$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname IN ('public','app_private')
      AND routine.prokind = 'f'
      AND pg_get_functiondef(routine.oid) ~* '(net\.http|http_post|http_get|webhook|https?://)'
  ) THEN
    RAISE EXCEPTION 'candidate safety guard failed: external network routine exists';
  END IF;
END
$network_safety$;
