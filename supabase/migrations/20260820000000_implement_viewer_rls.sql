-- Create editor helper using the same identity source as existing member helpers.
CREATE OR REPLACE FUNCTION app_private.is_editor_member()
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
      AND lower(tm.role) IN ('admin', 'engineer')
  );
$$;

-- Enable RLS.
ALTER TABLE public.schedule_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_construction_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transaction_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_monthly_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_monthly_closing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: active authenticated members can read.
DO $$
DECLARE
  table_name text;
  tables text[] := ARRAY[
    'schedule_tasks',
    'projects',
    'project_construction_progress',
    'contractors',
    'inventory_items',
    'inventory_transactions',
    'inventory_batches',
    'inventory_serials',
    'inventory_transaction_serials',
    'inventory_monthly_closings',
    'inventory_monthly_closing_items',
    'activity_logs'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('
      CREATE POLICY "Enable read access for active members" ON public.%I
      FOR SELECT
      TO authenticated
      USING (app_private.is_active_member());
    ', table_name);
  END LOOP;
END;
$$;

-- INSERT / UPDATE / DELETE: editor members can write, except contractors.
DO $$
DECLARE
  table_name text;
  tables text[] := ARRAY[
    'schedule_tasks',
    'projects',
    'project_construction_progress',
    'inventory_items',
    'inventory_transactions',
    'inventory_batches',
    'inventory_serials',
    'inventory_transaction_serials',
    'inventory_monthly_closings',
    'inventory_monthly_closing_items',
    'activity_logs'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('
      CREATE POLICY "Enable insert access for editor members" ON public.%I
      FOR INSERT
      TO authenticated
      WITH CHECK (app_private.is_editor_member());
    ', table_name);

    EXECUTE format('
      CREATE POLICY "Enable update access for editor members" ON public.%I
      FOR UPDATE
      TO authenticated
      USING (app_private.is_editor_member())
      WITH CHECK (app_private.is_editor_member());
    ', table_name);

    EXECUTE format('
      CREATE POLICY "Enable delete access for editor members" ON public.%I
      FOR DELETE
      TO authenticated
      USING (app_private.is_editor_member());
    ', table_name);
  END LOOP;
END;
$$;

-- Contractors are admin-only for writes.
CREATE POLICY "Enable insert access for admin members" ON public.contractors
FOR INSERT
TO authenticated
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Enable update access for admin members" ON public.contractors
FOR UPDATE
TO authenticated
USING (app_private.is_admin_member())
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Enable delete access for admin members" ON public.contractors
FOR DELETE
TO authenticated
USING (app_private.is_admin_member());
