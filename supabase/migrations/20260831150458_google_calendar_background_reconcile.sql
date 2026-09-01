create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'google_calendar_reconcile_url'
      and nullif(decrypted_secret, '') is not null
  ) then
    raise exception 'Missing Vault secret: google_calendar_reconcile_url';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'google_calendar_reconcile_secret'
      and nullif(decrypted_secret, '') is not null
  ) then
    raise exception 'Missing Vault secret: google_calendar_reconcile_secret';
  end if;
end
$$;

select cron.unschedule(jobid)
from cron.job
where jobname = 'google-calendar-reconcile-every-10-minutes';

select cron.schedule(
  'google-calendar-reconcile-every-10-minutes',
  '*/10 * * * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'google_calendar_reconcile_url'
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'google_calendar_reconcile_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    ) as request_id;
  $cron$
);
