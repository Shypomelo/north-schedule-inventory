create extension if not exists pgcrypto;

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  target_type text not null,
  target_id text not null,
  description text,
  changes jsonb,
  user_id text,
  user_name text,
  actor_user_id text,
  actor_name text,
  action_type text,
  target_label text,
  project_id text,
  project_name text,
  before_value text,
  after_value text,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_logs_target on public.activity_logs(target_type, target_id);
create index if not exists idx_activity_logs_created_at on public.activity_logs(created_at);
create index if not exists idx_activity_logs_action on public.activity_logs(action);

alter table public.activity_logs disable row level security;

notify pgrst, 'reload schema';
