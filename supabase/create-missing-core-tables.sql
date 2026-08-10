create extension if not exists pgcrypto;

create table if not exists public.contractors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contractor_type text not null check (contractor_type in ('racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other')),
  contact_person text,
  phone text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_code text,
  project_name text not null,
  project_short_name text,
  capacity_kw text,
  address text,
  region text,
  responsible_member_name text,
  status text,
  stage text,
  meter_date text,
  notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.project_construction_progress (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  work_type text not null check (work_type in ('racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other')),
  contractor_id uuid references public.contractors(id) on delete set null,
  contractor_name text,
  planned_start_date text,
  completed_date text,
  status_override text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_contractors_deleted_at on public.contractors(deleted_at);
create index if not exists idx_contractors_is_active on public.contractors(is_active);
create index if not exists idx_contractors_contractor_type on public.contractors(contractor_type);
create index if not exists idx_contractors_name on public.contractors(name);

create index if not exists idx_projects_deleted_at on public.projects(deleted_at);
create index if not exists idx_projects_project_code on public.projects(project_code);
create index if not exists idx_projects_project_name on public.projects(project_name);
create index if not exists idx_projects_responsible_member_name on public.projects(responsible_member_name);
create index if not exists idx_projects_status on public.projects(status);

create index if not exists idx_project_construction_progress_project_id on public.project_construction_progress(project_id);
create index if not exists idx_project_construction_progress_contractor_id on public.project_construction_progress(contractor_id);
create index if not exists idx_project_construction_progress_work_type on public.project_construction_progress(work_type);
create index if not exists idx_project_construction_progress_deleted_at on public.project_construction_progress(deleted_at);
create unique index if not exists idx_project_construction_progress_active_project_work_type
  on public.project_construction_progress(project_id, work_type)
  where deleted_at is null;

alter table public.contractors disable row level security;
alter table public.projects disable row level security;
alter table public.project_construction_progress disable row level security;

notify pgrst, 'reload schema';
