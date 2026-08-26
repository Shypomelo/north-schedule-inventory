CREATE TABLE public.schedule_task_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schedule_task_types_name_not_blank
        CHECK (lower(btrim(replace(name, chr(12288), ' '))) <> '')
);

-- PostgreSQL btrim does not reliably treat the ideographic space (U+3000) as
-- whitespace. Convert it to an ASCII space before trimming and folding case.
CREATE UNIQUE INDEX schedule_task_types_normalized_name_key
    ON public.schedule_task_types (
        lower(btrim(replace(name, chr(12288), ' ')))
    );

INSERT INTO public.schedule_task_types (name, sort_order)
VALUES
    ('現勘', 0),
    ('維修', 1),
    ('施工', 2),
    ('掛表', 3),
    ('送電', 4),
    ('清洗', 5),
    ('電檢', 6),
    ('確認', 7),
    ('內部', 8),
    ('其他', 9)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.set_schedule_task_types_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_schedule_task_types_updated_at
BEFORE UPDATE ON public.schedule_task_types
FOR EACH ROW
EXECUTE FUNCTION app_private.set_schedule_task_types_updated_at();

ALTER TABLE public.schedule_task_types ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.schedule_task_types FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.schedule_task_types TO authenticated;

CREATE POLICY "Active members can view schedule task types"
ON public.schedule_task_types
FOR SELECT
TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Admin members can insert schedule task types"
ON public.schedule_task_types
FOR INSERT
TO authenticated
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Admin members can update schedule task types"
ON public.schedule_task_types
FOR UPDATE
TO authenticated
USING (app_private.is_admin_member())
WITH CHECK (app_private.is_admin_member());

-- Intentionally no DELETE grant or policy. Phase 1 uses is_active for soft disable.
