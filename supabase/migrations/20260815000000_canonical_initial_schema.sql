-- Canonical pre-migration baseline for a blank Supabase project.
--
-- This migration is deliberately additive.  It reconstructs only the schema
-- that existed before 20260816000000; later columns, policies, functions, and
-- tables remain owned by their original migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app_private;

CREATE TABLE IF NOT EXISTS public.team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  category text NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  google_calendar_email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_team_members_email ON public.team_members(email);
CREATE INDEX IF NOT EXISTS idx_team_members_is_active ON public.team_members(is_active);

CREATE OR REPLACE FUNCTION app_private.is_active_member()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE lower(tm.email) = lower(auth.jwt() ->> 'email')
      AND tm.is_active = true
      AND tm.deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION app_private.is_admin_member()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE lower(tm.email) = lower(auth.jwt() ->> 'email')
      AND tm.is_active = true
      AND tm.deleted_at IS NULL
      AND lower(tm.role) = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION app_private.is_active_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.is_admin_member() FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.is_active_member() TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.is_admin_member() TO authenticated;

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'team_members'
      AND policyname = 'team_members_select_active_members'
  ) THEN
    CREATE POLICY team_members_select_active_members
      ON public.team_members FOR SELECT TO authenticated
      USING (app_private.is_active_member());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'team_members'
      AND policyname = 'team_members_insert_admins'
  ) THEN
    CREATE POLICY team_members_insert_admins
      ON public.team_members FOR INSERT TO authenticated
      WITH CHECK (app_private.is_admin_member());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'team_members'
      AND policyname = 'team_members_update_admins'
  ) THEN
    CREATE POLICY team_members_update_admins
      ON public.team_members FOR UPDATE TO authenticated
      USING (app_private.is_admin_member())
      WITH CHECK (app_private.is_admin_member());
  END IF;
END;
$$;

GRANT ALL ON TABLE public.team_members TO anon, authenticated, service_role;

INSERT INTO public.team_members (
  id, name, email, category, role, is_active, created_at, updated_at
)
SELECT
  '65916798-f0ec-4d41-8b17-785c4189bd83'::uuid,
  '柚子',
  'shypomelo@gmail.com',
  'engineering',
  'admin',
  true,
  '2026-07-22 15:58:25.006144+00'::timestamptz,
  '2026-07-22 15:58:25.006144+00'::timestamptz
WHERE NOT EXISTS (
  SELECT 1
  FROM public.team_members
  WHERE id = '65916798-f0ec-4d41-8b17-785c4189bd83'::uuid
     OR lower(btrim(email)) = 'shypomelo@gmail.com'
);

CREATE TABLE IF NOT EXISTS public.schedule_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text,
  project_name text,
  task_type text,
  title text NOT NULL,
  notes text,
  task_date date NOT NULL,
  start_time time without time zone,
  end_time time without time zone,
  is_all_day boolean NOT NULL DEFAULT false,
  primary_member_id text,
  primary_member_name text,
  assistant_member_ids text[] NOT NULL DEFAULT '{}',
  assistant_member_names text[] NOT NULL DEFAULT '{}',
  status text,
  is_tentative boolean NOT NULL DEFAULT false,
  address text,
  google_maps_url text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_schedule_tasks_task_date ON public.schedule_tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_deleted_at ON public.schedule_tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_task_date_not_deleted
  ON public.schedule_tasks(task_date)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.contractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contractor_type text NOT NULL CHECK (
    contractor_type IN ('racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other')
  ),
  contact_person text,
  phone text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code text,
  project_name text NOT NULL,
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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.project_construction_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  work_type text NOT NULL CHECK (
    work_type IN ('racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other')
  ),
  contractor_id uuid REFERENCES public.contractors(id) ON DELETE SET NULL,
  contractor_name text,
  planned_start_date text,
  completed_date text,
  status_override text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_contractors_deleted_at ON public.contractors(deleted_at);
CREATE INDEX IF NOT EXISTS idx_contractors_is_active ON public.contractors(is_active);
CREATE INDEX IF NOT EXISTS idx_contractors_contractor_type ON public.contractors(contractor_type);
CREATE INDEX IF NOT EXISTS idx_contractors_name ON public.contractors(name);
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON public.projects(deleted_at);
CREATE INDEX IF NOT EXISTS idx_projects_project_code ON public.projects(project_code);
CREATE INDEX IF NOT EXISTS idx_projects_project_name ON public.projects(project_name);
CREATE INDEX IF NOT EXISTS idx_projects_responsible_member_name ON public.projects(responsible_member_name);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(status);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_project_id
  ON public.project_construction_progress(project_id);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_contractor_id
  ON public.project_construction_progress(contractor_id);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_work_type
  ON public.project_construction_progress(work_type);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_deleted_at
  ON public.project_construction_progress(deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_construction_progress_active_project_work_type
  ON public.project_construction_progress(project_id, work_type)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  category text NOT NULL,
  item_category text,
  name text NOT NULL,
  source_type text,
  unit text NOT NULL,
  opening_quantity numeric NOT NULL DEFAULT 0,
  low_stock_threshold numeric NOT NULL DEFAULT 0,
  requires_serial boolean NOT NULL DEFAULT false,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  transaction_type text NOT NULL CHECK (transaction_type IN ('IN', 'OUT', 'RETURN', 'ADJUST')),
  transaction_date date NOT NULL,
  quantity numeric NOT NULL,
  unit text,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  project_name text,
  handler text,
  source text,
  notes text,
  pending_serial_count integer NOT NULL DEFAULT 0,
  is_voided boolean NOT NULL DEFAULT false,
  voided_reason text,
  voided_by text,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number text NOT NULL,
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  in_date date NOT NULL,
  source text,
  quantity numeric NOT NULL,
  unit text,
  handler text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  batch_id uuid REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  serial_number text NOT NULL,
  status text NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_transaction_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.inventory_transactions(id) ON DELETE CASCADE,
  serial_id uuid REFERENCES public.inventory_serials(id) ON DELETE SET NULL,
  serial_no text,
  is_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_monthly_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year text NOT NULL,
  month text NOT NULL,
  closed_at timestamptz NOT NULL,
  closed_by text NOT NULL,
  status text NOT NULL,
  notes text
);

CREATE TABLE IF NOT EXISTS public.inventory_monthly_closing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_id uuid NOT NULL REFERENCES public.inventory_monthly_closings(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  stock_category text NOT NULL,
  source text NOT NULL,
  item_name text NOT NULL,
  item_type text NOT NULL,
  unit text NOT NULL,
  opening_quantity numeric NOT NULL DEFAULT 0,
  monthly_in numeric NOT NULL DEFAULT 0,
  monthly_out numeric NOT NULL DEFAULT 0,
  monthly_return numeric NOT NULL DEFAULT 0,
  monthly_adjust numeric NOT NULL DEFAULT 0,
  closing_quantity numeric NOT NULL DEFAULT 0,
  usage_quantity numeric NOT NULL DEFAULT 0,
  status text NOT NULL,
  notes text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_code ON public.inventory_items(code);
CREATE INDEX IF NOT EXISTS idx_inventory_items_name ON public.inventory_items(name);
CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON public.inventory_items(category);
CREATE INDEX IF NOT EXISTS idx_inventory_items_source_type ON public.inventory_items(source_type);
CREATE INDEX IF NOT EXISTS idx_inventory_items_is_active ON public.inventory_items(is_active);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_item_id ON public.inventory_transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_transaction_date
  ON public.inventory_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_transaction_type
  ON public.inventory_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_project_id
  ON public.inventory_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_is_voided
  ON public.inventory_transactions(is_voided);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_batches_batch_number
  ON public.inventory_batches(batch_number);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_item_id ON public.inventory_batches(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_in_date ON public.inventory_batches(in_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serials_serial_number
  ON public.inventory_serials(serial_number);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_item_id ON public.inventory_serials(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_batch_id ON public.inventory_serials(batch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_status ON public.inventory_serials(status);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_project_id ON public.inventory_serials(project_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_serials_transaction_id
  ON public.inventory_transaction_serials(transaction_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_serials_serial_id
  ON public.inventory_transaction_serials(serial_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_serials_is_pending
  ON public.inventory_transaction_serials(is_pending);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_monthly_closings_year_month
  ON public.inventory_monthly_closings(year, month);
CREATE INDEX IF NOT EXISTS idx_inventory_monthly_closing_items_closing_id
  ON public.inventory_monthly_closing_items(closing_id);
CREATE INDEX IF NOT EXISTS idx_inventory_monthly_closing_items_inventory_item_id
  ON public.inventory_monthly_closing_items(inventory_item_id);

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
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
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_target
  ON public.activity_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON public.activity_logs(action);

GRANT ALL ON TABLE
  public.schedule_tasks,
  public.contractors,
  public.projects,
  public.project_construction_progress,
  public.inventory_items,
  public.inventory_transactions,
  public.inventory_batches,
  public.inventory_serials,
  public.inventory_transaction_serials,
  public.inventory_monthly_closings,
  public.inventory_monthly_closing_items,
  public.activity_logs
TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
