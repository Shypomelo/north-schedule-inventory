-- Phase 1 keeps project procurement demand separate from canonical inventory movements.
CREATE TABLE public.material_catalog_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    default_specification text,
    default_unit text NOT NULL,
    default_reminder_enabled boolean NOT NULL DEFAULT false,
    default_reminder_days_before integer,
    is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    created_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT material_catalog_items_name_not_blank
        CHECK (btrim(name) <> ''),
    CONSTRAINT material_catalog_items_unit_not_blank
        CHECK (btrim(default_unit) <> ''),
    CONSTRAINT material_catalog_items_reminder_days_valid
        CHECK (
            (default_reminder_days_before IS NULL OR default_reminder_days_before BETWEEN 0 AND 3650)
            AND (NOT default_reminder_enabled OR default_reminder_days_before IS NOT NULL)
        )
);

CREATE UNIQUE INDEX material_catalog_items_normalized_name_spec_key
    ON public.material_catalog_items (
        lower(btrim(name)),
        lower(btrim(COALESCE(default_specification, '')))
    );

CREATE INDEX material_catalog_items_active_sort_idx
    ON public.material_catalog_items (is_active, sort_order, name);

CREATE INDEX material_catalog_items_created_by_idx
    ON public.material_catalog_items (created_by);

CREATE TABLE public.project_materials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    catalog_item_id uuid REFERENCES public.material_catalog_items(id) ON DELETE SET NULL,
    item_name text NOT NULL,
    specification text,
    quantity numeric NOT NULL DEFAULT 1,
    unit text NOT NULL,
    procurement_status text NOT NULL DEFAULT 'NOT_ORDERED',
    ordered_on date,
    expected_delivery_on date,
    received_on date,
    reminder_enabled boolean NOT NULL DEFAULT false,
    reminder_days_before integer,
    include_in_purchase_request boolean NOT NULL DEFAULT true,
    notes text,
    created_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_materials_name_not_blank
        CHECK (btrim(item_name) <> ''),
    CONSTRAINT project_materials_unit_not_blank
        CHECK (btrim(unit) <> ''),
    CONSTRAINT project_materials_quantity_positive
        CHECK (quantity > 0),
    CONSTRAINT project_materials_procurement_status_check
        CHECK (procurement_status IN ('NOT_ORDERED', 'ORDERED', 'PARTIAL_RECEIVED', 'RECEIVED')),
    CONSTRAINT project_materials_reminder_days_valid
        CHECK (
            (reminder_days_before IS NULL OR reminder_days_before BETWEEN 0 AND 3650)
            AND (NOT reminder_enabled OR reminder_days_before IS NOT NULL)
        )
);

COMMENT ON COLUMN public.project_materials.catalog_item_id IS
    'Optional provenance only. item_name, specification, unit and reminder fields are immutable-by-reference snapshots copied when the row is created.';

COMMENT ON COLUMN public.project_materials.expected_delivery_on IS
    'Phase 2 reminder input. Phase 1 stores this date but does not create reminder or todo rows.';

CREATE INDEX project_materials_project_sort_idx
    ON public.project_materials (project_id, created_at, id);

CREATE INDEX project_materials_catalog_item_idx
    ON public.project_materials (catalog_item_id)
    WHERE catalog_item_id IS NOT NULL;

CREATE INDEX project_materials_created_by_idx
    ON public.project_materials (created_by);

CREATE INDEX project_materials_expected_delivery_reminder_idx
    ON public.project_materials (expected_delivery_on, procurement_status)
    WHERE reminder_enabled = true
      AND expected_delivery_on IS NOT NULL
      AND procurement_status <> 'RECEIVED';

CREATE OR REPLACE FUNCTION app_private.set_material_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$;

CREATE TRIGGER set_material_catalog_items_updated_at
BEFORE UPDATE ON public.material_catalog_items
FOR EACH ROW
EXECUTE FUNCTION app_private.set_material_updated_at();

CREATE TRIGGER set_project_materials_updated_at
BEFORE UPDATE ON public.project_materials
FOR EACH ROW
EXECUTE FUNCTION app_private.set_material_updated_at();

CREATE OR REPLACE FUNCTION app_private.protect_material_creator()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'created_by is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER protect_material_catalog_creator
BEFORE UPDATE OF created_by ON public.material_catalog_items
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_material_creator();

CREATE TRIGGER protect_project_material_creator
BEFORE UPDATE OF created_by ON public.project_materials
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_material_creator();

ALTER TABLE public.material_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_materials ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.material_catalog_items, public.project_materials FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.material_catalog_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_materials TO authenticated;

CREATE POLICY "Active members can view material catalog"
ON public.material_catalog_items FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Admin members can insert material catalog"
ON public.material_catalog_items FOR INSERT
TO authenticated
WITH CHECK (
    (SELECT app_private.is_admin_member())
    AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Admin members can update material catalog"
ON public.material_catalog_items FOR UPDATE
TO authenticated
USING ((SELECT app_private.is_admin_member()))
WITH CHECK (
    (SELECT app_private.is_admin_member())
    AND created_by IS NOT NULL
);

CREATE POLICY "Active members can view project materials"
ON public.project_materials FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Editors can insert project materials"
ON public.project_materials FOR INSERT
TO authenticated
WITH CHECK (
    (SELECT app_private.is_editor_member())
    AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Editors can update project materials"
ON public.project_materials FOR UPDATE
TO authenticated
USING ((SELECT app_private.is_editor_member()))
WITH CHECK ((SELECT app_private.is_editor_member()));

CREATE POLICY "Editors can delete project materials"
ON public.project_materials FOR DELETE
TO authenticated
USING ((SELECT app_private.is_editor_member()));
