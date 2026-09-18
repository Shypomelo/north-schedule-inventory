ALTER TABLE public.project_materials
    ADD COLUMN receiving_archived_at timestamptz;

ALTER TABLE public.se_supply_records
    ADD COLUMN receiving_archived_at timestamptz;

COMMENT ON COLUMN public.project_materials.receiving_archived_at IS
    'When set, hides this canonical row from the Receiving Center projection without changing receipt history or project material state.';

COMMENT ON COLUMN public.se_supply_records.receiving_archived_at IS
    'When set, hides this canonical row from the Receiving Center projection without changing receipt history or SE supply state.';

-- project_materials already grants table-level UPDATE to authenticated editors.
-- se_supply_records deliberately uses column-level UPDATE grants, so add only
-- the new projection field while retaining the existing editor RLS policy.
GRANT UPDATE (receiving_archived_at)
ON TABLE public.se_supply_records
TO authenticated;
