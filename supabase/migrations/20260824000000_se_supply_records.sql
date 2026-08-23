-- Create SE Supply Records table
CREATE TABLE IF NOT EXISTS public.se_supply_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    project_name TEXT,
    old_model TEXT,
    faulty_serial TEXT,
    fault_reason TEXT,
    new_serial TEXT,
    receive_method TEXT,
    receive_date DATE,
    replace_date DATE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_se_supply_records_project_id
    ON public.se_supply_records(project_id);

-- Enable RLS
ALTER TABLE public.se_supply_records ENABLE ROW LEVEL SECURITY;

-- Select policy: all active members can read
CREATE POLICY "Active members can view se_supply_records"
    ON public.se_supply_records
    FOR SELECT
    USING (app_private.is_active_member());

-- Insert policy: editors can insert
CREATE POLICY "Editors can insert se_supply_records"
    ON public.se_supply_records
    FOR INSERT
    WITH CHECK (app_private.is_editor_member());

-- Update policy: editors can update
CREATE POLICY "Editors can update se_supply_records"
    ON public.se_supply_records
    FOR UPDATE
    USING (app_private.is_editor_member());

-- Delete policy: editors can delete (hard delete)
CREATE POLICY "Editors can delete se_supply_records"
    ON public.se_supply_records
    FOR DELETE
    USING (app_private.is_editor_member());
