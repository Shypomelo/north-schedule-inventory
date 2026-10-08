ALTER TABLE public.se_api_sync_runs ADD COLUMN retry_after_at timestamptz;

CREATE FUNCTION public.se_sync_fail_429(p_run_id uuid, p_retry_after_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app_private.se_sync_allowed() THEN RAISE EXCEPTION 'SE_SYNC_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF p_retry_after_at IS NULL OR p_retry_after_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'SE_RETRY_AFTER_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.se_api_sync_runs SET state = 'FAILED', error_code = 'HTTP_429',
    retry_after_at = p_retry_after_at
  WHERE run_id = p_run_id AND state = 'RESERVED';
END;
$$;
REVOKE ALL ON FUNCTION public.se_sync_fail_429(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.se_sync_fail_429(uuid, timestamptz) TO authenticated, service_role;
