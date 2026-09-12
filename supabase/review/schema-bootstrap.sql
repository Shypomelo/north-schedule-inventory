-- Candidate-only schema bootstrap generated from Production catalog and repo contract.
-- Guarded by the Candidate baseline migration; never add this file to supabase/migrations.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE name = 'candidate_review_production_shape_baseline'
  ) THEN
    RAISE EXCEPTION 'candidate review guard failed: expected candidate_review_production_shape_baseline';
  END IF;
END
$guard$;

CREATE SCHEMA IF NOT EXISTS review_private;
REVOKE ALL ON SCHEMA review_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS review_private.environment_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project_ref text NOT NULL CHECK (project_ref = 'fssogssryeunkjkdgewx'),
  purpose text NOT NULL CHECK (purpose = 'CANDIDATE_REVIEW'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO review_private.environment_guard(singleton, project_ref, purpose)
VALUES (true, 'fssogssryeunkjkdgewx', 'CANDIDATE_REVIEW')
ON CONFLICT (singleton) DO UPDATE SET project_ref=excluded.project_ref,purpose=excluded.purpose,updated_at=now();

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE SCHEMA IF NOT EXISTS app_private;

-- Required before inventory_serials generated columns are declared.
CREATE OR REPLACE FUNCTION public.normalize_inventory_serial(p_serial text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT upper(
    regexp_replace(
      btrim(translate(normalize(p_serial, NFKC), '－–—', '---')),
      '\s*-\s*',
      '-',
      'g'
    )
  );
$function$;
CREATE OR REPLACE FUNCTION public.classify_inventory_serial_format(p_serial text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'short'
    WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'full'
    ELSE 'unknown'
  END;
$function$;
CREATE OR REPLACE FUNCTION public.derive_inventory_serial_short_key(p_serial text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH normalized AS (
    SELECT public.normalize_inventory_serial(p_serial) AS value
  )
  SELECT CASE
    WHEN value ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN value
    WHEN value ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$'
      THEN split_part(value, '-', 2) || '-' || split_part(value, '-', 3)
    ELSE NULL
  END
  FROM normalized;
$function$;

CREATE TABLE IF NOT EXISTS public.contractors (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "notes" text,
  "phone" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "contact_person" text,
  "contractor_type" text NOT NULL,
  "work_capabilities" text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_batches (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "unit" text,
  "notes" text,
  "source" text,
  "handler" text,
  "in_date" date NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity" numeric NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "batch_number" text NOT NULL,
  "source_transaction_id" uuid
);

CREATE TABLE IF NOT EXISTS public.inventory_initialization_items (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "initialization_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "new_opening_quantity" integer NOT NULL,
  "pending_serial_count" integer DEFAULT 0 NOT NULL,
  "in_stock_serial_count" integer DEFAULT 0 NOT NULL,
  "previous_opening_quantity" integer NOT NULL,
  "retained_in_stock_serial_count" integer DEFAULT 0 NOT NULL,
  "removed_from_stock_serial_count" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_initialization_serials (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "serial_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "new_status" text NOT NULL,
  "is_retained" boolean NOT NULL,
  "previous_status" text NOT NULL,
  "initialization_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_initializations (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "baseline_date" date NOT NULL,
  "initialized_at" timestamp with time zone DEFAULT now() NOT NULL,
  "initialized_by" text,
  "preserved_serial_count" integer DEFAULT 0 NOT NULL,
  "archived_transaction_count" integer DEFAULT 0 NOT NULL,
  "deleted_void_transaction_count" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_items (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "unit" text NOT NULL,
  "notes" text,
  "category" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_type" text,
  "item_category" text,
  "requires_serial" boolean DEFAULT false NOT NULL,
  "opening_quantity" numeric DEFAULT 0 NOT NULL,
  "low_stock_threshold" numeric DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_monthly_closing_items (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "unit" text NOT NULL,
  "notes" text,
  "source" text NOT NULL,
  "status" text NOT NULL,
  "item_name" text NOT NULL,
  "item_type" text NOT NULL,
  "closing_id" uuid NOT NULL,
  "monthly_in" numeric DEFAULT 0 NOT NULL,
  "monthly_out" numeric DEFAULT 0 NOT NULL,
  "monthly_adjust" numeric DEFAULT 0 NOT NULL,
  "monthly_return" numeric DEFAULT 0 NOT NULL,
  "stock_category" text NOT NULL,
  "usage_quantity" numeric DEFAULT 0 NOT NULL,
  "closing_quantity" numeric DEFAULT 0 NOT NULL,
  "opening_quantity" numeric DEFAULT 0 NOT NULL,
  "inventory_item_id" uuid
);

CREATE TABLE IF NOT EXISTS public.inventory_monthly_closings (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "year" text NOT NULL,
  "month" text NOT NULL,
  "notes" text,
  "status" text NOT NULL,
  "closed_at" timestamp with time zone NOT NULL,
  "closed_by" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_serials (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "notes" text,
  "status" text NOT NULL,
  "item_id" uuid NOT NULL,
  "batch_id" uuid,
  "short_key" text GENERATED ALWAYS AS (derive_inventory_serial_short_key(serial_number)) STORED,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "serial_number" text NOT NULL,
  "normalized_full" text GENERATED ALWAYS AS (normalize_inventory_serial(serial_number)) STORED
);

CREATE TABLE IF NOT EXISTS public.inventory_transaction_serials (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "serial_id" uuid,
  "serial_no" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_pending" boolean DEFAULT false NOT NULL,
  "transaction_id" uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "unit" text,
  "notes" text,
  "source" text,
  "handler" text,
  "item_id" uuid NOT NULL,
  "quantity" numeric NOT NULL,
  "is_voided" boolean DEFAULT false NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_name" text,
  "voided_reason" text,
  "transaction_date" date NOT NULL,
  "transaction_type" text NOT NULL,
  "pending_serial_count" integer DEFAULT 0 NOT NULL,
  "excluded_by_initialization_id" uuid
);

CREATE TABLE IF NOT EXISTS public.member_positions (
  "member_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "position_id" uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.positions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_difficulty_assessments (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "evaluator_name" text NOT NULL,
  "assessment_type" text NOT NULL,
  "evaluator_user_id" uuid NOT NULL,
  "overall_difficulty" smallint NOT NULL,
  "site_construction_difficulty" smallint NOT NULL,
  "site_coordination_difficulty" smallint NOT NULL,
  "owner_communication_difficulty" smallint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_workflow_instances (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "project_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_template_id" uuid NOT NULL,
  "template_key_snapshot" text NOT NULL,
  "template_name_snapshot" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_workflow_phases (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "phase_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sort_order" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_workflow_template_steps (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "type_id" uuid NOT NULL,
  "phase_id" uuid NOT NULL,
  "step_key" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sort_order" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "template_id" uuid NOT NULL,
  "default_is_applicable" boolean DEFAULT true NOT NULL,
  "responsible_position_id" uuid
);

CREATE TABLE IF NOT EXISTS public.project_workflow_templates (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "description" text,
  "template_key" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_workflow_types (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type_key" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sort_order" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.schedule_task_types (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.se_supply_records (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "notes" text,
  "new_model" text,
  "old_model" text,
  "created_at" timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  "new_serial" text,
  "project_id" uuid,
  "updated_at" timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  "fault_reason" text,
  "project_name" text,
  "receive_date" date,
  "replace_date" date,
  "faulty_serial" text,
  "receive_method" text
);
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "label" text NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "origin" text NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "phase_key_snapshot" text NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "phase_name_snapshot" text NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "phase_sort_order_snapshot" integer;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "responsible_position_id" uuid;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "source_phase_id" uuid NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "source_template_step_id" uuid;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "source_type_id" uuid NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "type_key_snapshot" text NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "type_name_snapshot" text NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE public.project_milestones ADD COLUMN IF NOT EXISTS "workflow_instance_id" uuid NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "address" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "assistant_member_names" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "created_by_name" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "creation_source" text DEFAULT 'LEGACY'::text NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "end_time" time without time zone;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "google_calendar_id" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "google_event_id" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "google_maps_url" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "google_sync_error" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "google_sync_status" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "is_all_day" boolean DEFAULT false NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "is_tentative" boolean DEFAULT false NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "primary_member_id" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "primary_member_name" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "project_id" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "project_name" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "start_time" time without time zone;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "task_type" text;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE public.schedule_tasks ADD COLUMN IF NOT EXISTS "updated_by" text;

ALTER TABLE public.team_members ALTER COLUMN category DROP DEFAULT;
ALTER TABLE public.project_milestones ALTER COLUMN milestone_key SET DEFAULT ('CUSTOM_'::text || replace((gen_random_uuid())::text, '-'::text, ''::text));
ALTER TABLE public.project_milestones DROP CONSTRAINT IF EXISTS "project_milestones_project_id_fkey";
ALTER TABLE public.project_position_assignments DROP CONSTRAINT IF EXISTS "project_position_assignments_member_id_fkey";
ALTER TABLE public.project_position_assignments DROP CONSTRAINT IF EXISTS "project_position_assignments_project_id_position_id_key";
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contractors_pkey' AND conrelid='public.contractors'::regclass) THEN ALTER TABLE public.contractors ADD CONSTRAINT "contractors_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_batches_pkey' AND conrelid='public.inventory_batches'::regclass) THEN ALTER TABLE public.inventory_batches ADD CONSTRAINT "inventory_batches_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_items_pkey' AND conrelid='public.inventory_initialization_items'::regclass) THEN ALTER TABLE public.inventory_initialization_items ADD CONSTRAINT "inventory_initialization_items_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_serials_pkey' AND conrelid='public.inventory_initialization_serials'::regclass) THEN ALTER TABLE public.inventory_initialization_serials ADD CONSTRAINT "inventory_initialization_serials_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initializations_pkey' AND conrelid='public.inventory_initializations'::regclass) THEN ALTER TABLE public.inventory_initializations ADD CONSTRAINT "inventory_initializations_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_items_pkey' AND conrelid='public.inventory_items'::regclass) THEN ALTER TABLE public.inventory_items ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_monthly_closing_items_pkey' AND conrelid='public.inventory_monthly_closing_items'::regclass) THEN ALTER TABLE public.inventory_monthly_closing_items ADD CONSTRAINT "inventory_monthly_closing_items_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_monthly_closings_pkey' AND conrelid='public.inventory_monthly_closings'::regclass) THEN ALTER TABLE public.inventory_monthly_closings ADD CONSTRAINT "inventory_monthly_closings_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_serials_pkey' AND conrelid='public.inventory_serials'::regclass) THEN ALTER TABLE public.inventory_serials ADD CONSTRAINT "inventory_serials_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transaction_serials_pkey' AND conrelid='public.inventory_transaction_serials'::regclass) THEN ALTER TABLE public.inventory_transaction_serials ADD CONSTRAINT "inventory_transaction_serials_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transactions_pkey' AND conrelid='public.inventory_transactions'::regclass) THEN ALTER TABLE public.inventory_transactions ADD CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='member_positions_pkey' AND conrelid='public.member_positions'::regclass) THEN ALTER TABLE public.member_positions ADD CONSTRAINT "member_positions_pkey" PRIMARY KEY (member_id, position_id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='positions_pkey' AND conrelid='public.positions'::regclass) THEN ALTER TABLE public.positions ADD CONSTRAINT "positions_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_pkey' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_instances_pkey' AND conrelid='public.project_workflow_instances'::regclass) THEN ALTER TABLE public.project_workflow_instances ADD CONSTRAINT "project_workflow_instances_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_phases_pkey' AND conrelid='public.project_workflow_phases'::regclass) THEN ALTER TABLE public.project_workflow_phases ADD CONSTRAINT "project_workflow_phases_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_pkey' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_templates_pkey' AND conrelid='public.project_workflow_templates'::regclass) THEN ALTER TABLE public.project_workflow_templates ADD CONSTRAINT "project_workflow_templates_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_types_pkey' AND conrelid='public.project_workflow_types'::regclass) THEN ALTER TABLE public.project_workflow_types ADD CONSTRAINT "project_workflow_types_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_task_types_pkey' AND conrelid='public.schedule_task_types'::regclass) THEN ALTER TABLE public.schedule_task_types ADD CONSTRAINT "schedule_task_types_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='se_supply_records_pkey' AND conrelid='public.se_supply_records'::regclass) THEN ALTER TABLE public.se_supply_records ADD CONSTRAINT "se_supply_records_pkey" PRIMARY KEY (id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_serial_initialization_id_serial_id_key' AND conrelid='public.inventory_initialization_serials'::regclass) THEN ALTER TABLE public.inventory_initialization_serials ADD CONSTRAINT "inventory_initialization_serial_initialization_id_serial_id_key" UNIQUE (initialization_id, serial_id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_project_type_unique' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_project_type_unique" UNIQUE (project_id, assessment_type); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_position_assignments_project_position_key' AND conrelid='public.project_position_assignments'::regclass) THEN ALTER TABLE public.project_position_assignments ADD CONSTRAINT "project_position_assignments_project_position_key" UNIQUE (project_id, position_id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_phases_phase_key_key' AND conrelid='public.project_workflow_phases'::regclass) THEN ALTER TABLE public.project_workflow_phases ADD CONSTRAINT "project_workflow_phases_phase_key_key" UNIQUE (phase_key); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_template_step_key_key' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_template_step_key_key" UNIQUE (template_id, step_key); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_templates_template_key_key' AND conrelid='public.project_workflow_templates'::regclass) THEN ALTER TABLE public.project_workflow_templates ADD CONSTRAINT "project_workflow_templates_template_key_key" UNIQUE (template_key); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_types_type_key_key' AND conrelid='public.project_workflow_types'::regclass) THEN ALTER TABLE public.project_workflow_types ADD CONSTRAINT "project_workflow_types_type_key_key" UNIQUE (type_key); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contractors_contractor_type_check' AND conrelid='public.contractors'::regclass) THEN ALTER TABLE public.contractors ADD CONSTRAINT "contractors_contractor_type_check" CHECK (contractor_type = ANY (ARRAY['racking'::text, 'electrical'::text, 'steel'::text, 'roof_cover'::text, 'civil'::text, 'other'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contractors_primary_category_capability_check' AND conrelid='public.contractors'::regclass) THEN ALTER TABLE public.contractors ADD CONSTRAINT "contractors_primary_category_capability_check" CHECK (contractor_type = ANY (work_capabilities)); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contractors_work_capabilities_allowed_check' AND conrelid='public.contractors'::regclass) THEN ALTER TABLE public.contractors ADD CONSTRAINT "contractors_work_capabilities_allowed_check" CHECK (work_capabilities <@ ARRAY['racking'::text, 'electrical'::text, 'steel'::text, 'roof_cover'::text, 'civil'::text, 'ladder_installation'::text, 'other'::text] AND array_position(work_capabilities, NULL::text) IS NULL); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contractors_work_capabilities_nonempty_check' AND conrelid='public.contractors'::regclass) THEN ALTER TABLE public.contractors ADD CONSTRAINT "contractors_work_capabilities_nonempty_check" CHECK (cardinality(work_capabilities) > 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initializations_baseline_date_check' AND conrelid='public.inventory_initializations'::regclass) THEN ALTER TABLE public.inventory_initializations ADD CONSTRAINT "inventory_initializations_baseline_date_check" CHECK (baseline_date = '2026-08-31'::date); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transactions_transaction_type_check' AND conrelid='public.inventory_transactions'::regclass) THEN ALTER TABLE public.inventory_transactions ADD CONSTRAINT "inventory_transactions_transaction_type_check" CHECK (transaction_type = ANY (ARRAY['IN'::text, 'OUT'::text, 'RETURN'::text, 'ADJUST'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='positions_name_not_blank' AND conrelid='public.positions'::regclass) THEN ALTER TABLE public.positions ADD CONSTRAINT "positions_name_not_blank" CHECK (btrim(name) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='positions_sort_order_nonnegative' AND conrelid='public.positions'::regclass) THEN ALTER TABLE public.positions ADD CONSTRAINT "positions_sort_order_nonnegative" CHECK (sort_order >= 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_construction_progress_completion_consistent_check' AND conrelid='public.project_construction_progress'::regclass) THEN ALTER TABLE public.project_construction_progress ADD CONSTRAINT "project_construction_progress_completion_consistent_check" CHECK (is_completed = true AND actual_completed_date IS NOT NULL OR is_completed = false AND actual_completed_date IS NULL); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_construction_progress_sort_order_nonnegative_check' AND conrelid='public.project_construction_progress'::regclass) THEN ALTER TABLE public.project_construction_progress ADD CONSTRAINT "project_construction_progress_sort_order_nonnegative_check" CHECK (sort_order >= 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_construction_progress_work_type_check' AND conrelid='public.project_construction_progress'::regclass) THEN ALTER TABLE public.project_construction_progress ADD CONSTRAINT "project_construction_progress_work_type_check" CHECK (work_type = ANY (ARRAY['racking'::text, 'electrical'::text, 'steel'::text, 'roof_cover'::text, 'civil'::text, 'other'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_evaluator_name_not_blank' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_evaluator_name_not_blank" CHECK (btrim(evaluator_name) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_overall_check' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_overall_check" CHECK (overall_difficulty >= 1 AND overall_difficulty <= 5); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_owner_communication_check' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_owner_communication_check" CHECK (owner_communication_difficulty >= 1 AND owner_communication_difficulty <= 5); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_site_construction_check' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_site_construction_check" CHECK (site_construction_difficulty >= 1 AND site_construction_difficulty <= 5); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_site_coordination_check' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_site_coordination_check" CHECK (site_coordination_difficulty >= 1 AND site_coordination_difficulty <= 5); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_type_check' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_type_check" CHECK (assessment_type = ANY (ARRAY['PRE_ESTIMATE'::text, 'POST_EXECUTION'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_completion_consistency' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_completion_consistency" CHECK ((status = 'COMPLETED'::text) = (actual_date IS NOT NULL)); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_key_not_blank' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_key_not_blank" CHECK (btrim(milestone_key) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_label_not_blank' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_label_not_blank" CHECK (btrim(label) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_origin_check' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_origin_check" CHECK (origin = ANY (ARRAY['TEMPLATE'::text, 'PROJECT_CUSTOM'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_phase_key_snapshot_not_blank' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_phase_key_snapshot_not_blank" CHECK (btrim(phase_key_snapshot) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_phase_name_snapshot_not_blank' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_phase_name_snapshot_not_blank" CHECK (btrim(phase_name_snapshot) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_sort_order_nonnegative' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_sort_order_nonnegative" CHECK (sort_order >= 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_status_check' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_status_check" CHECK (status = ANY (ARRAY['NOT_STARTED'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'BLOCKED'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_template_provenance_check' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_template_provenance_check" CHECK (origin = 'TEMPLATE'::text AND source_template_step_id IS NOT NULL OR origin = 'PROJECT_CUSTOM'::text AND source_template_step_id IS NULL); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_type_key_snapshot_not_blank' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_type_key_snapshot_not_blank" CHECK (btrim(type_key_snapshot) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_type_name_snapshot_not_blank' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_type_name_snapshot_not_blank" CHECK (btrim(type_name_snapshot) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_instances_template_key_snapshot_not_blank' AND conrelid='public.project_workflow_instances'::regclass) THEN ALTER TABLE public.project_workflow_instances ADD CONSTRAINT "project_workflow_instances_template_key_snapshot_not_blank" CHECK (btrim(template_key_snapshot) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_instances_template_name_snapshot_not_blank' AND conrelid='public.project_workflow_instances'::regclass) THEN ALTER TABLE public.project_workflow_instances ADD CONSTRAINT "project_workflow_instances_template_name_snapshot_not_blank" CHECK (btrim(template_name_snapshot) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_phases_key_not_blank' AND conrelid='public.project_workflow_phases'::regclass) THEN ALTER TABLE public.project_workflow_phases ADD CONSTRAINT "project_workflow_phases_key_not_blank" CHECK (btrim(phase_key) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_phases_name_not_blank' AND conrelid='public.project_workflow_phases'::regclass) THEN ALTER TABLE public.project_workflow_phases ADD CONSTRAINT "project_workflow_phases_name_not_blank" CHECK (btrim(name) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_phases_sort_order_nonnegative' AND conrelid='public.project_workflow_phases'::regclass) THEN ALTER TABLE public.project_workflow_phases ADD CONSTRAINT "project_workflow_phases_sort_order_nonnegative" CHECK (sort_order >= 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_key_not_blank' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_key_not_blank" CHECK (btrim(step_key) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_label_not_blank' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_label_not_blank" CHECK (btrim(label) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_sort_order_nonnegative' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_sort_order_nonnegative" CHECK (sort_order >= 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_templates_key_not_blank' AND conrelid='public.project_workflow_templates'::regclass) THEN ALTER TABLE public.project_workflow_templates ADD CONSTRAINT "project_workflow_templates_key_not_blank" CHECK (btrim(template_key) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_templates_name_not_blank' AND conrelid='public.project_workflow_templates'::regclass) THEN ALTER TABLE public.project_workflow_templates ADD CONSTRAINT "project_workflow_templates_name_not_blank" CHECK (btrim(name) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_types_key_not_blank' AND conrelid='public.project_workflow_types'::regclass) THEN ALTER TABLE public.project_workflow_types ADD CONSTRAINT "project_workflow_types_key_not_blank" CHECK (btrim(type_key) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_types_name_not_blank' AND conrelid='public.project_workflow_types'::regclass) THEN ALTER TABLE public.project_workflow_types ADD CONSTRAINT "project_workflow_types_name_not_blank" CHECK (btrim(name) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_types_sort_order_nonnegative' AND conrelid='public.project_workflow_types'::regclass) THEN ALTER TABLE public.project_workflow_types ADD CONSTRAINT "project_workflow_types_sort_order_nonnegative" CHECK (sort_order >= 0); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_task_types_name_not_blank' AND conrelid='public.schedule_task_types'::regclass) THEN ALTER TABLE public.schedule_task_types ADD CONSTRAINT "schedule_task_types_name_not_blank" CHECK (lower(btrim(replace(name, chr(12288), ' '::text))) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_tasks_creation_source_check' AND conrelid='public.schedule_tasks'::regclass) THEN ALTER TABLE public.schedule_tasks ADD CONSTRAINT "schedule_tasks_creation_source_check" CHECK (creation_source = ANY (ARRAY['APP'::text, 'GOOGLE_IMPORT'::text, 'SYSTEM'::text, 'LEGACY'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_tasks_google_sync_status_check' AND conrelid='public.schedule_tasks'::regclass) THEN ALTER TABLE public.schedule_tasks ADD CONSTRAINT "schedule_tasks_google_sync_status_check" CHECK (google_sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text])); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='todos_rejection_fields_consistent' AND conrelid='public.todos'::regclass) THEN ALTER TABLE public.todos ADD CONSTRAINT "todos_rejection_fields_consistent" CHECK (status <> '已退件'::text OR rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND btrim(COALESCE(rejection_reason, ''::text)) <> ''::text); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_batches_item_id_fkey' AND conrelid='public.inventory_batches'::regclass) THEN ALTER TABLE public.inventory_batches ADD CONSTRAINT "inventory_batches_item_id_fkey" FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_batches_source_transaction_id_fkey' AND conrelid='public.inventory_batches'::regclass) THEN ALTER TABLE public.inventory_batches ADD CONSTRAINT "inventory_batches_source_transaction_id_fkey" FOREIGN KEY (source_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_items_initialization_id_fkey' AND conrelid='public.inventory_initialization_items'::regclass) THEN ALTER TABLE public.inventory_initialization_items ADD CONSTRAINT "inventory_initialization_items_initialization_id_fkey" FOREIGN KEY (initialization_id) REFERENCES inventory_initializations(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_items_inventory_item_id_fkey' AND conrelid='public.inventory_initialization_items'::regclass) THEN ALTER TABLE public.inventory_initialization_items ADD CONSTRAINT "inventory_initialization_items_inventory_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_serials_initialization_id_fkey' AND conrelid='public.inventory_initialization_serials'::regclass) THEN ALTER TABLE public.inventory_initialization_serials ADD CONSTRAINT "inventory_initialization_serials_initialization_id_fkey" FOREIGN KEY (initialization_id) REFERENCES inventory_initializations(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_serials_inventory_item_id_fkey' AND conrelid='public.inventory_initialization_serials'::regclass) THEN ALTER TABLE public.inventory_initialization_serials ADD CONSTRAINT "inventory_initialization_serials_inventory_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_initialization_serials_serial_id_fkey' AND conrelid='public.inventory_initialization_serials'::regclass) THEN ALTER TABLE public.inventory_initialization_serials ADD CONSTRAINT "inventory_initialization_serials_serial_id_fkey" FOREIGN KEY (serial_id) REFERENCES inventory_serials(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_monthly_closing_items_closing_id_fkey' AND conrelid='public.inventory_monthly_closing_items'::regclass) THEN ALTER TABLE public.inventory_monthly_closing_items ADD CONSTRAINT "inventory_monthly_closing_items_closing_id_fkey" FOREIGN KEY (closing_id) REFERENCES inventory_monthly_closings(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_monthly_closing_items_inventory_item_id_fkey' AND conrelid='public.inventory_monthly_closing_items'::regclass) THEN ALTER TABLE public.inventory_monthly_closing_items ADD CONSTRAINT "inventory_monthly_closing_items_inventory_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_serials_batch_id_fkey' AND conrelid='public.inventory_serials'::regclass) THEN ALTER TABLE public.inventory_serials ADD CONSTRAINT "inventory_serials_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_serials_item_id_fkey' AND conrelid='public.inventory_serials'::regclass) THEN ALTER TABLE public.inventory_serials ADD CONSTRAINT "inventory_serials_item_id_fkey" FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_serials_project_id_fkey' AND conrelid='public.inventory_serials'::regclass) THEN ALTER TABLE public.inventory_serials ADD CONSTRAINT "inventory_serials_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transaction_serials_serial_id_fkey' AND conrelid='public.inventory_transaction_serials'::regclass) THEN ALTER TABLE public.inventory_transaction_serials ADD CONSTRAINT "inventory_transaction_serials_serial_id_fkey" FOREIGN KEY (serial_id) REFERENCES inventory_serials(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transaction_serials_transaction_id_fkey' AND conrelid='public.inventory_transaction_serials'::regclass) THEN ALTER TABLE public.inventory_transaction_serials ADD CONSTRAINT "inventory_transaction_serials_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES inventory_transactions(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transactions_excluded_by_initialization_id_fkey' AND conrelid='public.inventory_transactions'::regclass) THEN ALTER TABLE public.inventory_transactions ADD CONSTRAINT "inventory_transactions_excluded_by_initialization_id_fkey" FOREIGN KEY (excluded_by_initialization_id) REFERENCES inventory_initializations(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transactions_item_id_fkey' AND conrelid='public.inventory_transactions'::regclass) THEN ALTER TABLE public.inventory_transactions ADD CONSTRAINT "inventory_transactions_item_id_fkey" FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_transactions_project_id_fkey' AND conrelid='public.inventory_transactions'::regclass) THEN ALTER TABLE public.inventory_transactions ADD CONSTRAINT "inventory_transactions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='member_positions_member_id_fkey' AND conrelid='public.member_positions'::regclass) THEN ALTER TABLE public.member_positions ADD CONSTRAINT "member_positions_member_id_fkey" FOREIGN KEY (member_id) REFERENCES team_members(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='member_positions_position_id_fkey' AND conrelid='public.member_positions'::regclass) THEN ALTER TABLE public.member_positions ADD CONSTRAINT "member_positions_position_id_fkey" FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_construction_progress_contractor_id_fkey' AND conrelid='public.project_construction_progress'::regclass) THEN ALTER TABLE public.project_construction_progress ADD CONSTRAINT "project_construction_progress_contractor_id_fkey" FOREIGN KEY (contractor_id) REFERENCES contractors(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_evaluator_user_id_fkey' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_evaluator_user_id_fkey" FOREIGN KEY (evaluator_user_id) REFERENCES team_members(id); END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_difficulty_assessments_project_id_fkey' AND conrelid='public.project_difficulty_assessments'::regclass) THEN ALTER TABLE public.project_difficulty_assessments ADD CONSTRAINT "project_difficulty_assessments_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_project_id_fkey' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_responsible_position_id_fkey' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_responsible_position_id_fkey" FOREIGN KEY (responsible_position_id) REFERENCES positions(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_source_phase_id_fkey' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_source_phase_id_fkey" FOREIGN KEY (source_phase_id) REFERENCES project_workflow_phases(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_source_template_step_id_fkey' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_source_template_step_id_fkey" FOREIGN KEY (source_template_step_id) REFERENCES project_workflow_template_steps(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_source_type_id_fkey' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_source_type_id_fkey" FOREIGN KEY (source_type_id) REFERENCES project_workflow_types(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_milestones_workflow_instance_id_fkey' AND conrelid='public.project_milestones'::regclass) THEN ALTER TABLE public.project_milestones ADD CONSTRAINT "project_milestones_workflow_instance_id_fkey" FOREIGN KEY (workflow_instance_id) REFERENCES project_workflow_instances(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_position_assignments_member_id_fkey' AND conrelid='public.project_position_assignments'::regclass) THEN ALTER TABLE public.project_position_assignments ADD CONSTRAINT "project_position_assignments_member_id_fkey" FOREIGN KEY (member_id) REFERENCES team_members(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_position_assignments_position_id_fkey' AND conrelid='public.project_position_assignments'::regclass) THEN ALTER TABLE public.project_position_assignments ADD CONSTRAINT "project_position_assignments_position_id_fkey" FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_instances_project_id_fkey' AND conrelid='public.project_workflow_instances'::regclass) THEN ALTER TABLE public.project_workflow_instances ADD CONSTRAINT "project_workflow_instances_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_instances_source_template_id_fkey' AND conrelid='public.project_workflow_instances'::regclass) THEN ALTER TABLE public.project_workflow_instances ADD CONSTRAINT "project_workflow_instances_source_template_id_fkey" FOREIGN KEY (source_template_id) REFERENCES project_workflow_templates(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_phase_id_fkey' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_phase_id_fkey" FOREIGN KEY (phase_id) REFERENCES project_workflow_phases(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_responsible_position_id_fkey' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_responsible_position_id_fkey" FOREIGN KEY (responsible_position_id) REFERENCES positions(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_template_id_fkey' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_template_id_fkey" FOREIGN KEY (template_id) REFERENCES project_workflow_templates(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_workflow_template_steps_type_id_fkey' AND conrelid='public.project_workflow_template_steps'::regclass) THEN ALTER TABLE public.project_workflow_template_steps ADD CONSTRAINT "project_workflow_template_steps_type_id_fkey" FOREIGN KEY (type_id) REFERENCES project_workflow_types(id) ON DELETE RESTRICT; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_tasks_created_by_user_id_fkey' AND conrelid='public.schedule_tasks'::regclass) THEN ALTER TABLE public.schedule_tasks ADD CONSTRAINT "schedule_tasks_created_by_user_id_fkey" FOREIGN KEY (created_by_user_id) REFERENCES team_members(id) ON DELETE SET NULL; END IF; END $ddl$;
DO $ddl$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='se_supply_records_project_id_fkey' AND conrelid='public.se_supply_records'::regclass) THEN ALTER TABLE public.se_supply_records ADD CONSTRAINT "se_supply_records_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL; END IF; END $ddl$;
DROP INDEX IF EXISTS public."project_position_assignments_project_id_position_id_key";
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON public.activity_logs USING btree (action);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_target ON public.activity_logs USING btree (target_type, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS contractors_pkey ON public.contractors USING btree (id);
CREATE INDEX IF NOT EXISTS idx_contractors_contractor_type ON public.contractors USING btree (contractor_type);
CREATE INDEX IF NOT EXISTS idx_contractors_deleted_at ON public.contractors USING btree (deleted_at);
CREATE INDEX IF NOT EXISTS idx_contractors_is_active ON public.contractors USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_contractors_name ON public.contractors USING btree (name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_batches_batch_number ON public.inventory_batches USING btree (batch_number);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_in_date ON public.inventory_batches USING btree (in_date);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_item_id ON public.inventory_batches USING btree (item_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_batches_pkey ON public.inventory_batches USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_batches_source_transaction_id_idx ON public.inventory_batches USING btree (source_transaction_id) WHERE (source_transaction_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_initialization_items_pkey ON public.inventory_initialization_items USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_initialization_serial_initialization_id_serial_id_key ON public.inventory_initialization_serials USING btree (initialization_id, serial_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_initialization_serials_pkey ON public.inventory_initialization_serials USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_initializations_pkey ON public.inventory_initializations USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_initializations_singleton_idx ON public.inventory_initializations USING btree ((true));
CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON public.inventory_items USING btree (category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_code ON public.inventory_items USING btree (code);
CREATE INDEX IF NOT EXISTS idx_inventory_items_is_active ON public.inventory_items USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_inventory_items_name ON public.inventory_items USING btree (name);
CREATE INDEX IF NOT EXISTS idx_inventory_items_source_type ON public.inventory_items USING btree (source_type);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_pkey ON public.inventory_items USING btree (id);
CREATE INDEX IF NOT EXISTS idx_inventory_monthly_closing_items_closing_id ON public.inventory_monthly_closing_items USING btree (closing_id);
CREATE INDEX IF NOT EXISTS idx_inventory_monthly_closing_items_inventory_item_id ON public.inventory_monthly_closing_items USING btree (inventory_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_monthly_closing_items_pkey ON public.inventory_monthly_closing_items USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_monthly_closings_year_month ON public.inventory_monthly_closings USING btree (year, month);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_monthly_closings_pkey ON public.inventory_monthly_closings USING btree (id);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_batch_id ON public.inventory_serials USING btree (batch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_item_id ON public.inventory_serials USING btree (item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serials_normalized_full ON public.inventory_serials USING btree (normalized_full);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_project_id ON public.inventory_serials USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serials_serial_number ON public.inventory_serials USING btree (serial_number);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_short_key ON public.inventory_serials USING btree (short_key) WHERE (short_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_status ON public.inventory_serials USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_serials_pkey ON public.inventory_serials USING btree (id);
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_serials_is_pending ON public.inventory_transaction_serials USING btree (is_pending);
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_serials_serial_id ON public.inventory_transaction_serials USING btree (serial_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transaction_serials_transaction_id ON public.inventory_transaction_serials USING btree (transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transaction_serials_pkey ON public.inventory_transaction_serials USING btree (id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_is_voided ON public.inventory_transactions USING btree (is_voided);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_item_id ON public.inventory_transactions USING btree (item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_project_id ON public.inventory_transactions USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_transaction_date ON public.inventory_transactions USING btree (transaction_date);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_transaction_type ON public.inventory_transactions USING btree (transaction_type);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_pkey ON public.inventory_transactions USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS member_positions_pkey ON public.member_positions USING btree (member_id, position_id);
CREATE INDEX IF NOT EXISTS member_positions_position_member_idx ON public.member_positions USING btree (position_id, member_id);
CREATE UNIQUE INDEX IF NOT EXISTS positions_active_name_unique_idx ON public.positions USING btree (lower(btrim(name))) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS positions_order_idx ON public.positions USING btree (is_active DESC, sort_order, name, id);
CREATE UNIQUE INDEX IF NOT EXISTS positions_pkey ON public.positions USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_construction_progress_active_fixed_work_type ON public.project_construction_progress USING btree (project_id, work_type) WHERE ((deleted_at IS NULL) AND (work_type = ANY (ARRAY['racking'::text, 'electrical'::text, 'steel'::text, 'roof_cover'::text, 'civil'::text])));
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_active_project_sort_order ON public.project_construction_progress USING btree (project_id, sort_order) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_contractor_id ON public.project_construction_progress USING btree (contractor_id);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_deleted_at ON public.project_construction_progress USING btree (deleted_at);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_project_id ON public.project_construction_progress USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_construction_progress_work_type ON public.project_construction_progress USING btree (work_type);
CREATE UNIQUE INDEX IF NOT EXISTS project_difficulty_assessments_pkey ON public.project_difficulty_assessments USING btree (id);
CREATE INDEX IF NOT EXISTS project_difficulty_assessments_project_id_idx ON public.project_difficulty_assessments USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_difficulty_assessments_project_type_unique ON public.project_difficulty_assessments USING btree (project_id, assessment_type);
CREATE UNIQUE INDEX IF NOT EXISTS project_milestones_active_instance_key_idx ON public.project_milestones USING btree (workflow_instance_id, milestone_key) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS project_milestones_active_project_planned_date_idx ON public.project_milestones USING btree (project_id, planned_date) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS project_milestones_active_project_sort_idx ON public.project_milestones USING btree (project_id, sort_order) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS project_milestones_active_project_status_idx ON public.project_milestones USING btree (project_id, status) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS project_milestones_active_template_step_idx ON public.project_milestones USING btree (workflow_instance_id, source_template_step_id) WHERE ((origin = 'TEMPLATE'::text) AND (deleted_at IS NULL));
CREATE INDEX IF NOT EXISTS project_milestones_responsible_position_idx ON public.project_milestones USING btree (project_id, responsible_position_id, sort_order) WHERE ((deleted_at IS NULL) AND (is_applicable = true) AND (responsible_position_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS project_position_assignments_member_project_idx ON public.project_position_assignments USING btree (member_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_position_assignments_project_position_key ON public.project_position_assignments USING btree (project_id, position_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_instances_one_active_project_idx ON public.project_workflow_instances USING btree (project_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_instances_pkey ON public.project_workflow_instances USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_phases_phase_key_key ON public.project_workflow_phases USING btree (phase_key);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_phases_pkey ON public.project_workflow_phases USING btree (id);
CREATE INDEX IF NOT EXISTS project_workflow_template_steps_lookup_idx ON public.project_workflow_template_steps USING btree (template_id, is_active, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_template_steps_pkey ON public.project_workflow_template_steps USING btree (id);
CREATE INDEX IF NOT EXISTS project_workflow_template_steps_responsible_position_idx ON public.project_workflow_template_steps USING btree (responsible_position_id) WHERE (responsible_position_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_template_steps_template_step_key_key ON public.project_workflow_template_steps USING btree (template_id, step_key);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_templates_one_active_default_idx ON public.project_workflow_templates USING btree (is_default) WHERE ((is_active = true) AND (is_default = true));
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_templates_pkey ON public.project_workflow_templates USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_templates_template_key_key ON public.project_workflow_templates USING btree (template_key);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_types_pkey ON public.project_workflow_types USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS project_workflow_types_type_key_key ON public.project_workflow_types USING btree (type_key);
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON public.projects USING btree (deleted_at);
CREATE INDEX IF NOT EXISTS idx_projects_project_code ON public.projects USING btree (project_code);
CREATE INDEX IF NOT EXISTS idx_projects_project_name ON public.projects USING btree (project_name);
CREATE INDEX IF NOT EXISTS idx_projects_responsible_member_name ON public.projects USING btree (responsible_member_name);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_task_types_normalized_name_key ON public.schedule_task_types USING btree (lower(btrim(replace(name, chr(12288), ' '::text))));
CREATE UNIQUE INDEX IF NOT EXISTS schedule_task_types_pkey ON public.schedule_task_types USING btree (id);
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_deleted_at ON public.schedule_tasks USING btree (deleted_at);
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_task_date ON public.schedule_tasks USING btree (task_date);
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_task_date_not_deleted ON public.schedule_tasks USING btree (task_date) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS schedule_tasks_created_by_user_id_idx ON public.schedule_tasks USING btree (created_by_user_id);
CREATE INDEX IF NOT EXISTS schedule_tasks_creation_source_idx ON public.schedule_tasks USING btree (creation_source);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_tasks_google_calendar_event_unique_idx ON public.schedule_tasks USING btree (google_calendar_id, google_event_id) WHERE (google_event_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_se_supply_records_project_id ON public.se_supply_records USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS se_supply_records_pkey ON public.se_supply_records USING btree (id);
CREATE INDEX IF NOT EXISTS idx_team_members_email ON public.team_members USING btree (email);
CREATE INDEX IF NOT EXISTS idx_team_members_is_active ON public.team_members USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_todos_assigned_to_status ON public.todos USING btree (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_todos_created_by ON public.todos USING btree (created_by);

-- Canonical functions (public + app_private).
CREATE OR REPLACE FUNCTION app_private.current_member_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT member.id
  FROM public.team_members AS member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL
  ORDER BY member.id
  LIMIT 1;
$function$;
CREATE OR REPLACE FUNCTION app_private.default_legacy_schedule_work_group()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.work_group_id IS NULL THEN
    SELECT work_group.id INTO NEW.work_group_id
    FROM public.work_groups AS work_group
    WHERE work_group.key = 'ENGINEERING';

    IF NEW.work_group_id IS NULL THEN
      RAISE EXCEPTION 'ENGINEERING work group is not configured'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.default_legacy_team_todo_work_group()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.scope = 'TEAM' AND NEW.work_group_id IS NULL THEN
    SELECT work_group.id INTO NEW.work_group_id
    FROM public.work_groups AS work_group
    WHERE work_group.key = 'ENGINEERING';

    IF NEW.work_group_id IS NULL THEN
      RAISE EXCEPTION 'ENGINEERING work group is not configured'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.enforce_active_work_zone_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_owner_member_id uuid;
  v_active_count integer;
BEGIN
  v_owner_member_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.owner_member_id ELSE NEW.owner_member_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner_member_id::text, 0));
  SELECT count(*) INTO v_active_count
  FROM public.work_zones
  WHERE owner_member_id = v_owner_member_id AND is_active;
  IF v_active_count > 3 THEN
    RAISE EXCEPTION 'member % cannot have more than 3 active work zones (found %)',
      v_owner_member_id, v_active_count USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.enforce_inventory_monthly_closing_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'CLOSED' THEN
      RAISE EXCEPTION '已封存月結不可刪除，請先解除封存'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status NOT IN ('OPEN', 'CLOSED') THEN
    RAISE EXCEPTION '不支援的月結狀態：%', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'CLOSED'
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION '只有管理員可以解除庫存月結封存'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.ensure_inventory_batch_for_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_prefix text;
  v_sequence integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.transaction_type IS NOT DISTINCT FROM NEW.transaction_type
  THEN
    RETURN NEW;
  END IF;

  IF NEW.transaction_type NOT IN ('IN', 'RETURN')
     OR NEW.is_voided
     OR NEW.source IS NOT DISTINCT FROM 'INVENTORY_INITIALIZATION_PENDING'
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inventory_batches batch
    WHERE batch.source_transaction_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  v_prefix := 'IN-' || replace(NEW.transaction_date::text, '-', '') || '-';
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory_batch:' || v_prefix, 0));

  SELECT coalesce(max(right(batch.batch_number, 3)::integer), 0) + 1
  INTO v_sequence
  FROM public.inventory_batches batch
  WHERE batch.batch_number LIKE v_prefix || '%'
    AND right(batch.batch_number, 3) ~ '^[0-9]{3}$';

  INSERT INTO public.inventory_batches (
    batch_number, item_id, source_transaction_id, in_date, source,
    quantity, unit, handler, notes
  ) VALUES (
    v_prefix || lpad(v_sequence::text, 3, '0'),
    NEW.item_id,
    NEW.id,
    NEW.transaction_date,
    coalesce(NEW.source, CASE WHEN NEW.transaction_type = 'RETURN' THEN '退料' ELSE NULL END),
    NEW.quantity,
    NEW.unit,
    NEW.handler,
    NEW.notes
  );

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.guard_workflow_framework_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'New milestones cannot start archived' USING ERRCODE='23514'; END IF;
  SELECT sort_order INTO NEW.phase_sort_order_snapshot FROM public.project_workflow_phases WHERE id=NEW.source_phase_id;
 ELSIF NEW.archived_at IS DISTINCT FROM OLD.archived_at
 OR (NEW.origin='TEMPLATE' AND (NEW.label IS DISTINCT FROM OLD.label OR NEW.responsible_position_id IS DISTINCT FROM OLD.responsible_position_id OR NEW.phase_sort_order_snapshot IS DISTINCT FROM OLD.phase_sort_order_snapshot)) THEN
  IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin may update framework metadata' USING ERRCODE='42501'; END IF;
  IF NEW.origin='PROJECT_CUSTOM' THEN RAISE EXCEPTION 'Custom milestones cannot be archived by template rebuild' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION app_private.is_active_member()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  select exists (
    select 1
    from public.team_members tm
    where lower(tm.email) = lower(auth.jwt() ->> 'email')
      and tm.is_active = true
      and tm.deleted_at is null
  );
$function$;
CREATE OR REPLACE FUNCTION app_private.is_admin_member()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  select exists (
    select 1
    from public.team_members tm
    where lower(tm.email) = lower(auth.jwt() ->> 'email')
      and tm.is_active = true
      and tm.deleted_at is null
      and lower(tm.role) = 'admin'
  );
$function$;
CREATE OR REPLACE FUNCTION app_private.is_editor_member()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE lower(tm.email) = lower(auth.jwt() ->> 'email')
      AND tm.is_active = true
      AND tm.deleted_at IS NULL
      AND lower(tm.role) IN ('admin', 'engineer')
  );
$function$;
CREATE OR REPLACE FUNCTION app_private.log_todo_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor record;
  event_action text;
  event_message text;
  assigned_name text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.scope = 'PRIVATE' THEN
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND (OLD.scope = 'PRIVATE' OR NEW.scope = 'PRIVATE') THEN
    RETURN NEW;
  END IF;

  SELECT member.id, member.name
  INTO actor
  FROM public.team_members member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL
  LIMIT 1;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.activity_logs (
      action, target_type, target_id, description, changes,
      user_id, user_name, actor_user_id, actor_name, action_type,
      target_label, project_id, before_value, after_value, message
    ) VALUES (
      'CREATE_TODO', 'Todo', NEW.id::text, '建立待辦',
      jsonb_build_object('before', NULL, 'after', to_jsonb(NEW)),
      COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
      COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
      'CREATE_TODO', NEW.title, NEW.project_id::text, NULL, NEW.status, '建立待辦'
    );

    IF NEW.assigned_to IS NOT NULL THEN
      SELECT name INTO assigned_name
      FROM public.team_members
      WHERE id = NEW.assigned_to;

      INSERT INTO public.activity_logs (
        action, target_type, target_id, description, changes,
        user_id, user_name, actor_user_id, actor_name, action_type,
        target_label, project_id, before_value, after_value, message
      ) VALUES (
        'ASSIGN_TODO', 'Todo', NEW.id::text, '指派待辦',
        jsonb_build_object('before', NULL, 'after', NEW.assigned_to),
        COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
        COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
        'ASSIGN_TODO', NEW.title, NEW.project_id::text, NULL, NEW.assigned_to::text,
        format('指派給 %s', COALESCE(assigned_name, '未知人員'))
      );
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status = '已退件' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_action := 'REJECT_TODO';
    event_message := format('退件原因：%s', NEW.rejection_reason);
  ELSIF OLD.status = '已退件' AND NEW.status = '待安排' THEN
    event_action := 'REASSIGN_TODO';
    SELECT name INTO assigned_name FROM public.team_members WHERE id = NEW.assigned_to;
    event_message := format('修改後重新指派給 %s', COALESCE(assigned_name, '未指派'));
  ELSIF NEW.status = '已完成' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_action := 'COMPLETE_TODO';
    event_message := '完成待辦';
  ELSIF NEW.status = '取消' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_action := 'VOID_TODO';
    event_message := '作廢待辦';
  ELSIF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    event_action := 'ASSIGN_TODO';
    SELECT name INTO assigned_name FROM public.team_members WHERE id = NEW.assigned_to;
    event_message := format('指派給 %s', COALESCE(assigned_name, '未指派'));
  ELSE
    event_action := 'UPDATE_TODO';
    event_message := '修改待辦';
  END IF;

  INSERT INTO public.activity_logs (
    action, target_type, target_id, description, changes,
    user_id, user_name, actor_user_id, actor_name, action_type,
    target_label, project_id, before_value, after_value, message
  ) VALUES (
    event_action, 'Todo', NEW.id::text, event_message,
    jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW)),
    COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
    COALESCE(actor.id::text, 'system'), COALESCE(actor.name, '系統'),
    event_action, NEW.title, NEW.project_id::text, OLD.status, NEW.status, event_message
  );

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.normalize_contractor_work_capabilities()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    IF NEW.work_capabilities IS NULL
       OR cardinality(NEW.work_capabilities) = 0 THEN
        NEW.work_capabilities := ARRAY[NEW.contractor_type];
    ELSIF NOT (NEW.contractor_type = ANY(NEW.work_capabilities)) THEN
        NEW.work_capabilities := array_append(
            NEW.work_capabilities,
            NEW.contractor_type
        );
    END IF;

    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.normalize_work_item_project_label()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT project.project_name INTO NEW.project_label
    FROM public.projects AS project
    WHERE project.id = NEW.project_id;
  ELSE
    NEW.project_label := NULLIF(btrim(NEW.project_label), '');
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.prepare_work_item_todo_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_todo public.todos;
BEGIN
  IF NEW.source_todo_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT todo.* INTO v_todo
  FROM public.todos AS todo
  WHERE todo.id = NEW.source_todo_id
    AND todo.scope = 'PRIVATE'
    AND todo.created_by = NEW.owner_member_id
    AND todo.status = '待安排'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible private Todo source not found'
      USING ERRCODE = '23514';
  END IF;

  NEW.source_created_at := v_todo.created_at;
  NEW.received_at := v_todo.received_at;

  UPDATE public.todos
  SET status = '已收納', updated_at = now()
  WHERE id = v_todo.id;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.preserve_schedule_task_creation_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  NEW.created_by_user_id := OLD.created_by_user_id;
  NEW.created_by_name := OLD.created_by_name;
  NEW.creation_source := OLD.creation_source;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.protect_project_difficulty_assessment_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.assessment_type IS DISTINCT FROM OLD.assessment_type
     OR NEW.evaluator_user_id IS DISTINCT FROM OLD.evaluator_user_id
     OR NEW.evaluator_name IS DISTINCT FROM OLD.evaluator_name THEN
    RAISE EXCEPTION 'Project difficulty assessment provenance is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.protect_project_workflow_instance_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.source_template_id IS DISTINCT FROM OLD.source_template_id
       OR NEW.template_key_snapshot IS DISTINCT FROM OLD.template_key_snapshot
       OR NEW.template_name_snapshot IS DISTINCT FROM OLD.template_name_snapshot
       OR NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at THEN
        RAISE EXCEPTION 'Project workflow instance provenance is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.protect_voided_inventory_serial_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF OLD.status <> '作廢' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '作廢序號必須保留歷史，不可刪除';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION '作廢序號的狀態、序號與來源批次不可修改';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.protect_work_item_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id
     OR NEW.source_todo_id IS DISTINCT FROM OLD.source_todo_id
     OR NEW.source_created_at IS DISTINCT FROM OLD.source_created_at THEN
    RAISE EXCEPTION 'work item owner and source provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.reject_closed_month_inventory_transaction_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  checked_date date;
  checked_month text;
  scoped_initialization_id uuid;
BEGIN
  scoped_initialization_id := NULLIF(
    current_setting('app.inventory_initialization_id', true),
    ''
  )::uuid;

  IF scoped_initialization_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.inventory_initializations initialization
      WHERE initialization.id = scoped_initialization_id
        AND initialization.initialized_by = auth.uid()::text
    )
  THEN
    IF TG_OP = 'DELETE'
      AND OLD.is_voided = true
      AND OLD.transaction_date < DATE '2026-08-25'
    THEN
      RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE'
      AND OLD.excluded_by_initialization_id IS NULL
      AND NEW.excluded_by_initialization_id = scoped_initialization_id
      AND (to_jsonb(NEW) - 'excluded_by_initialization_id')
        = (to_jsonb(OLD) - 'excluded_by_initialization_id')
    THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    checked_date := NEW.transaction_date;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_monthly_closings closing
      WHERE closing.year = to_char(checked_date, 'YYYY')
        AND closing.month = to_char(checked_date, 'MM')
        AND closing.status = 'CLOSED'
    ) THEN
      checked_month := to_char(checked_date, 'YYYY-MM');
      RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    checked_date := OLD.transaction_date;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_monthly_closings closing
      WHERE closing.year = to_char(checked_date, 'YYYY')
        AND closing.month = to_char(checked_date, 'MM')
        AND closing.status = 'CLOSED'
    ) THEN
      checked_month := to_char(checked_date, 'YYYY-MM');
      RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
        USING ERRCODE = 'check_violation';
    END IF;

    checked_date := NEW.transaction_date;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_monthly_closings closing
      WHERE closing.year = to_char(checked_date, 'YYYY')
        AND closing.month = to_char(checked_date, 'MM')
        AND closing.status = 'CLOSED'
    ) THEN
      checked_month := to_char(checked_date, 'YYYY-MM');
      RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  checked_date := OLD.transaction_date;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_monthly_closings closing
    WHERE closing.year = to_char(checked_date, 'YYYY')
      AND closing.month = to_char(checked_date, 'MM')
      AND closing.status = 'CLOSED'
  ) THEN
    checked_month := to_char(checked_date, 'YYYY-MM');
    RAISE EXCEPTION '% 已封存，請先解除月結後再修改庫存紀錄', checked_month
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_initialization_id_text text;
begin
  if old.opening_quantity is not distinct from new.opening_quantity then
    return new;
  end if;

  v_initialization_id_text := nullif(
    pg_catalog.current_setting('app.inventory_initialization_id', true),
    ''
  );

  if v_initialization_id_text is not null
     and exists (
       select 1
       from public.inventory_initializations initialization
       where initialization.id = v_initialization_id_text::uuid
         and initialization.initialized_by = auth.uid()::text
     ) then
    return new;
  end if;

  if exists (
    select 1
    from public.inventory_monthly_closing_items closing_item
    where closing_item.inventory_item_id = old.id
  ) then
    raise exception '此品項已有月結紀錄，初始庫存已鎖定，請使用庫存調整'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION app_private.reject_owner_team_member_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  owner_team_member_id constant uuid := '65916798-f0ec-4d41-8b17-785c4189bd83'::uuid;
  owner_email constant text := 'shypomelo@gmail.com';
BEGIN
  IF TG_OP = 'DELETE' AND OLD.id = owner_team_member_id THEN
    RAISE EXCEPTION 'System owner team member cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.id = owner_team_member_id THEN
    IF lower(btrim(NEW.email)) <> owner_email THEN
      RAISE EXCEPTION 'System owner email cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'System owner role cannot be changed from admin'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'System owner cannot be deactivated'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'System owner cannot be soft deleted'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.safely_void_inventory_in_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
BEGIN
  IF OLD.transaction_type <> 'IN'
     OR OLD.is_voided IS TRUE
     OR NEW.is_voided IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION '僅限管理員作廢入庫紀錄';
  END IF;

  IF NULLIF(BTRIM(NEW.voided_reason), '') IS NULL THEN
    RAISE EXCEPTION '作廢入庫必須填寫原因';
  END IF;

  PERFORM 1
  FROM public.inventory_serials serial
  JOIN public.inventory_transaction_serials origin_link
    ON origin_link.serial_id = serial.id
  WHERE origin_link.transaction_id = OLD.id
  ORDER BY serial.id
  FOR UPDATE OF serial;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_transaction_serials origin_link
    JOIN public.inventory_serials serial
      ON serial.id = origin_link.serial_id
    WHERE origin_link.transaction_id = OLD.id
      AND (
        serial.status <> '在庫'
        OR EXISTS (
          SELECT 1
          FROM public.inventory_transaction_serials later_link
          JOIN public.inventory_transactions later_transaction
            ON later_transaction.id = later_link.transaction_id
          WHERE later_link.serial_id = origin_link.serial_id
            AND later_link.transaction_id <> OLD.id
            AND later_transaction.is_voided IS NOT TRUE
        )
      )
  ) THEN
    RAISE EXCEPTION '此入庫批次已有序號被使用，請先處理相關序號後再作廢入庫。';
  END IF;

  UPDATE public.inventory_serials serial
  SET status = '作廢',
      project_id = NULL,
      updated_at = NOW()
  WHERE EXISTS (
    SELECT 1
    FROM public.inventory_transaction_serials origin_link
    WHERE origin_link.transaction_id = OLD.id
      AND origin_link.serial_id = serial.id
  );

  NEW.voided_at := COALESCE(NEW.voided_at, NOW());
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_position_responsibility_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_project_construction_progress_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_project_difficulty_assessment_evaluator()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  matching_member_ids uuid[];
  matching_member_names text[];
BEGIN
  SELECT array_agg(member.id), array_agg(member.name)
  INTO matching_member_ids, matching_member_names
  FROM public.team_members AS member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL;

  IF coalesce(cardinality(matching_member_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'Exactly one active evaluator identity is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  NEW.evaluator_user_id := matching_member_ids[1];
  NEW.evaluator_name := matching_member_names[1];

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_project_workflow_v2_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_schedule_task_types_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_todo_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor_id uuid;
BEGIN
  IF OLD.scope IS DISTINCT FROM NEW.scope THEN
    RAISE EXCEPTION 'Todo scope cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The original creator and first assigner are historical ownership fields.
  IF OLD.created_by IS NOT NULL THEN
    NEW.created_by := OLD.created_by;
  END IF;
  IF OLD.assigned_by IS NOT NULL THEN
    NEW.assigned_by := OLD.assigned_by;
  END IF;

  IF NEW.status = '已退件' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status <> '待安排' THEN
      RAISE EXCEPTION '只有待安排的待辦可以退件'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT member.id
    INTO actor_id
    FROM public.team_members member
    WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
      AND member.is_active = true
      AND member.deleted_at IS NULL
    LIMIT 1;

    IF OLD.assigned_to IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION '只有被指派人可以退件'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF btrim(COALESCE(NEW.rejection_reason, '')) = '' THEN
      RAISE EXCEPTION '退件原因不可空白'
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.rejected_by := actor_id;
    NEW.rejected_at := now();
    NEW.rejection_reason := btrim(NEW.rejection_reason);
  ELSIF OLD.status = '已退件' AND NEW.status = '已退件' THEN
    NEW.rejected_by := OLD.rejected_by;
    NEW.rejected_at := OLD.rejected_at;
    NEW.rejection_reason := OLD.rejection_reason;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.set_workbench_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.validate_project_milestone_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_instance_project_id uuid;
    v_instance_template_id uuid;
    v_phase_key text;
    v_phase_name text;
    v_type_key text;
    v_type_name text;
    v_template_step record;
BEGIN
    SELECT instance.project_id, instance.source_template_id
    INTO v_instance_project_id, v_instance_template_id
    FROM public.project_workflow_instances AS instance
    WHERE instance.id = NEW.workflow_instance_id
      AND instance.deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project milestone requires an active workflow instance'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.project_id IS DISTINCT FROM v_instance_project_id THEN
        RAISE EXCEPTION 'Project milestone project_id must match its workflow instance'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id
           OR NEW.project_id IS DISTINCT FROM OLD.project_id
           OR NEW.origin IS DISTINCT FROM OLD.origin
           OR NEW.source_template_step_id IS DISTINCT FROM OLD.source_template_step_id
           OR NEW.milestone_key IS DISTINCT FROM OLD.milestone_key THEN
            RAISE EXCEPTION 'Project milestone identity provenance is immutable'
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.origin = 'TEMPLATE' THEN
            IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
                RAISE EXCEPTION 'Template milestones cannot be soft-deleted; set is_applicable to false instead'
                    USING ERRCODE = 'check_violation';
            END IF;

            IF NEW.source_phase_id IS DISTINCT FROM OLD.source_phase_id
               OR NEW.source_type_id IS DISTINCT FROM OLD.source_type_id
               OR NEW.phase_key_snapshot IS DISTINCT FROM OLD.phase_key_snapshot
               OR NEW.phase_name_snapshot IS DISTINCT FROM OLD.phase_name_snapshot
               OR NEW.type_key_snapshot IS DISTINCT FROM OLD.type_key_snapshot
               OR NEW.type_name_snapshot IS DISTINCT FROM OLD.type_name_snapshot THEN
                IF NOT coalesce(app_private.is_admin_member(),false) OR NOT EXISTS (
                    SELECT 1 FROM public.project_workflow_template_steps s
                    JOIN public.project_workflow_phases p ON p.id=s.phase_id
                    JOIN public.project_workflow_types t ON t.id=s.type_id
                    WHERE s.id=OLD.source_template_step_id AND s.template_id=v_instance_template_id
                    AND s.is_active AND p.is_active AND t.is_active
                    AND NEW.source_phase_id=p.id AND NEW.phase_key_snapshot=p.phase_key
                    AND NEW.phase_name_snapshot=p.name AND NEW.source_type_id=t.id
                    AND NEW.type_key_snapshot=t.type_key AND NEW.type_name_snapshot=t.name
                ) THEN
                    RAISE EXCEPTION 'Template framework changes require admin and exact canonical step'
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
        ELSE
            IF NEW.source_phase_id IS DISTINCT FROM OLD.source_phase_id
               OR NEW.source_type_id IS DISTINCT FROM OLD.source_type_id THEN
                SELECT phase.phase_key, phase.name
                INTO v_phase_key, v_phase_name
                FROM public.project_workflow_phases AS phase
                WHERE phase.id = NEW.source_phase_id
                  AND phase.is_active = true;

                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Project custom milestone requires an active phase'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT workflow_type.type_key, workflow_type.name
                INTO v_type_key, v_type_name
                FROM public.project_workflow_types AS workflow_type
                WHERE workflow_type.id = NEW.source_type_id
                  AND workflow_type.is_active = true;

                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Project custom milestone requires an active type'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                NEW.phase_key_snapshot := v_phase_key;
                NEW.phase_name_snapshot := v_phase_name;
                NEW.type_key_snapshot := v_type_key;
                NEW.type_name_snapshot := v_type_name;
            ELSIF NEW.phase_key_snapshot IS DISTINCT FROM OLD.phase_key_snapshot
               OR NEW.phase_name_snapshot IS DISTINCT FROM OLD.phase_name_snapshot
               OR NEW.type_key_snapshot IS DISTINCT FROM OLD.type_key_snapshot
               OR NEW.type_name_snapshot IS DISTINCT FROM OLD.type_name_snapshot THEN
                RAISE EXCEPTION 'Custom milestone classification snapshots change only with phase/type'
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.origin = 'PROJECT_CUSTOM' THEN
        SELECT phase.phase_key, phase.name
        INTO v_phase_key, v_phase_name
        FROM public.project_workflow_phases AS phase
        WHERE phase.id = NEW.source_phase_id
          AND phase.is_active = true;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Project custom milestone requires an active phase'
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        SELECT workflow_type.type_key, workflow_type.name
        INTO v_type_key, v_type_name
        FROM public.project_workflow_types AS workflow_type
        WHERE workflow_type.id = NEW.source_type_id
          AND workflow_type.is_active = true;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Project custom milestone requires an active type'
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        NEW.phase_key_snapshot := v_phase_key;
        NEW.phase_name_snapshot := v_phase_name;
        NEW.type_key_snapshot := v_type_key;
        NEW.type_name_snapshot := v_type_name;
        RETURN NEW;
    END IF;

    SELECT
        step.template_id,
        step.step_key,
        step.label,
        step.phase_id,
        phase.phase_key,
        phase.name AS phase_name,
        step.type_id,
        workflow_type.type_key,
        workflow_type.name AS type_name,
        step.sort_order,
        step.default_is_applicable
    INTO v_template_step
    FROM public.project_workflow_template_steps AS step
    JOIN public.project_workflow_phases AS phase ON phase.id = step.phase_id
    JOIN public.project_workflow_types AS workflow_type ON workflow_type.id = step.type_id
    WHERE step.id = NEW.source_template_step_id
      AND step.template_id = v_instance_template_id
      AND step.is_active = true
      AND phase.is_active = true
      AND workflow_type.is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Template milestone requires an active step and classification from its source template'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.milestone_key := v_template_step.step_key;
    NEW.label := v_template_step.label;
    NEW.source_phase_id := v_template_step.phase_id;
    NEW.phase_key_snapshot := v_template_step.phase_key;
    NEW.phase_name_snapshot := v_template_step.phase_name;
    NEW.source_type_id := v_template_step.type_id;
    NEW.type_key_snapshot := v_template_step.type_key;
    NEW.type_name_snapshot := v_template_step.type_name;
    NEW.sort_order := v_template_step.sort_order;
    NEW.is_applicable := v_template_step.default_is_applicable;

    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION app_private.validate_project_position_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.team_members AS member
        JOIN public.member_positions AS member_position
          ON member_position.member_id = member.id
         AND member_position.position_id = NEW.position_id
        WHERE member.id = NEW.member_id
          AND member.is_active = true
          AND member.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Project assignee must be an active member with the selected position'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.classify_inventory_serial_format(p_serial text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'short'
    WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'full'
    ELSE 'unknown'
  END;
$function$;
CREATE OR REPLACE FUNCTION public.configure_my_work_zones(p_zones jsonb, p_move_to uuid DEFAULT NULL::uuid)
 RETURNS SETOF work_zones
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE owner_id uuid:=app_private.current_member_id(); z jsonb; zone_id uuid; zone_ids uuid[]:='{}'; n integer:=0;
BEGIN
 IF owner_id IS NULL THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF p_zones IS NULL OR jsonb_typeof(p_zones)<>'array' THEN RAISE EXCEPTION 'Configure exactly two or three zones' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(p_zones) NOT IN (2,3) THEN RAISE EXCEPTION 'Configure exactly two or three zones' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text,0));
 FOR z IN SELECT value FROM jsonb_array_elements(p_zones) LOOP
  IF coalesce(btrim(z->>'name'),'')='' THEN RAISE EXCEPTION 'Zone name required' USING ERRCODE='23514'; END IF;
  zone_id:=coalesce(nullif(z->>'id','')::uuid,gen_random_uuid());
  IF zone_id=ANY(zone_ids) THEN RAISE EXCEPTION 'Duplicate zone' USING ERRCODE='23514'; END IF;
  IF nullif(z->>'id','') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.work_zones WHERE id=zone_id AND owner_member_id=owner_id) THEN RAISE EXCEPTION 'Zone not owned' USING ERRCODE='42501'; END IF;
  zone_ids:=array_append(zone_ids,zone_id);
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.work_items WHERE owner_member_id=owner_id AND NOT work_zone_id=ANY(zone_ids)) THEN
  IF p_move_to IS NULL OR NOT p_move_to=ANY(zone_ids) THEN RAISE EXCEPTION 'Choose a retained zone for existing items' USING ERRCODE='23514'; END IF;
 END IF;
 UPDATE public.work_zones SET is_active=false,updated_at=now() WHERE owner_member_id=owner_id;
 FOR z IN SELECT value FROM jsonb_array_elements(p_zones) LOOP
  n:=n+1;
  INSERT INTO public.work_zones(id,owner_member_id,name,sort_order,is_active)
  VALUES(zone_ids[n],owner_id,btrim(z->>'name'),n,true)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,is_active=true,updated_at=now();
 END LOOP;
 UPDATE public.work_items SET work_zone_id=p_move_to,updated_at=now()
 WHERE owner_member_id=owner_id AND NOT work_zone_id=ANY(zone_ids);
 RETURN QUERY SELECT * FROM public.work_zones WHERE owner_member_id=owner_id AND is_active ORDER BY sort_order;
END $function$;
CREATE OR REPLACE FUNCTION public.derive_inventory_serial_short_key(p_serial text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH normalized AS (
    SELECT public.normalize_inventory_serial(p_serial) AS value
  )
  SELECT CASE
    WHEN value ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN value
    WHEN value ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$'
      THEN split_part(value, '-', 2) || '-' || split_part(value, '-', 3)
    ELSE NULL
  END
  FROM normalized;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_inventory_cutoff_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_baseline_date date;
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    SELECT baseline_date INTO v_baseline_date FROM inventory_initializations LIMIT 1;
    IF v_baseline_date IS NOT NULL THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.transaction_date::date <= v_baseline_date THEN
          RAISE EXCEPTION 'Cannot insert transaction on or before baseline date (%)', v_baseline_date;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.transaction_date::date <> OLD.transaction_date::date AND NEW.transaction_date::date <= v_baseline_date THEN
          RAISE EXCEPTION 'Cannot change transaction date to on or before baseline date (%)', v_baseline_date;
        END IF;

        IF OLD.transaction_date::date <= v_baseline_date AND NEW.transaction_date::date <= v_baseline_date THEN
          IF NEW.quantity <> OLD.quantity OR NEW.item_id <> OLD.item_id OR NEW.transaction_type <> OLD.transaction_type THEN
            RAISE EXCEPTION 'Cannot modify formal ledger fields of legacy transactions on or before baseline date (%)', v_baseline_date;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.initialize_inventory(items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_init_id uuid;
  v_item_data jsonb;
  v_item record;
  v_new_opening integer;
  v_in_stock_count integer;
  v_retained_ids jsonb;
  v_retained_count integer;
  v_unique_retained_count integer;
  v_invalid_count integer;
  v_pending_count integer;
  v_pending_tx_id uuid;

  v_initial_serial_count integer;
  v_final_serial_count integer;

  v_archived_tx_count integer := 0;
  v_deleted_void_tx_count integer := 0;
  v_existing_items_count integer;
  v_input_items_unique_count integer;
BEGIN
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    RAISE EXCEPTION 'Inventory has already been initialized.';
  END IF;

  IF (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date < DATE '2026-08-31' THEN
    RAISE EXCEPTION 'Cannot initialize inventory before 2026-08-31 (Asia/Taipei).';
  END IF;

  LOCK TABLE inventory_items IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_serials IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_transactions IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_transaction_serials IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_monthly_closings IN ROW EXCLUSIVE MODE;
  LOCK TABLE inventory_monthly_closing_items IN ROW EXCLUSIVE MODE;

  SELECT count(*) INTO v_existing_items_count FROM inventory_items;

  SELECT count(DISTINCT value->>'id')
  INTO v_input_items_unique_count
  FROM jsonb_array_elements(items);

  IF v_input_items_unique_count <> jsonb_array_length(items) THEN
    RAISE EXCEPTION 'Duplicate item IDs found in payload';
  END IF;

  IF jsonb_array_length(items) <> v_existing_items_count THEN
    RAISE EXCEPTION 'Item count mismatch';
  END IF;

  -- Validate the complete payload before changing any row.
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
    IF v_new_opening < 0 THEN
      RAISE EXCEPTION 'Negative quantity not allowed for %', v_item_data->>'id';
    END IF;

    SELECT * INTO v_item
    FROM inventory_items
    WHERE id = (v_item_data->>'id')::uuid;

    IF v_item IS NULL THEN
      RAISE EXCEPTION 'Item not found: %', v_item_data->>'id';
    END IF;

    IF v_item.requires_serial THEN
      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      IF v_retained_ids IS NULL OR jsonb_typeof(v_retained_ids) <> 'array' THEN
        RAISE EXCEPTION 'Serialized item % must explicitly specify retained serial IDs', v_item.name;
      END IF;

      v_retained_count := jsonb_array_length(v_retained_ids);

      SELECT count(DISTINCT value)
      INTO v_unique_retained_count
      FROM jsonb_array_elements_text(v_retained_ids);

      IF v_retained_count <> v_unique_retained_count THEN
        RAISE EXCEPTION 'Duplicate retained serial IDs provided for item %', v_item.name;
      END IF;

      IF v_retained_count > 0 THEN
        SELECT count(*) INTO v_invalid_count
        FROM jsonb_array_elements_text(v_retained_ids) AS rid
        WHERE NOT EXISTS (
          SELECT 1
          FROM inventory_serials serial
          WHERE serial.id = rid::uuid
            AND serial.item_id = v_item.id
            AND serial.status = '在庫'
            AND serial.short_key IS NOT NULL
        );

        IF v_invalid_count > 0 THEN
          RAISE EXCEPTION 'Invalid, non-stock, or non-standard retained serial IDs provided for item %', v_item.name;
        END IF;
      END IF;

      IF v_new_opening < v_retained_count THEN
        RAISE EXCEPTION 'Opening quantity < retained serial count for %', v_item.name;
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_initial_serial_count FROM inventory_serials;

  INSERT INTO inventory_initializations (baseline_date, initialized_by)
  VALUES (DATE '2026-08-31', auth.uid()::text)
  RETURNING id INTO v_init_id;

  -- Transaction-local capability consumed by the closed-month guard. It permits
  -- only the two initialization mutations defined above and disappears at commit.
  PERFORM pg_catalog.set_config(
    'app.inventory_initialization_id',
    v_init_id::text,
    true
  );

  -- Audit every current in-stock serial. Explicitly retained rows stay in stock;
  -- every other candidate leaves current stock but remains in serial history.
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    SELECT * INTO v_item
    FROM inventory_items
    WHERE id = (v_item_data->>'id')::uuid;

    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;

    IF v_item.requires_serial THEN
      SELECT count(*) INTO v_in_stock_count
      FROM inventory_serials
      WHERE item_id = v_item.id AND status = '在庫';

      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      v_retained_count := jsonb_array_length(v_retained_ids);
      v_pending_count := v_new_opening - v_retained_count;

      INSERT INTO inventory_initialization_serials (
        initialization_id,
        inventory_item_id,
        serial_id,
        previous_status,
        new_status,
        is_retained
      )
      SELECT
        v_init_id,
        v_item.id,
        serial.id,
        '在庫',
        CASE
          WHEN serial.id IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid) THEN '在庫'
          ELSE '已出庫'
        END,
        serial.id IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid)
      FROM inventory_serials serial
      WHERE serial.item_id = v_item.id AND serial.status = '在庫';

      UPDATE inventory_serials serial
      SET status = '已出庫', updated_at = now()
      WHERE serial.item_id = v_item.id
        AND serial.status = '在庫'
        AND serial.id NOT IN (SELECT jsonb_array_elements_text(v_retained_ids)::uuid);
    ELSE
      v_in_stock_count := 0;
      v_retained_count := 0;
      v_pending_count := 0;
    END IF;

    INSERT INTO inventory_initialization_items (
      initialization_id,
      inventory_item_id,
      previous_opening_quantity,
      new_opening_quantity,
      in_stock_serial_count,
      pending_serial_count,
      retained_in_stock_serial_count,
      removed_from_stock_serial_count
    ) VALUES (
      v_init_id,
      v_item.id,
      v_item.opening_quantity,
      v_new_opening,
      v_in_stock_count,
      v_pending_count,
      v_retained_count,
      v_in_stock_count - v_retained_count
    );
  END LOOP;

  -- Keep every existing monthly closing and closing item exactly as stored.
  -- Delete only pre-cutoff voided transactions. Transaction serial links follow
  -- the transaction FK cascade; inventory_serials master rows remain untouched.
  WITH deleted_voids AS (
    DELETE FROM inventory_transactions
    WHERE is_voided = true
      AND transaction_date < DATE '2026-08-25'
    RETURNING id
  )
  SELECT count(*) INTO v_deleted_void_tx_count FROM deleted_voids;

  -- Preserve every remaining transaction, including voided rows on/after the
  -- cutoff, and exclude them from the new stock calculation.
  WITH archived AS (
    UPDATE inventory_transactions
    SET excluded_by_initialization_id = v_init_id
    WHERE excluded_by_initialization_id IS NULL
    RETURNING id
  )
  SELECT count(*) INTO v_archived_tx_count FROM archived;

  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE inventory_items
    SET opening_quantity = (v_item_data->>'new_opening_quantity')::integer
    WHERE id = (v_item_data->>'id')::uuid;
  END LOOP;

  -- Reuse the existing pending-serial workflow. These synthetic IN rows are
  -- excluded from stock calculation because the quantity is already included
  -- in opening_quantity; their pending links remain fillable after initialization.
  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    SELECT * INTO v_item
    FROM inventory_items
    WHERE id = (v_item_data->>'id')::uuid;

    IF v_item.requires_serial THEN
      v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      v_pending_count := v_new_opening - jsonb_array_length(v_retained_ids);

      IF v_pending_count > 0 THEN
        INSERT INTO inventory_transactions (
          item_id,
          transaction_type,
          transaction_date,
          quantity,
          unit,
          handler,
          source,
          notes,
          pending_serial_count,
          is_voided,
          excluded_by_initialization_id
        ) VALUES (
          v_item.id,
          'IN',
          DATE '2026-09-01',
          v_pending_count,
          v_item.unit,
          '系統',
          'INVENTORY_INITIALIZATION_PENDING',
          '初始化基準待補序號（數量已包含於期初庫存，不重複計算）',
          v_pending_count,
          false,
          v_init_id
        )
        RETURNING id INTO v_pending_tx_id;

        INSERT INTO inventory_transaction_serials (
          transaction_id,
          serial_id,
          serial_no,
          is_pending
        )
        SELECT v_pending_tx_id, NULL, NULL, true
        FROM generate_series(1, v_pending_count);
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_final_serial_count FROM inventory_serials;
  IF v_final_serial_count <> v_initial_serial_count THEN
    RAISE EXCEPTION 'Serial count mismatch! Expected %, found %', v_initial_serial_count, v_final_serial_count;
  END IF;

  UPDATE inventory_initializations
  SET archived_transaction_count = v_archived_tx_count,
      deleted_void_transaction_count = v_deleted_void_tx_count,
      preserved_serial_count = v_final_serial_count
  WHERE id = v_init_id;

  RETURN v_init_id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.lookup_inventory_serial(p_input text, p_item_id uuid DEFAULT NULL::uuid, p_allowed_statuses text[] DEFAULT NULL::text[])
 RETURNS TABLE(result_type text, candidate_count integer, filtered_candidate_count integer, id uuid, item_id uuid, serial_number text, normalized_full text, short_key text, status text, is_allowed_candidate boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH input_value AS (
    SELECT
      public.normalize_inventory_serial(p_input) AS normalized_input,
      public.derive_inventory_serial_short_key(p_input) AS input_short_key,
      public.classify_inventory_serial_format(p_input) AS input_format
  ),
  exact_candidates AS (
    SELECT s.id, 'exact_full' AS match_kind
    FROM public.inventory_serials s
    CROSS JOIN input_value i
    WHERE s.normalized_full = i.normalized_input
  ),
  short_candidates AS (
    SELECT
      s.id,
      CASE
        WHEN i.input_format = 'full' THEN 'derived_short_key'
        ELSE 'short_key'
      END AS match_kind
    FROM public.inventory_serials s
    CROSS JOIN input_value i
    WHERE i.input_format IN ('full', 'short')
      AND i.input_short_key IS NOT NULL
      AND s.short_key = i.input_short_key
  ),
  identity_candidates AS (
    SELECT DISTINCT ON (candidate_id)
      candidate_id,
      match_kind
    FROM (
      SELECT id AS candidate_id, match_kind FROM exact_candidates
      UNION ALL
      SELECT id AS candidate_id, match_kind FROM short_candidates
    ) matches
    ORDER BY candidate_id, CASE match_kind WHEN 'exact_full' THEN 0 ELSE 1 END
  ),
  counts AS (
    SELECT
      count(*)::integer AS candidate_count,
      count(*) FILTER (
        WHERE (p_item_id IS NULL OR s.item_id = p_item_id)
          AND (p_allowed_statuses IS NULL OR s.status = ANY(p_allowed_statuses))
      )::integer AS filtered_candidate_count,
      (SELECT count(*)::integer FROM exact_candidates) AS exact_candidate_count,
      (SELECT input_format FROM input_value) AS input_format
    FROM identity_candidates c
    JOIN public.inventory_serials s ON s.id = c.candidate_id
  ),
  typed AS (
    SELECT CASE
      WHEN counts.candidate_count = 0 THEN 'no_match'
      WHEN counts.candidate_count > 1 THEN 'ambiguous'
      WHEN counts.filtered_candidate_count = 0 THEN 'filtered_out'
      WHEN counts.input_format = 'full' AND counts.exact_candidate_count = 0 THEN 'potential_same_identity'
      ELSE 'unique_match'
    END AS result_type,
    counts.*
    FROM counts
  )
  SELECT
    typed.result_type,
    typed.candidate_count,
    typed.filtered_candidate_count,
    s.id,
    s.item_id,
    s.serial_number,
    s.normalized_full,
    s.short_key,
    s.status,
    ((p_item_id IS NULL OR s.item_id = p_item_id)
      AND (p_allowed_statuses IS NULL OR s.status = ANY(p_allowed_statuses))) AS is_allowed_candidate
  FROM typed
  LEFT JOIN identity_candidates c ON typed.candidate_count > 0
  LEFT JOIN public.inventory_serials s ON s.id = c.candidate_id
  ORDER BY
    CASE WHEN c.match_kind = 'exact_full' THEN 0 ELSE 1 END,
    s.created_at,
    s.id;
$function$;
CREATE OR REPLACE FUNCTION public.normalize_inventory_serial(p_serial text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT upper(
    regexp_replace(
      btrim(translate(normalize(p_serial, NFKC), '－–—', '---')),
      '\s*-\s*',
      '-',
      'g'
    )
  );
$function$;
CREATE OR REPLACE FUNCTION public.preview_inventory_initialization(items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item record;
  v_item_data jsonb;
  v_in_stock_count integer;
  v_pending_count integer;
  v_can_initialize boolean;
  v_error_reason text;
  v_result jsonb := '[]'::jsonb;
  v_new_opening integer;
  v_existing_items_count integer;
  v_input_items_count integer;
  v_input_items_unique_count integer;

  v_out_count integer;
  v_used_count integer;
  v_returned_count integer;
  v_scrapped_count integer;
  v_voided_count integer;
  v_retained_ids jsonb;
  v_retained_count integer;
  v_unique_retained_count integer;
  v_invalid_count integer;
  v_in_stock_serials jsonb;
BEGIN
  -- 檢查身份
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- One-time initialization check for preview
  IF EXISTS (SELECT 1 FROM inventory_initializations) THEN
    DECLARE
      v_init record;
    BEGIN
      SELECT * INTO v_init FROM inventory_initializations LIMIT 1;
      RETURN jsonb_build_object(
        'already_initialized', true,
        'initialized_at', v_init.initialized_at,
        'baseline_date', v_init.baseline_date
      );
    END;
  END IF;

  v_input_items_count := jsonb_array_length(items);

  IF v_input_items_count = 0 THEN
    RETURN jsonb_build_object(
      'already_initialized', false,
      'can_execute_now', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date >= DATE '2026-08-31',
      'earliest_initialization_date', '2026-08-31',
      'items', '[]'::jsonb
    );
  END IF;

  -- FIX: inventory_items does not have deleted_at
  SELECT count(*) INTO v_existing_items_count FROM inventory_items;

  -- Add duplicate validation
  SELECT count(DISTINCT value->>'id') INTO v_input_items_unique_count FROM jsonb_array_elements(items);
  IF v_input_items_unique_count <> v_input_items_count THEN
    RAISE EXCEPTION 'Duplicate item IDs found in payload';
  END IF;

  IF v_input_items_count <> v_existing_items_count THEN
    RAISE EXCEPTION 'Missing or extra inventory items. Expected %, got %', v_existing_items_count, v_input_items_count;
  END IF;

  FOR v_item_data IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_error_reason := NULL;
    v_can_initialize := true;
    v_pending_count := 0;

    -- FIX: removed deleted_at IS NULL
    SELECT * INTO v_item FROM inventory_items WHERE id = (v_item_data->>'id')::uuid;
    IF v_item IS NULL THEN
      v_error_reason := 'Item not found';
      v_can_initialize := false;
      CONTINUE;
    END IF;

    v_new_opening := (v_item_data->>'new_opening_quantity')::integer;
    IF v_new_opening < 0 THEN
      v_error_reason := 'Quantity cannot be negative';
      v_can_initialize := false;
    END IF;

    IF v_item.requires_serial THEN
      -- 計算真實在庫序號
      SELECT count(*) INTO v_in_stock_count FROM inventory_serials WHERE item_id = v_item.id AND status = '在庫';

      SELECT count(*) INTO v_out_count FROM inventory_serials WHERE item_id = v_item.id AND status = '已出庫';
      SELECT count(*) INTO v_used_count FROM inventory_serials WHERE item_id = v_item.id AND status = '已使用';
      SELECT count(*) INTO v_returned_count FROM inventory_serials WHERE item_id = v_item.id AND status = '已退回';
      SELECT count(*) INTO v_scrapped_count FROM inventory_serials WHERE item_id = v_item.id AND status = '報廢';
      SELECT count(*) INTO v_voided_count FROM inventory_serials WHERE item_id = v_item.id AND status = '作廢';

      -- 取得目前在庫序號清單
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'serial_number', serial_number)), '[]'::jsonb)
      INTO v_in_stock_serials
      FROM inventory_serials
      WHERE item_id = v_item.id AND status = '在庫';

      v_retained_ids := v_item_data->'retained_in_stock_serial_ids';
      IF v_retained_ids IS NOT NULL AND jsonb_typeof(v_retained_ids) = 'array' THEN
        v_retained_count := jsonb_array_length(v_retained_ids);

        SELECT count(DISTINCT value) INTO v_unique_retained_count FROM jsonb_array_elements_text(v_retained_ids);
        IF v_retained_count <> v_unique_retained_count THEN
          v_can_initialize := false;
          v_error_reason := 'Duplicate retained serial IDs provided';
        ELSIF v_retained_count > 0 THEN
          SELECT count(*) INTO v_invalid_count
          FROM jsonb_array_elements_text(v_retained_ids) AS rid
          WHERE NOT EXISTS (
            SELECT 1 FROM inventory_serials
            WHERE id = rid::uuid AND item_id = v_item.id AND status = '在庫'
          );
          IF v_invalid_count > 0 THEN
            v_can_initialize := false;
            v_error_reason := 'Invalid retained serial IDs provided';
          END IF;
        END IF;
      ELSE
        v_retained_count := v_in_stock_count;
        -- DO NOT OVERWRITE v_retained_ids to '[]' here!
      END IF;

      IF v_new_opening < v_retained_count THEN
        v_can_initialize := false;
        v_error_reason := 'New opening quantity cannot be less than retained serial count';
      ELSIF v_can_initialize THEN
        v_pending_count := v_new_opening - v_retained_count;
      END IF;
    ELSE
      v_in_stock_count := 0;
      v_out_count := 0;
      v_used_count := 0;
      v_returned_count := 0;
      v_scrapped_count := 0;
      v_voided_count := 0;
      v_in_stock_serials := '[]'::jsonb;
    END IF;

    v_result := v_result || jsonb_build_object(
      'item_id', v_item.id,
      'name', v_item.name,
      'requires_serial', v_item.requires_serial,
      'current_opening_quantity', v_item.opening_quantity,
      'new_opening_quantity', v_new_opening,
      'in_stock_serial_count', v_in_stock_count,
      'out_serial_count', v_out_count,
      'used_serial_count', v_used_count,
      'returned_serial_count', v_returned_count,
      'scrapped_serial_count', v_scrapped_count,
      'voided_serial_count', v_voided_count,
      'pending_serial_count', v_pending_count,
      'can_initialize', v_can_initialize,
      'error_reason', v_error_reason,
      'in_stock_serials', v_in_stock_serials
    );
  END LOOP;

  RETURN jsonb_build_object(
    'already_initialized', false,
    'can_execute_now', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date >= DATE '2026-08-31',
    'earliest_initialization_date', '2026-08-31',
    'items', v_result
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.preview_project_workflow_rebuild(p_project_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE instance public.project_workflow_instances%ROWTYPE; result jsonb;
BEGIN
 IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin may preview workflow rebuild' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT instance FROM public.project_workflow_instances WHERE project_id=p_project_id AND deleted_at IS NULL;
 WITH steps AS (
  SELECT s.*,p.phase_key,p.name phase_name,p.sort_order phase_order,t.type_key,t.name type_name
  FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id
  JOIN public.project_workflow_types t ON t.id=s.type_id
  WHERE s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active
 ), milestones AS (SELECT * FROM public.project_milestones WHERE workflow_instance_id=instance.id AND deleted_at IS NULL)
 SELECT jsonb_build_object(
  'matched',(SELECT count(*) FROM milestones m JOIN steps s ON s.id=m.source_template_step_id WHERE m.origin='TEMPLATE'),
  'added',(SELECT count(*) FROM steps s WHERE NOT EXISTS(SELECT 1 FROM milestones m WHERE m.source_template_step_id=s.id AND m.origin='TEMPLATE')),
  'archived',(SELECT count(*) FROM milestones m WHERE m.origin='TEMPLATE' AND m.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM steps s WHERE s.id=m.source_template_step_id)),
  'custom',(SELECT count(*) FROM milestones WHERE origin='PROJECT_CUSTOM'),
  'token',md5(instance.id::text||coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)::text FROM steps s),'[]')||coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id)::text FROM milestones m),'[]'))
 ) INTO result;
 RETURN result;
END $function$;
CREATE OR REPLACE FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid DEFAULT NULL::uuid, p_expected_start_date date DEFAULT NULL::date, p_due_date date DEFAULT NULL::date)
 RETURNS work_items
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_member_id uuid;
  v_todo public.todos;
  v_result public.work_items;
BEGIN
  v_member_id := app_private.current_member_id();
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'active member context required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_todo FROM public.todos
  WHERE id = p_todo_id
    AND scope = 'PRIVATE'
    AND created_by = v_member_id
    AND status = '待安排'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible private todo not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.work_zones
  WHERE id = p_work_zone_id
    AND owner_member_id = v_member_id
    AND is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible work zone not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.work_items (
    owner_member_id, project_id, work_zone_id, title, content,
    source_todo_id, source_created_at, received_at,
    expected_start_date, due_date
  )
  VALUES (
    v_member_id, p_project_id, p_work_zone_id, v_todo.title, v_todo.content,
    v_todo.id, v_todo.created_at, v_todo.received_at,
    p_expected_start_date, p_due_date
  )
  RETURNING * INTO v_result;
  RETURN v_result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_project_label text, p_expected_start_date date DEFAULT NULL::date, p_due_date date DEFAULT NULL::date)
 RETURNS work_items
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_member_id uuid;
  v_todo public.todos;
  v_result public.work_items;
BEGIN
  v_member_id := app_private.current_member_id();
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'active member context required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_todo FROM public.todos
  WHERE id = p_todo_id
    AND scope = 'PRIVATE'
    AND created_by = v_member_id
    AND status = '待安排'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible private todo not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM public.work_zones
  WHERE id = p_work_zone_id
    AND owner_member_id = v_member_id
    AND is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible work zone not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.work_items (
    owner_member_id, project_id, project_label, work_zone_id, title, content,
    source_todo_id, source_created_at, received_at,
    expected_start_date, due_date
  )
  VALUES (
    v_member_id, p_project_id, p_project_label, p_work_zone_id, v_todo.title, v_todo.content,
    v_todo.id, v_todo.created_at, v_todo.received_at,
    p_expected_start_date, p_due_date
  )
  RETURNING * INTO v_result;
  RETURN v_result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.rebuild_project_workflow(p_project_id uuid, p_preview_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE instance public.project_workflow_instances%ROWTYPE; preview jsonb;
BEGIN
 IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin may rebuild workflow' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.refresh_project_workflow:'||p_project_id::text,0));
 -- Keep template metadata and project progress stable between preview validation and writes.
 LOCK TABLE public.project_workflow_template_steps,public.project_workflow_phases,public.project_workflow_types IN SHARE MODE;
 SELECT * INTO STRICT instance FROM public.project_workflow_instances WHERE project_id=p_project_id AND deleted_at IS NULL;
 PERFORM id FROM public.project_milestones WHERE workflow_instance_id=instance.id FOR UPDATE;
 preview:=public.preview_project_workflow_rebuild(p_project_id);
 IF p_preview_token IS NULL OR p_preview_token IS DISTINCT FROM preview->>'token' THEN RAISE EXCEPTION 'Workflow changed; preview again before rebuilding' USING ERRCODE='40001'; END IF;
 UPDATE public.project_milestones m SET label=s.label,source_phase_id=p.id,phase_key_snapshot=p.phase_key,
  phase_name_snapshot=p.name,phase_sort_order_snapshot=p.sort_order,source_type_id=t.id,type_key_snapshot=t.type_key,
  type_name_snapshot=t.name,responsible_position_id=s.responsible_position_id,sort_order=s.sort_order,archived_at=NULL
 FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id
 JOIN public.project_workflow_types t ON t.id=s.type_id
 WHERE m.workflow_instance_id=instance.id AND m.origin='TEMPLATE' AND m.deleted_at IS NULL
 AND s.id=m.source_template_step_id AND s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active
 AND ROW(m.label,m.source_phase_id,m.phase_key_snapshot,m.phase_name_snapshot,m.phase_sort_order_snapshot,m.source_type_id,m.type_key_snapshot,m.type_name_snapshot,m.responsible_position_id,m.sort_order,m.archived_at)
 IS DISTINCT FROM ROW(s.label,p.id,p.phase_key,p.name,p.sort_order,t.id,t.type_key,t.name,s.responsible_position_id,s.sort_order,NULL::timestamptz);
 UPDATE public.project_milestones m SET archived_at=now()
 WHERE m.workflow_instance_id=instance.id AND m.origin='TEMPLATE' AND m.deleted_at IS NULL AND m.archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id JOIN public.project_workflow_types t ON t.id=s.type_id WHERE s.id=m.source_template_step_id AND s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active);
 INSERT INTO public.project_milestones(workflow_instance_id,project_id,origin,source_template_step_id,milestone_key,label,source_phase_id,phase_key_snapshot,phase_name_snapshot,phase_sort_order_snapshot,source_type_id,type_key_snapshot,type_name_snapshot,sort_order,is_applicable,status,responsible_position_id)
 SELECT instance.id,p_project_id,'TEMPLATE',s.id,s.step_key,s.label,p.id,p.phase_key,p.name,p.sort_order,t.id,t.type_key,t.name,s.sort_order,s.default_is_applicable,'NOT_STARTED',s.responsible_position_id
 FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id JOIN public.project_workflow_types t ON t.id=s.type_id
 WHERE s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active
 ON CONFLICT(workflow_instance_id,source_template_step_id) WHERE origin='TEMPLATE' AND deleted_at IS NULL DO NOTHING;
 RETURN preview;
END $function$;
CREATE OR REPLACE FUNCTION public.refresh_project_workflow(p_project_id uuid)
 RETURNS TABLE(result text, refreshed_workflow_instance_id uuid, milestones_created integer)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_instance public.project_workflow_instances%ROWTYPE;
    v_inserted_count integer;
BEGIN
    IF NOT app_private.is_admin_member() THEN
        RAISE EXCEPTION 'Only admin members can refresh project workflows'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'public.refresh_project_workflow:' || p_project_id::text,
            0
        )
    );

    SELECT instance.*
    INTO v_instance
    FROM public.project_workflow_instances AS instance
    WHERE instance.project_id = p_project_id
      AND instance.deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project % has no active workflow instance', p_project_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Existing TEMPLATE milestones keep every business field and snapshot.
    -- Only their display ordering follows the latest active template metadata.
    UPDATE public.project_milestones AS milestone
    SET sort_order = step.sort_order
    FROM public.project_workflow_template_steps AS step
    WHERE milestone.workflow_instance_id = v_instance.id
      AND milestone.origin = 'TEMPLATE'
      AND milestone.deleted_at IS NULL
      AND step.id = milestone.source_template_step_id
      AND step.template_id = v_instance.source_template_id
      AND step.is_active = true
      AND milestone.sort_order IS DISTINCT FROM step.sort_order;

    INSERT INTO public.project_milestones (
        workflow_instance_id,
        project_id,
        origin,
        source_template_step_id,
        milestone_key,
        label,
        source_phase_id,
        phase_key_snapshot,
        phase_name_snapshot,
        source_type_id,
        type_key_snapshot,
        type_name_snapshot,
        sort_order,
        is_applicable,
        status,
        responsible_position_id
    )
    SELECT
        v_instance.id,
        p_project_id,
        'TEMPLATE',
        step.id,
        step.step_key,
        step.label,
        phase.id,
        phase.phase_key,
        phase.name,
        workflow_type.id,
        workflow_type.type_key,
        workflow_type.name,
        step.sort_order,
        step.default_is_applicable,
        'NOT_STARTED',
        step.responsible_position_id
    FROM public.project_workflow_template_steps AS step
    JOIN public.project_workflow_phases AS phase
      ON phase.id = step.phase_id
     AND phase.is_active = true
    JOIN public.project_workflow_types AS workflow_type
      ON workflow_type.id = step.type_id
     AND workflow_type.is_active = true
    WHERE step.template_id = v_instance.source_template_id
      AND step.is_active = true
    ON CONFLICT (workflow_instance_id, source_template_step_id)
      WHERE origin = 'TEMPLATE' AND deleted_at IS NULL
    DO NOTHING;

    GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

    RETURN QUERY SELECT
        CASE WHEN v_inserted_count = 0 THEN 'already_current' ELSE 'updated' END,
        v_instance.id,
        v_inserted_count;
END;
$function$;
CREATE OR REPLACE FUNCTION public.reject_todo(p_todo_id uuid, p_reason text)
 RETURNS todos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  actor_id uuid;
  target_todo public.todos;
BEGIN
  IF NOT app_private.is_editor_member() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION '退件原因不可空白'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT member.id
  INTO actor_id
  FROM public.team_members member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL
  LIMIT 1;

  SELECT todo.*
  INTO target_todo
  FROM public.todos todo
  WHERE todo.id = p_todo_id
    AND todo.scope = 'TEAM'
  FOR UPDATE;

  IF target_todo.id IS NULL THEN
    RAISE EXCEPTION '找不到待辦';
  END IF;

  IF target_todo.assigned_to IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION '只有被指派人可以退件'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF target_todo.status <> '待安排' THEN
    RAISE EXCEPTION '只有待安排的待辦可以退件'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.todos
  SET status = '已退件',
      rejected_by = actor_id,
      rejected_at = now(),
      rejection_reason = btrim(p_reason)
  WHERE id = p_todo_id
    AND scope = 'TEAM'
  RETURNING * INTO target_todo;

  RETURN target_todo;
END;
$function$;
CREATE OR REPLACE FUNCTION public.set_member_dashboard_views(p_member_id uuid, p_view_ids uuid[], p_default_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
 IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin members may assign dashboard views' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dashboard_views:'||p_member_id::text,0));
 IF p_view_ids IS NULL OR EXISTS (SELECT 1 FROM unnest(p_view_ids) AS requested(view_id) WHERE requested.view_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.dashboard_views v WHERE v.id=requested.view_id AND v.is_active))
 OR (p_default_id IS NOT NULL AND NOT p_default_id=ANY(p_view_ids)) THEN RAISE EXCEPTION 'Invalid dashboard view assignment' USING ERRCODE='23514'; END IF;
 DELETE FROM public.member_dashboard_views WHERE member_id=p_member_id;
 INSERT INTO public.member_dashboard_views(member_id,dashboard_view_id,is_default)
 SELECT p_member_id,id,coalesce(id=p_default_id,false) FROM (SELECT DISTINCT unnest(p_view_ids) id) ids;
END $function$;
CREATE OR REPLACE FUNCTION public.set_project_position_assignment(p_project_id uuid, p_position_id uuid, p_member_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(assignment_id uuid, assigned_member_id uuid, assignment_created_at timestamp with time zone, assignment_updated_at timestamp with time zone, compatibility_member_name text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_position_name text;
    v_member_name text;
    v_compatibility_member_name text;
    v_assignment public.project_position_assignments%ROWTYPE;
BEGIN
    SELECT project.responsible_member_name
    INTO v_compatibility_member_name
    FROM public.projects AS project
    WHERE project.id = p_project_id
      AND project.deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project % does not exist or is not accessible', p_project_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT position.name
    INTO v_position_name
    FROM public.positions AS position
    WHERE position.id = p_position_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position % does not exist or is not accessible', p_position_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF p_member_id IS NULL THEN
        DELETE FROM public.project_position_assignments AS assignment
        WHERE assignment.project_id = p_project_id
          AND assignment.position_id = p_position_id;

        IF btrim(v_position_name) = '工程' THEN
            UPDATE public.projects AS project
            SET responsible_member_name = NULL
            WHERE project.id = p_project_id;
            v_compatibility_member_name := NULL;
        END IF;

        RETURN QUERY SELECT
            NULL::uuid,
            NULL::uuid,
            NULL::timestamptz,
            NULL::timestamptz,
            v_compatibility_member_name;
        RETURN;
    END IF;

    SELECT member.name
    INTO v_member_name
    FROM public.team_members AS member
    JOIN public.member_positions AS member_position
      ON member_position.member_id = member.id
     AND member_position.position_id = p_position_id
    WHERE member.id = p_member_id
      AND member.is_active = true
      AND member.deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project assignee must be an active member with the selected position'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.project_position_assignments AS assignment (
        project_id,
        position_id,
        member_id
    ) VALUES (
        p_project_id,
        p_position_id,
        p_member_id
    )
    ON CONFLICT (project_id, position_id)
    DO UPDATE SET member_id = EXCLUDED.member_id
    RETURNING assignment.* INTO v_assignment;

    IF btrim(v_position_name) = '工程' THEN
        UPDATE public.projects AS project
        SET responsible_member_name = v_member_name
        WHERE project.id = p_project_id;
        v_compatibility_member_name := v_member_name;
    END IF;

    RETURN QUERY SELECT
        v_assignment.id,
        v_assignment.member_id,
        v_assignment.created_at,
        v_assignment.updated_at,
        v_compatibility_member_name;
END;
$function$;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.snapshot_project_workflow(p_project_id uuid, p_template_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(result text, workflow_instance_id uuid, milestones_created integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_template public.project_workflow_templates%ROWTYPE;
    v_existing_instance_id uuid;
    v_instance_id uuid;
    v_default_count integer;
    v_inserted_count integer;
BEGIN
    IF NOT app_private.is_editor_member() THEN
        RAISE EXCEPTION 'Only editor members can snapshot project workflows'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    PERFORM project.id
    FROM public.projects AS project
    WHERE project.id = p_project_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project % does not exist or is not accessible', p_project_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT instance.id
    INTO v_existing_instance_id
    FROM public.project_workflow_instances AS instance
    WHERE instance.project_id = p_project_id
    ORDER BY instance.created_at, instance.id
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT 'already_initialized'::text, v_existing_instance_id, 0;
        RETURN;
    END IF;

    IF p_template_id IS NULL THEN
        SELECT count(*)::integer
        INTO v_default_count
        FROM public.project_workflow_templates AS template
        WHERE template.is_active = true AND template.is_default = true;

        IF v_default_count = 0 THEN
            RAISE EXCEPTION 'No active default project workflow template exists'
                USING ERRCODE = 'no_data_found';
        ELSIF v_default_count > 1 THEN
            RAISE EXCEPTION 'Multiple active default project workflow templates exist'
                USING ERRCODE = 'cardinality_violation';
        END IF;

        SELECT template.* INTO v_template
        FROM public.project_workflow_templates AS template
        WHERE template.is_active = true AND template.is_default = true;
    ELSE
        SELECT template.* INTO v_template
        FROM public.project_workflow_templates AS template
        WHERE template.id = p_template_id AND template.is_active = true;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Project workflow template % does not exist or is inactive', p_template_id
                USING ERRCODE = 'no_data_found';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.project_workflow_template_steps AS step
        JOIN public.project_workflow_phases AS phase ON phase.id = step.phase_id
        JOIN public.project_workflow_types AS workflow_type ON workflow_type.id = step.type_id
        WHERE step.template_id = v_template.id
          AND step.is_active = true
          AND (phase.is_active = false OR workflow_type.is_active = false)
    ) THEN
        RAISE EXCEPTION 'Active template steps require active phase and type classifications'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.project_workflow_instances (
        project_id, source_template_id, template_key_snapshot, template_name_snapshot
    ) VALUES (
        p_project_id, v_template.id, v_template.template_key, v_template.name
    ) RETURNING id INTO v_instance_id;

    INSERT INTO public.project_milestones (
        workflow_instance_id,
        project_id,
        origin,
        source_template_step_id,
        milestone_key,
        label,
        source_phase_id,
        phase_key_snapshot,
        phase_name_snapshot,
        source_type_id,
        type_key_snapshot,
        type_name_snapshot,
        sort_order,
        is_applicable,
        status,
        responsible_position_id
    )
    SELECT
        v_instance_id,
        p_project_id,
        'TEMPLATE',
        step.id,
        step.step_key,
        step.label,
        phase.id,
        phase.phase_key,
        phase.name,
        workflow_type.id,
        workflow_type.type_key,
        workflow_type.name,
        step.sort_order,
        step.default_is_applicable,
        'NOT_STARTED',
        step.responsible_position_id
    FROM public.project_workflow_template_steps AS step
    JOIN public.project_workflow_phases AS phase ON phase.id = step.phase_id
    JOIN public.project_workflow_types AS workflow_type ON workflow_type.id = step.type_id
    WHERE step.template_id = v_template.id
      AND step.is_active = true
    ORDER BY step.sort_order, step.id;

    GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
    RETURN QUERY SELECT 'created'::text, v_instance_id, v_inserted_count;
END;
$function$;
CREATE OR REPLACE FUNCTION public.unseal_inventory_month(p_year text, p_month text)
 RETURNS inventory_monthly_closings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  closing public.inventory_monthly_closings%ROWTYPE;
BEGIN
  IF NOT app_private.is_admin_member() THEN
    RAISE EXCEPTION '只有管理員可以解除庫存月結封存'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT *
  INTO closing
  FROM public.inventory_monthly_closings
  WHERE year = p_year
    AND month = p_month
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '%-% 找不到月結紀錄', p_year, p_month
      USING ERRCODE = 'no_data_found';
  END IF;

  IF closing.status <> 'CLOSED' THEN
    RAISE EXCEPTION '%-% 尚未封存', p_year, p_month
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.inventory_monthly_closings
  SET status = 'OPEN'
  WHERE id = closing.id
  RETURNING * INTO closing;

  RETURN closing;
END;
$function$;
CREATE OR REPLACE FUNCTION public.update_member_workspace_profile(p_member_id uuid, p_name text, p_email text, p_role text, p_is_active boolean, p_google_calendar_email text, p_notes text, p_position_ids uuid[], p_work_group_ids uuid[], p_default_work_group_id uuid, p_dashboard_view_ids uuid[], p_default_dashboard_view_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_member_id uuid := coalesce(p_member_id, gen_random_uuid());
  v_position_ids uuid[] := coalesce(p_position_ids, '{}'::uuid[]);
  v_work_group_ids uuid[] := coalesce(p_work_group_ids, '{}'::uuid[]);
  v_dashboard_view_ids uuid[] := coalesce(p_dashboard_view_ids, '{}'::uuid[]);
  v_role text := lower(btrim(coalesce(p_role, '')));
BEGIN
  IF NOT coalesce(app_private.is_admin_member(), false) THEN
    RAISE EXCEPTION 'Only admin members may update personnel workspace profiles'
      USING ERRCODE = '42501';
  END IF;

  IF btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_email, '')) = '' THEN
    RAISE EXCEPTION 'Name and email are required' USING ERRCODE = '23514';
  END IF;
  IF v_role NOT IN ('admin', 'engineer', 'viewer') THEN
    RAISE EXCEPTION 'Invalid system role' USING ERRCODE = '23514';
  END IF;
  IF cardinality(v_position_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_position_ids)))
    OR cardinality(v_work_group_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_work_group_ids)))
    OR cardinality(v_dashboard_view_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(v_dashboard_view_ids))) THEN
    RAISE EXCEPTION 'Duplicate profile assignment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_position_ids) requested(id)
    WHERE requested.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.positions position
      WHERE position.id = requested.id AND position.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive position assignment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_work_group_ids) requested(id)
    WHERE requested.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.work_groups work_group
      WHERE work_group.id = requested.id AND work_group.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive work group assignment' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_dashboard_view_ids) requested(id)
    WHERE requested.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.dashboard_views dashboard_view
      WHERE dashboard_view.id = requested.id AND dashboard_view.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive dashboard view assignment' USING ERRCODE = '23514';
  END IF;
  IF (cardinality(v_work_group_ids) = 0 AND p_default_work_group_id IS NOT NULL)
    OR (cardinality(v_work_group_ids) > 0 AND (
      p_default_work_group_id IS NULL OR NOT p_default_work_group_id = ANY(v_work_group_ids)
    )) THEN
    RAISE EXCEPTION 'Default work group must be one selected work group' USING ERRCODE = '23514';
  END IF;
  IF (cardinality(v_dashboard_view_ids) = 0 AND p_default_dashboard_view_id IS NOT NULL)
    OR (cardinality(v_dashboard_view_ids) > 0 AND (
      p_default_dashboard_view_id IS NULL OR NOT p_default_dashboard_view_id = ANY(v_dashboard_view_ids)
    )) THEN
    RAISE EXCEPTION 'Default dashboard view must be one selected view' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-workspace-profile:' || v_member_id::text, 0)
  );

  IF p_member_id IS NULL THEN
    INSERT INTO public.team_members (
      id, name, email, role, category, is_active, google_calendar_email, notes
    ) VALUES (
      v_member_id,
      btrim(p_name),
      lower(btrim(p_email)),
      v_role,
      'other',
      p_is_active,
      nullif(btrim(coalesce(p_google_calendar_email, '')), ''),
      nullif(btrim(coalesce(p_notes, '')), '')
    );
  ELSE
    UPDATE public.team_members
    SET name = btrim(p_name),
        email = lower(btrim(p_email)),
        role = v_role,
        is_active = p_is_active,
        google_calendar_email = nullif(btrim(coalesce(p_google_calendar_email, '')), ''),
        notes = nullif(btrim(coalesce(p_notes, '')), ''),
        updated_at = now()
    WHERE id = v_member_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Team member not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  DELETE FROM public.member_positions WHERE member_id = v_member_id;
  INSERT INTO public.member_positions (member_id, position_id)
  SELECT v_member_id, requested.id FROM unnest(v_position_ids) requested(id);

  DELETE FROM public.member_work_groups WHERE member_id = v_member_id;
  INSERT INTO public.member_work_groups (member_id, work_group_id, is_default)
  SELECT v_member_id, requested.id, requested.id = p_default_work_group_id
  FROM unnest(v_work_group_ids) requested(id);

  DELETE FROM public.member_dashboard_views WHERE member_id = v_member_id;
  INSERT INTO public.member_dashboard_views (member_id, dashboard_view_id, is_default)
  SELECT v_member_id, requested.id, requested.id = p_default_dashboard_view_id
  FROM unnest(v_dashboard_view_ids) requested(id);

  RETURN v_member_id;
END;
$function$;

DO $ddl$
DECLARE r record;
BEGIN
 FOR r IN SELECT n.nspname,c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
 LOOP EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',r.tgname,r.nspname,r.relname); END LOOP;
END $ddl$;
CREATE TRIGGER normalize_contractor_work_capabilities BEFORE INSERT OR UPDATE ON contractors FOR EACH ROW EXECUTE FUNCTION app_private.normalize_contractor_work_capabilities();
CREATE TRIGGER reject_locked_inventory_item_opening_quantity_change BEFORE UPDATE OF opening_quantity ON inventory_items FOR EACH ROW EXECUTE FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change();
CREATE TRIGGER enforce_inventory_monthly_closing_state BEFORE DELETE OR UPDATE ON inventory_monthly_closings FOR EACH ROW EXECUTE FUNCTION app_private.enforce_inventory_monthly_closing_state();
CREATE TRIGGER protect_voided_inventory_serial_history BEFORE DELETE OR UPDATE ON inventory_serials FOR EACH ROW EXECUTE FUNCTION app_private.protect_voided_inventory_serial_history();
CREATE TRIGGER ensure_inventory_batch_for_transaction AFTER INSERT OR UPDATE OF transaction_type ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION app_private.ensure_inventory_batch_for_transaction();
CREATE TRIGGER inventory_transactions_cutoff_guard BEFORE INSERT OR UPDATE ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION enforce_inventory_cutoff_guard();
CREATE TRIGGER reject_closed_month_inventory_transaction_write BEFORE INSERT OR DELETE OR UPDATE ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION app_private.reject_closed_month_inventory_transaction_write();
CREATE TRIGGER safely_void_inventory_in_transaction BEFORE UPDATE OF is_voided ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION app_private.safely_void_inventory_in_transaction();
CREATE TRIGGER member_work_groups_set_updated_at BEFORE UPDATE ON member_work_groups FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();
CREATE TRIGGER set_positions_updated_at BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION app_private.set_position_responsibility_updated_at();
CREATE TRIGGER set_project_construction_progress_updated_at BEFORE UPDATE ON project_construction_progress FOR EACH ROW EXECUTE FUNCTION app_private.set_project_construction_progress_updated_at();
CREATE TRIGGER protect_project_difficulty_assessment_provenance BEFORE UPDATE ON project_difficulty_assessments FOR EACH ROW EXECUTE FUNCTION app_private.protect_project_difficulty_assessment_provenance();
CREATE TRIGGER set_project_difficulty_assessment_evaluator BEFORE INSERT ON project_difficulty_assessments FOR EACH ROW EXECUTE FUNCTION app_private.set_project_difficulty_assessment_evaluator();
CREATE TRIGGER set_project_difficulty_assessments_updated_at BEFORE UPDATE ON project_difficulty_assessments FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER set_project_milestones_updated_at BEFORE UPDATE ON project_milestones FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER validate_project_milestone_contract BEFORE INSERT OR UPDATE ON project_milestones FOR EACH ROW EXECUTE FUNCTION app_private.validate_project_milestone_contract();
CREATE TRIGGER zz_workflow_framework_metadata BEFORE INSERT OR UPDATE ON project_milestones FOR EACH ROW EXECUTE FUNCTION app_private.guard_workflow_framework_metadata();
CREATE TRIGGER set_project_position_assignments_updated_at BEFORE UPDATE ON project_position_assignments FOR EACH ROW EXECUTE FUNCTION app_private.set_position_responsibility_updated_at();
CREATE TRIGGER validate_project_position_assignment BEFORE INSERT OR UPDATE OF position_id, member_id ON project_position_assignments FOR EACH ROW EXECUTE FUNCTION app_private.validate_project_position_assignment();
CREATE TRIGGER protect_project_workflow_instance_provenance BEFORE UPDATE OF project_id, source_template_id, template_key_snapshot, template_name_snapshot, snapshot_at ON project_workflow_instances FOR EACH ROW EXECUTE FUNCTION app_private.protect_project_workflow_instance_provenance();
CREATE TRIGGER set_project_workflow_instances_updated_at BEFORE UPDATE ON project_workflow_instances FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER set_project_workflow_phases_updated_at BEFORE UPDATE ON project_workflow_phases FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER set_project_workflow_template_steps_updated_at BEFORE UPDATE ON project_workflow_template_steps FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER set_project_workflow_templates_updated_at BEFORE UPDATE ON project_workflow_templates FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER set_project_workflow_types_updated_at BEFORE UPDATE ON project_workflow_types FOR EACH ROW EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();
CREATE TRIGGER set_schedule_task_types_updated_at BEFORE UPDATE ON schedule_task_types FOR EACH ROW EXECUTE FUNCTION app_private.set_schedule_task_types_updated_at();
CREATE TRIGGER preserve_schedule_task_creation_metadata BEFORE UPDATE OF created_by_user_id, created_by_name, creation_source ON schedule_tasks FOR EACH ROW EXECUTE FUNCTION app_private.preserve_schedule_task_creation_metadata();
CREATE TRIGGER schedule_tasks_default_legacy_work_group BEFORE INSERT ON schedule_tasks FOR EACH ROW EXECUTE FUNCTION app_private.default_legacy_schedule_work_group();
CREATE TRIGGER set_schedule_tasks_updated_at BEFORE UPDATE ON schedule_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER protect_owner_team_member BEFORE DELETE OR UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION app_private.reject_owner_team_member_changes();
CREATE TRIGGER trigger_team_members_updated_at BEFORE UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER log_todo_history AFTER INSERT OR UPDATE ON todos FOR EACH ROW EXECUTE FUNCTION app_private.log_todo_history();
CREATE TRIGGER set_todo_updated_at BEFORE UPDATE ON todos FOR EACH ROW EXECUTE FUNCTION app_private.set_todo_updated_at();
CREATE TRIGGER todos_default_legacy_team_work_group BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION app_private.default_legacy_team_todo_work_group();
CREATE TRIGGER work_groups_set_updated_at BEFORE UPDATE ON work_groups FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();
CREATE TRIGGER work_items_normalize_project_label BEFORE INSERT OR UPDATE OF project_id, project_label ON work_items FOR EACH ROW EXECUTE FUNCTION app_private.normalize_work_item_project_label();
CREATE TRIGGER work_items_prepare_todo_provenance BEFORE INSERT ON work_items FOR EACH ROW EXECUTE FUNCTION app_private.prepare_work_item_todo_provenance();
CREATE TRIGGER work_items_provenance_guard BEFORE UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION app_private.protect_work_item_provenance();
CREATE TRIGGER work_items_set_updated_at BEFORE UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();
CREATE CONSTRAINT TRIGGER work_zones_active_limit_guard AFTER INSERT OR DELETE OR UPDATE ON work_zones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.enforce_active_work_zone_limit();
CREATE TRIGGER work_zones_set_updated_at BEFORE UPDATE ON work_zones FOR EACH ROW EXECUTE FUNCTION app_private.set_workbench_updated_at();

DO $ddl$
DECLARE r record;
BEGIN
 FOR r IN SELECT schemaname,tablename,policyname FROM pg_policies WHERE schemaname='public'
 LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',r.policyname,r.schemaname,r.tablename); END LOOP;
END $ddl$;
CREATE POLICY "Enable delete access for editor members" ON public.activity_logs AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.activity_logs AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.activity_logs AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.activity_logs AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for admin members" ON public.contractors AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_admin_member());
CREATE POLICY "Enable insert access for admin members" ON public.contractors AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Enable read access for active members" ON public.contractors AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for admin members" ON public.contractors AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "dashboard_views_read" ON public.dashboard_views AS PERMISSIVE FOR SELECT TO "authenticated" USING (( SELECT app_private.is_active_member() AS is_active_member));
CREATE POLICY "Enable delete access for editor members" ON public.inventory_batches AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_batches AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_batches AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_batches AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for editor members" ON public.inventory_items AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_items AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_items AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_items AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for editor members" ON public.inventory_monthly_closing_items AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_monthly_closing_items AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_monthly_closing_items AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_monthly_closing_items AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for editor members" ON public.inventory_monthly_closings AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_monthly_closings AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_monthly_closings AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_monthly_closings AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for editor members" ON public.inventory_serials AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_serials AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_serials AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_serials AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for editor members" ON public.inventory_transaction_serials AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_transaction_serials AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_transaction_serials AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_transaction_serials AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable delete access for editor members" ON public.inventory_transactions AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.inventory_transactions AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.inventory_transactions AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.inventory_transactions AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "member_dashboard_views_admin" ON public.member_dashboard_views AS PERMISSIVE FOR ALL TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member)) WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "member_dashboard_views_read" ON public.member_dashboard_views AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT app_private.is_active_member() AS is_active_member) AND ((member_id = ( SELECT app_private.current_member_id() AS current_member_id)) OR ( SELECT app_private.is_admin_member() AS is_admin_member))));
CREATE POLICY "Active members can view member positions" ON public.member_positions AS PERMISSIVE FOR SELECT TO "authenticated" USING (( SELECT app_private.is_active_member() AS is_active_member));
CREATE POLICY "Admin members can delete member positions" ON public.member_positions AS PERMISSIVE FOR DELETE TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "Admin members can insert member positions" ON public.member_positions AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "Admin members can update member positions" ON public.member_positions AS PERMISSIVE FOR UPDATE TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member)) WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "member_work_groups_active_read" ON public.member_work_groups AS PERMISSIVE FOR SELECT TO "authenticated" USING (( SELECT app_private.is_active_member() AS is_active_member));
CREATE POLICY "member_work_groups_admin_delete" ON public.member_work_groups AS PERMISSIVE FOR DELETE TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "member_work_groups_admin_insert" ON public.member_work_groups AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "member_work_groups_admin_update" ON public.member_work_groups AS PERMISSIVE FOR UPDATE TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member)) WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "Active members can view positions" ON public.positions AS PERMISSIVE FOR SELECT TO "authenticated" USING (( SELECT app_private.is_active_member() AS is_active_member));
CREATE POLICY "Admin members can insert positions" ON public.positions AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "Admin members can update positions" ON public.positions AS PERMISSIVE FOR UPDATE TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member)) WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "Enable delete access for editor members" ON public.project_construction_progress AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.project_construction_progress AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.project_construction_progress AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.project_construction_progress AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Active members can view project difficulty assessments" ON public.project_difficulty_assessments AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Editor members can insert project difficulty assessments" ON public.project_difficulty_assessments AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Editor members can update project difficulty assessments" ON public.project_difficulty_assessments AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Active members can view project milestones" ON public.project_milestones AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Admin members can insert project template milestones" ON public.project_milestones AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((app_private.is_admin_member() AND (origin = 'TEMPLATE'::text) AND (deleted_at IS NULL)));
CREATE POLICY "Editor members can insert project custom milestones" ON public.project_milestones AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((app_private.is_editor_member() AND (origin = 'PROJECT_CUSTOM'::text) AND (deleted_at IS NULL)));
CREATE POLICY "Editor members can update project milestones" ON public.project_milestones AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Active members can view project position assignments" ON public.project_position_assignments AS PERMISSIVE FOR SELECT TO "authenticated" USING (( SELECT app_private.is_active_member() AS is_active_member));
CREATE POLICY "Editor members can delete project position assignments" ON public.project_position_assignments AS PERMISSIVE FOR DELETE TO "authenticated" USING (( SELECT app_private.is_editor_member() AS is_editor_member));
CREATE POLICY "Editor members can insert project position assignments" ON public.project_position_assignments AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (( SELECT app_private.is_editor_member() AS is_editor_member));
CREATE POLICY "Editor members can update project position assignments" ON public.project_position_assignments AS PERMISSIVE FOR UPDATE TO "authenticated" USING (( SELECT app_private.is_editor_member() AS is_editor_member)) WITH CHECK (( SELECT app_private.is_editor_member() AS is_editor_member));
CREATE POLICY "Active members can view project workflow instances" ON public.project_workflow_instances AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Active members can view project workflow phases" ON public.project_workflow_phases AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Admin members can insert project workflow phases" ON public.project_workflow_phases AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Admin members can update project workflow phases" ON public.project_workflow_phases AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Active members can view project workflow template steps" ON public.project_workflow_template_steps AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Admin members can insert project workflow template steps" ON public.project_workflow_template_steps AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Admin members can update project workflow template steps" ON public.project_workflow_template_steps AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Active members can view project workflow templates" ON public.project_workflow_templates AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Admin members can insert project workflow templates" ON public.project_workflow_templates AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Admin members can update project workflow templates" ON public.project_workflow_templates AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Active members can view project workflow types" ON public.project_workflow_types AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Admin members can insert project workflow types" ON public.project_workflow_types AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Admin members can update project workflow types" ON public.project_workflow_types AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Enable delete access for editor members" ON public.projects AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.projects AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.projects AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.projects AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Active members can view schedule task types" ON public.schedule_task_types AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Admin members can insert schedule task types" ON public.schedule_task_types AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Admin members can update schedule task types" ON public.schedule_task_types AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Enable delete access for editor members" ON public.schedule_tasks AS PERMISSIVE FOR DELETE TO "authenticated" USING (app_private.is_editor_member());
CREATE POLICY "Enable insert access for editor members" ON public.schedule_tasks AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Enable read access for active members" ON public.schedule_tasks AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "Enable update access for editor members" ON public.schedule_tasks AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_editor_member()) WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Active members can view se_supply_records" ON public.se_supply_records AS PERMISSIVE FOR SELECT TO "public" USING (app_private.is_active_member());
CREATE POLICY "Editors can delete se_supply_records" ON public.se_supply_records AS PERMISSIVE FOR DELETE TO "public" USING (app_private.is_editor_member());
CREATE POLICY "Editors can insert se_supply_records" ON public.se_supply_records AS PERMISSIVE FOR INSERT TO "public" WITH CHECK (app_private.is_editor_member());
CREATE POLICY "Editors can update se_supply_records" ON public.se_supply_records AS PERMISSIVE FOR UPDATE TO "public" USING (app_private.is_editor_member());
CREATE POLICY "team_members_insert_admins" ON public.team_members AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (app_private.is_admin_member());
CREATE POLICY "team_members_select_active_members" ON public.team_members AS PERMISSIVE FOR SELECT TO "authenticated" USING (app_private.is_active_member());
CREATE POLICY "team_members_update_admins" ON public.team_members AS PERMISSIVE FOR UPDATE TO "authenticated" USING (app_private.is_admin_member()) WITH CHECK (app_private.is_admin_member());
CREATE POLICY "Active members can read team todos" ON public.todos AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT app_private.is_active_member() AS is_active_member) AND (scope = 'TEAM'::text)));
CREATE POLICY "Creators can read private todos" ON public.todos AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT app_private.is_active_member() AS is_active_member) AND (scope = 'PRIVATE'::text) AND (created_by = ( SELECT app_private.current_member_id() AS current_member_id))));
CREATE POLICY "Editors can delete team todos" ON public.todos AS PERMISSIVE FOR DELETE TO "authenticated" USING ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'TEAM'::text)));
CREATE POLICY "Editors can delete their private todos" ON public.todos AS PERMISSIVE FOR DELETE TO "authenticated" USING ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'PRIVATE'::text) AND (created_by = ( SELECT app_private.current_member_id() AS current_member_id))));
CREATE POLICY "Editors can insert team todos" ON public.todos AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'TEAM'::text)));
CREATE POLICY "Editors can insert their private todos" ON public.todos AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'PRIVATE'::text) AND (created_by = ( SELECT app_private.current_member_id() AS current_member_id))));
CREATE POLICY "Editors can update team todos" ON public.todos AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'TEAM'::text))) WITH CHECK ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'TEAM'::text)));
CREATE POLICY "Editors can update their private todos" ON public.todos AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'PRIVATE'::text) AND (created_by = ( SELECT app_private.current_member_id() AS current_member_id)))) WITH CHECK ((( SELECT app_private.is_editor_member() AS is_editor_member) AND (scope = 'PRIVATE'::text) AND (created_by = ( SELECT app_private.current_member_id() AS current_member_id))));
CREATE POLICY "work_groups_active_read" ON public.work_groups AS PERMISSIVE FOR SELECT TO "authenticated" USING (((( SELECT app_private.is_active_member() AS is_active_member) AND is_active) OR ( SELECT app_private.is_admin_member() AS is_admin_member)));
CREATE POLICY "work_groups_admin_insert" ON public.work_groups AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "work_groups_admin_update" ON public.work_groups AS PERMISSIVE FOR UPDATE TO "authenticated" USING (( SELECT app_private.is_admin_member() AS is_admin_member)) WITH CHECK (( SELECT app_private.is_admin_member() AS is_admin_member));
CREATE POLICY "work_items_owner_delete" ON public.work_items AS PERMISSIVE FOR DELETE TO "authenticated" USING ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_items_owner_insert" ON public.work_items AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_items_owner_select" ON public.work_items AS PERMISSIVE FOR SELECT TO "authenticated" USING ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_items_owner_update" ON public.work_items AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id))) WITH CHECK ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_zones_owner_delete" ON public.work_zones AS PERMISSIVE FOR DELETE TO "authenticated" USING ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_zones_owner_insert" ON public.work_zones AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_zones_owner_select" ON public.work_zones AS PERMISSIVE FOR SELECT TO "authenticated" USING ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
CREATE POLICY "work_zones_owner_update" ON public.work_zones AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id))) WITH CHECK ((owner_member_id = ( SELECT app_private.current_member_id() AS current_member_id)));
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_views NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initialization_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initialization_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initialization_serials DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initialization_serials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initializations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initializations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_monthly_closing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_monthly_closing_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_monthly_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_monthly_closings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_serials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transaction_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transaction_serials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_dashboard_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_dashboard_views NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_positions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_work_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_work_groups NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_construction_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_construction_progress NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_difficulty_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_difficulty_assessments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_milestones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_position_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_position_assignments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_instances NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_phases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_template_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_template_steps NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_templates NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_types NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_task_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_task_types NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.se_supply_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se_supply_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.work_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_groups NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.work_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_zones NO FORCE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
-- Candidate intentionally does not reproduce Production's legacy anon/TRUNCATE/TRIGGER grants.
REVOKE ALL ON FUNCTION app_private.current_member_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.current_member_id() TO "authenticated";
REVOKE ALL ON FUNCTION app_private.default_legacy_schedule_work_group() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.default_legacy_team_todo_work_group() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.enforce_active_work_zone_limit() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.enforce_inventory_monthly_closing_state() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ensure_inventory_batch_for_transaction() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_workflow_framework_metadata() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.is_active_member() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.is_active_member() TO "authenticated";
REVOKE ALL ON FUNCTION app_private.is_admin_member() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.is_admin_member() TO "authenticated";
REVOKE ALL ON FUNCTION app_private.is_editor_member() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.is_editor_member() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.log_todo_history() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.normalize_contractor_work_capabilities() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.normalize_work_item_project_label() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.prepare_work_item_todo_provenance() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.preserve_schedule_task_creation_metadata() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.preserve_schedule_task_creation_metadata() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.protect_project_difficulty_assessment_provenance() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.protect_project_difficulty_assessment_provenance() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.protect_project_workflow_instance_provenance() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.protect_project_workflow_instance_provenance() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.protect_voided_inventory_serial_history() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.protect_voided_inventory_serial_history() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.protect_work_item_provenance() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.reject_closed_month_inventory_transaction_write() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.reject_locked_inventory_item_opening_quantity_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.reject_owner_team_member_changes() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.reject_owner_team_member_changes() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.safely_void_inventory_in_transaction() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.safely_void_inventory_in_transaction() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.set_position_responsibility_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.set_position_responsibility_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.set_project_construction_progress_updated_at() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.set_project_difficulty_assessment_evaluator() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.set_project_difficulty_assessment_evaluator() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.set_project_workflow_v2_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.set_project_workflow_v2_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.set_schedule_task_types_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.set_schedule_task_types_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.set_todo_updated_at() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.set_workbench_updated_at() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.validate_project_milestone_contract() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.validate_project_milestone_contract() TO PUBLIC;
REVOKE ALL ON FUNCTION app_private.validate_project_position_assignment() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.validate_project_position_assignment() TO PUBLIC;
REVOKE ALL ON FUNCTION public.classify_inventory_serial_format(p_serial text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.classify_inventory_serial_format(p_serial text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.classify_inventory_serial_format(p_serial text) TO "anon";
GRANT EXECUTE ON FUNCTION public.classify_inventory_serial_format(p_serial text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.classify_inventory_serial_format(p_serial text) TO "service_role";
REVOKE ALL ON FUNCTION public.configure_my_work_zones(p_zones jsonb, p_move_to uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.configure_my_work_zones(p_zones jsonb, p_move_to uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.configure_my_work_zones(p_zones jsonb, p_move_to uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.derive_inventory_serial_short_key(p_serial text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.derive_inventory_serial_short_key(p_serial text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.derive_inventory_serial_short_key(p_serial text) TO "anon";
GRANT EXECUTE ON FUNCTION public.derive_inventory_serial_short_key(p_serial text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.derive_inventory_serial_short_key(p_serial text) TO "service_role";
REVOKE ALL ON FUNCTION public.enforce_inventory_cutoff_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_inventory_cutoff_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_inventory_cutoff_guard() TO "anon";
GRANT EXECUTE ON FUNCTION public.enforce_inventory_cutoff_guard() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.enforce_inventory_cutoff_guard() TO "service_role";
REVOKE ALL ON FUNCTION public.initialize_inventory(items jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.initialize_inventory(items jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.initialize_inventory(items jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) TO "service_role";
REVOKE ALL ON FUNCTION public.normalize_inventory_serial(p_serial text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normalize_inventory_serial(p_serial text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_inventory_serial(p_serial text) TO "anon";
GRANT EXECUTE ON FUNCTION public.normalize_inventory_serial(p_serial text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.normalize_inventory_serial(p_serial text) TO "service_role";
REVOKE ALL ON FUNCTION public.preview_inventory_initialization(items jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_inventory_initialization(items jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.preview_inventory_initialization(items jsonb) TO "service_role";
REVOKE ALL ON FUNCTION public.preview_project_workflow_rebuild(p_project_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_project_workflow_rebuild(p_project_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.preview_project_workflow_rebuild(p_project_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_expected_start_date date, p_due_date date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_expected_start_date date, p_due_date date) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_expected_start_date date, p_due_date date) TO "service_role";
REVOKE ALL ON FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_project_label text, p_expected_start_date date, p_due_date date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_project_label text, p_expected_start_date date, p_due_date date) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.promote_private_todo_to_work_item(p_todo_id uuid, p_work_zone_id uuid, p_project_id uuid, p_project_label text, p_expected_start_date date, p_due_date date) TO "service_role";
REVOKE ALL ON FUNCTION public.rebuild_project_workflow(p_project_id uuid, p_preview_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_project_workflow(p_project_id uuid, p_preview_token text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.rebuild_project_workflow(p_project_id uuid, p_preview_token text) TO "service_role";
REVOKE ALL ON FUNCTION public.refresh_project_workflow(p_project_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_project_workflow(p_project_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.refresh_project_workflow(p_project_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.reject_todo(p_todo_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_todo(p_todo_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.reject_todo(p_todo_id uuid, p_reason text) TO "service_role";
REVOKE ALL ON FUNCTION public.set_member_dashboard_views(p_member_id uuid, p_view_ids uuid[], p_default_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_member_dashboard_views(p_member_id uuid, p_view_ids uuid[], p_default_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.set_member_dashboard_views(p_member_id uuid, p_view_ids uuid[], p_default_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.set_project_position_assignment(p_project_id uuid, p_position_id uuid, p_member_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_project_position_assignment(p_project_id uuid, p_position_id uuid, p_member_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.set_project_position_assignment(p_project_id uuid, p_position_id uuid, p_member_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO "anon";
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO "service_role";
REVOKE ALL ON FUNCTION public.snapshot_project_workflow(p_project_id uuid, p_template_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.snapshot_project_workflow(p_project_id uuid, p_template_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.snapshot_project_workflow(p_project_id uuid, p_template_id uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.unseal_inventory_month(p_year text, p_month text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unseal_inventory_month(p_year text, p_month text) TO "authenticated";
REVOKE ALL ON FUNCTION public.update_member_workspace_profile(p_member_id uuid, p_name text, p_email text, p_role text, p_is_active boolean, p_google_calendar_email text, p_notes text, p_position_ids uuid[], p_work_group_ids uuid[], p_default_work_group_id uuid, p_dashboard_view_ids uuid[], p_default_dashboard_view_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_member_workspace_profile(p_member_id uuid, p_name text, p_email text, p_role text, p_is_active boolean, p_google_calendar_email text, p_notes text, p_position_ids uuid[], p_work_group_ids uuid[], p_default_work_group_id uuid, p_dashboard_view_ids uuid[], p_default_dashboard_view_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.update_member_workspace_profile(p_member_id uuid, p_name text, p_email text, p_role text, p_is_active boolean, p_google_calendar_email text, p_notes text, p_position_ids uuid[], p_work_group_ids uuid[], p_default_work_group_id uuid, p_dashboard_view_ids uuid[], p_default_dashboard_view_id uuid) TO "service_role";

GRANT USAGE ON SCHEMA app_private TO authenticated;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
