drop table if exists public.inventory_monthly_closing_items cascade;
drop table if exists public.inventory_monthly_closings cascade;
drop table if exists public.inventory_transaction_serials cascade;
drop table if exists public.inventory_serials cascade;
drop table if exists public.inventory_batches cascade;
drop table if exists public.inventory_transactions cascade;
drop table if exists public.inventory_items cascade;

create extension if not exists pgcrypto;

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  category text not null,
  item_category text,
  name text not null,
  source_type text,
  unit text not null,
  opening_quantity numeric not null default 0,
  low_stock_threshold numeric not null default 0,
  requires_serial boolean not null default false,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  transaction_type text not null check (transaction_type in ('IN', 'OUT', 'RETURN', 'ADJUST')),
  transaction_date date not null,
  quantity numeric not null,
  unit text,
  project_id uuid references public.projects(id) on delete set null,
  project_name text,
  handler text,
  source text,
  notes text,
  pending_serial_count integer not null default 0,
  is_voided boolean not null default false,
  voided_reason text,
  voided_by text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  batch_number text not null,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  in_date date not null,
  source text,
  quantity numeric not null,
  unit text,
  handler text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_serials (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  batch_id uuid references public.inventory_batches(id) on delete set null,
  serial_number text not null,
  status text not null,
  project_id uuid references public.projects(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_transaction_serials (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.inventory_transactions(id) on delete cascade,
  serial_id uuid references public.inventory_serials(id) on delete set null,
  serial_no text,
  is_pending boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_monthly_closings (
  id uuid primary key default gen_random_uuid(),
  year text not null,
  month text not null,
  closed_at timestamptz not null,
  closed_by text not null,
  status text not null,
  notes text
);

create table if not exists public.inventory_monthly_closing_items (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references public.inventory_monthly_closings(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  stock_category text not null,
  source text not null,
  item_name text not null,
  item_type text not null,
  unit text not null,
  opening_quantity numeric not null default 0,
  monthly_in numeric not null default 0,
  monthly_out numeric not null default 0,
  monthly_return numeric not null default 0,
  monthly_adjust numeric not null default 0,
  closing_quantity numeric not null default 0,
  usage_quantity numeric not null default 0,
  status text not null,
  notes text
);

create unique index if not exists idx_inventory_items_code on public.inventory_items(code);
create index if not exists idx_inventory_items_name on public.inventory_items(name);
create index if not exists idx_inventory_items_category on public.inventory_items(category);
create index if not exists idx_inventory_items_source_type on public.inventory_items(source_type);
create index if not exists idx_inventory_items_is_active on public.inventory_items(is_active);

create index if not exists idx_inventory_transactions_item_id on public.inventory_transactions(item_id);
create index if not exists idx_inventory_transactions_transaction_date on public.inventory_transactions(transaction_date);
create index if not exists idx_inventory_transactions_transaction_type on public.inventory_transactions(transaction_type);
create index if not exists idx_inventory_transactions_project_id on public.inventory_transactions(project_id);
create index if not exists idx_inventory_transactions_is_voided on public.inventory_transactions(is_voided);

create unique index if not exists idx_inventory_batches_batch_number on public.inventory_batches(batch_number);
create index if not exists idx_inventory_batches_item_id on public.inventory_batches(item_id);
create index if not exists idx_inventory_batches_in_date on public.inventory_batches(in_date);

create unique index if not exists idx_inventory_serials_serial_number on public.inventory_serials(serial_number);
create index if not exists idx_inventory_serials_item_id on public.inventory_serials(item_id);
create index if not exists idx_inventory_serials_batch_id on public.inventory_serials(batch_id);
create index if not exists idx_inventory_serials_status on public.inventory_serials(status);
create index if not exists idx_inventory_serials_project_id on public.inventory_serials(project_id);

create index if not exists idx_inventory_transaction_serials_transaction_id on public.inventory_transaction_serials(transaction_id);
create index if not exists idx_inventory_transaction_serials_serial_id on public.inventory_transaction_serials(serial_id);
create index if not exists idx_inventory_transaction_serials_is_pending on public.inventory_transaction_serials(is_pending);

create unique index if not exists idx_inventory_monthly_closings_year_month on public.inventory_monthly_closings(year, month);
create index if not exists idx_inventory_monthly_closing_items_closing_id on public.inventory_monthly_closing_items(closing_id);
create index if not exists idx_inventory_monthly_closing_items_inventory_item_id on public.inventory_monthly_closing_items(inventory_item_id);

alter table public.inventory_items disable row level security;
alter table public.inventory_transactions disable row level security;
alter table public.inventory_serials disable row level security;
alter table public.inventory_transaction_serials disable row level security;
alter table public.inventory_batches disable row level security;
alter table public.inventory_monthly_closings disable row level security;
alter table public.inventory_monthly_closing_items disable row level security;

notify pgrst, 'reload schema';
