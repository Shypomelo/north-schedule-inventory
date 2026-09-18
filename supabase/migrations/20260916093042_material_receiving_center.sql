-- Phase A.2: one shared inbound receiving center over the existing
-- project_materials and se_supply_records canonical sources.

ALTER TABLE public.material_catalog_items
    ADD COLUMN default_delivery_destination text NOT NULL DEFAULT 'SITE';

ALTER TABLE public.material_catalog_items
    ADD CONSTRAINT material_catalog_items_delivery_destination_check
    CHECK (default_delivery_destination IN ('OFFICE', 'SITE', 'WAREHOUSE', 'OTHER'));

ALTER TABLE public.project_materials
    ADD COLUMN delivery_destination text NOT NULL DEFAULT 'SITE',
    ADD COLUMN delivery_destination_note text;

ALTER TABLE public.project_materials
    ADD CONSTRAINT project_materials_delivery_destination_check
    CHECK (delivery_destination IN ('OFFICE', 'SITE', 'WAREHOUSE', 'OTHER')),
    ADD CONSTRAINT project_materials_delivery_destination_note_check
    CHECK (
        delivery_destination = 'OTHER'
        OR delivery_destination_note IS NULL
    );

ALTER TABLE public.se_supply_records
    ADD COLUMN quantity numeric NOT NULL DEFAULT 1,
    ADD COLUMN unit text NOT NULL DEFAULT '台',
    ADD COLUMN expected_delivery_at timestamptz,
    ADD COLUMN requested_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
    ADD COLUMN procurement_status text NOT NULL DEFAULT 'ORDERED',
    ADD COLUMN received_at timestamptz,
    ADD COLUMN received_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

UPDATE public.se_supply_records
SET procurement_status = 'RECEIVED',
    received_at = COALESCE(
        received_at,
        receive_date::timestamp AT TIME ZONE 'Asia/Taipei'
    )
WHERE receive_date IS NOT NULL;

ALTER TABLE public.se_supply_records
    ADD CONSTRAINT se_supply_records_quantity_positive
    CHECK (quantity > 0),
    ADD CONSTRAINT se_supply_records_unit_not_blank
    CHECK (btrim(unit) <> ''),
    ADD CONSTRAINT se_supply_records_procurement_status_check
    CHECK (procurement_status IN ('ORDERED', 'PARTIAL_RECEIVED', 'RECEIVED'));

CREATE INDEX se_supply_records_pending_receipt_idx
    ON public.se_supply_records (expected_delivery_at, id)
    WHERE procurement_status <> 'RECEIVED'
      AND received_at IS NULL;

CREATE INDEX project_materials_office_receipt_idx
    ON public.project_materials (project_id, batch_id, id)
    WHERE delivery_destination = 'OFFICE';

CREATE TABLE public.material_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type text NOT NULL,
    project_material_id uuid REFERENCES public.project_materials(id) ON DELETE RESTRICT,
    se_supply_record_id uuid REFERENCES public.se_supply_records(id) ON DELETE RESTRICT,
    quantity_received numeric NOT NULL,
    received_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
    received_at timestamptz NOT NULL DEFAULT now(),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT material_receipts_quantity_positive
        CHECK (quantity_received > 0),
    CONSTRAINT material_receipts_single_source_check
        CHECK (
            (
                source_type = 'PROJECT_MATERIAL'
                AND project_material_id IS NOT NULL
                AND se_supply_record_id IS NULL
            )
            OR
            (
                source_type = 'SE_SUPPLY'
                AND project_material_id IS NULL
                AND se_supply_record_id IS NOT NULL
            )
        )
);

CREATE INDEX material_receipts_project_material_idx
    ON public.material_receipts (project_material_id, received_at DESC)
    WHERE project_material_id IS NOT NULL;

CREATE INDEX material_receipts_se_supply_idx
    ON public.material_receipts (se_supply_record_id, received_at DESC)
    WHERE se_supply_record_id IS NOT NULL;

CREATE INDEX material_receipts_history_idx
    ON public.material_receipts (received_at DESC, id DESC);

ALTER TABLE public.material_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Active members can view material receipts"
ON public.material_receipts
FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

REVOKE ALL ON TABLE public.material_receipts FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.material_receipts TO authenticated;
GRANT ALL ON TABLE public.material_receipts TO service_role;

-- Tighten the legacy SE policies to the same explicit role/check convention
-- used by current project-material tables.
DROP POLICY IF EXISTS "Active members can view se_supply_records" ON public.se_supply_records;
DROP POLICY IF EXISTS "Editors can insert se_supply_records" ON public.se_supply_records;
DROP POLICY IF EXISTS "Editors can update se_supply_records" ON public.se_supply_records;
DROP POLICY IF EXISTS "Editors can delete se_supply_records" ON public.se_supply_records;

CREATE POLICY "Active members can view se_supply_records"
ON public.se_supply_records
FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Editors can insert se_supply_records"
ON public.se_supply_records
FOR INSERT
TO authenticated
WITH CHECK ((SELECT app_private.is_editor_member()));

CREATE POLICY "Editors can update se_supply_records"
ON public.se_supply_records
FOR UPDATE
TO authenticated
USING ((SELECT app_private.is_editor_member()))
WITH CHECK ((SELECT app_private.is_editor_member()));

CREATE POLICY "Editors can delete se_supply_records"
ON public.se_supply_records
FOR DELETE
TO authenticated
USING ((SELECT app_private.is_editor_member()));

-- Receipt state and receiver identity are mutation-owned by
-- confirm_material_receipt. Existing SE editing remains available for the
-- original tracking fields.
REVOKE UPDATE ON TABLE public.se_supply_records FROM authenticated;
GRANT UPDATE (
    project_id,
    project_name,
    old_model,
    faulty_serial,
    fault_reason,
    new_model,
    new_serial,
    receive_method,
    receive_date,
    replace_date,
    notes,
    updated_at,
    quantity,
    unit,
    expected_delivery_at,
    requested_by
) ON TABLE public.se_supply_records TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_material_receipt(
    p_source_type text,
    p_source_id uuid,
    p_quantity_received numeric,
    p_received_at timestamptz DEFAULT now(),
    p_notes text DEFAULT NULL
)
RETURNS SETOF public.material_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_member_id uuid;
    v_receipt public.material_receipts%ROWTYPE;
    v_material public.project_materials%ROWTYPE;
    v_se public.se_supply_records%ROWTYPE;
    v_received numeric;
    v_total_received numeric;
BEGIN
    IF NOT app_private.is_editor_member() THEN
        RAISE EXCEPTION 'Only active editor members can confirm receipts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_member_id := app_private.current_member_id();
    IF v_member_id IS NULL THEN
        RAISE EXCEPTION 'Current active member not found'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_source_type NOT IN ('PROJECT_MATERIAL', 'SE_SUPPLY') THEN
        RAISE EXCEPTION 'Unsupported material receipt source'
            USING ERRCODE = '23514';
    END IF;

    IF p_quantity_received IS NULL OR p_quantity_received <= 0 THEN
        RAISE EXCEPTION 'Received quantity must be positive'
            USING ERRCODE = '23514';
    END IF;

    IF p_received_at IS NULL THEN
        RAISE EXCEPTION 'Received time is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_source_type = 'PROJECT_MATERIAL' THEN
        SELECT * INTO v_material
        FROM public.project_materials
        WHERE id = p_source_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Project material not found'
                USING ERRCODE = 'P0002';
        END IF;

        IF v_material.delivery_destination <> 'OFFICE' THEN
            RAISE EXCEPTION 'Only office-delivery project materials can be received here'
                USING ERRCODE = '23514';
        END IF;

        SELECT COALESCE(sum(receipt.quantity_received), 0)
        INTO v_received
        FROM public.material_receipts AS receipt
        WHERE receipt.project_material_id = v_material.id;

        IF v_material.procurement_status = 'RECEIVED'
           OR v_material.received_at IS NOT NULL
           OR v_received >= v_material.quantity THEN
            RAISE EXCEPTION 'Project material is already fully received'
                USING ERRCODE = '23514';
        END IF;

        IF p_quantity_received > v_material.quantity - v_received THEN
            RAISE EXCEPTION 'Received quantity exceeds the remaining project material quantity'
                USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.material_receipts (
            source_type,
            project_material_id,
            quantity_received,
            received_by,
            received_at,
            notes
        )
        VALUES (
            'PROJECT_MATERIAL',
            v_material.id,
            p_quantity_received,
            v_member_id,
            p_received_at,
            NULLIF(btrim(COALESCE(p_notes, '')), '')
        )
        RETURNING * INTO v_receipt;

        v_total_received := v_received + p_quantity_received;

        UPDATE public.project_materials
        SET procurement_status = CASE
                WHEN v_total_received >= quantity THEN 'RECEIVED'
                ELSE 'PARTIAL_RECEIVED'
            END,
            received_at = CASE
                WHEN v_total_received >= quantity THEN p_received_at
                ELSE NULL
            END,
            received_on = CASE
                WHEN v_total_received >= quantity
                THEN (p_received_at AT TIME ZONE 'Asia/Taipei')::date
                ELSE NULL
            END,
            updated_at = now()
        WHERE id = v_material.id;

        IF NOT EXISTS (
            SELECT 1
            FROM public.project_materials AS material
            WHERE material.batch_id = v_material.batch_id
              AND (
                  material.procurement_status <> 'RECEIVED'
                  OR material.received_at IS NULL
              )
        ) THEN
            UPDATE public.project_material_batches
            SET received_at = COALESCE(received_at, p_received_at),
                updated_at = now()
            WHERE id = v_material.batch_id;
        END IF;
    ELSE
        SELECT * INTO v_se
        FROM public.se_supply_records
        WHERE id = p_source_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'SE supply record not found'
                USING ERRCODE = 'P0002';
        END IF;

        SELECT COALESCE(sum(receipt.quantity_received), 0)
        INTO v_received
        FROM public.material_receipts AS receipt
        WHERE receipt.se_supply_record_id = v_se.id;

        IF v_se.procurement_status = 'RECEIVED'
           OR v_se.received_at IS NOT NULL
           OR v_received >= v_se.quantity THEN
            RAISE EXCEPTION 'SE supply is already fully received'
                USING ERRCODE = '23514';
        END IF;

        IF p_quantity_received > v_se.quantity - v_received THEN
            RAISE EXCEPTION 'Received quantity exceeds the remaining SE supply quantity'
                USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.material_receipts (
            source_type,
            se_supply_record_id,
            quantity_received,
            received_by,
            received_at,
            notes
        )
        VALUES (
            'SE_SUPPLY',
            v_se.id,
            p_quantity_received,
            v_member_id,
            p_received_at,
            NULLIF(btrim(COALESCE(p_notes, '')), '')
        )
        RETURNING * INTO v_receipt;

        v_total_received := v_received + p_quantity_received;

        UPDATE public.se_supply_records
        SET procurement_status = CASE
                WHEN v_total_received >= quantity THEN 'RECEIVED'
                ELSE 'PARTIAL_RECEIVED'
            END,
            received_at = CASE
                WHEN v_total_received >= quantity THEN p_received_at
                ELSE NULL
            END,
            received_by = CASE
                WHEN v_total_received >= quantity THEN v_member_id
                ELSE NULL
            END,
            receive_date = CASE
                WHEN v_total_received >= quantity
                THEN (p_received_at AT TIME ZONE 'Asia/Taipei')::date
                ELSE NULL
            END,
            updated_at = now()
        WHERE id = v_se.id;
    END IF;

    RETURN NEXT v_receipt;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_material_receipt(text, uuid, numeric, timestamptz, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_material_receipt(text, uuid, numeric, timestamptz, text)
TO authenticated;

COMMENT ON TABLE public.material_receipts IS
    'Append-only inbound receiving evidence for project materials and SE supplies.';

COMMENT ON FUNCTION public.confirm_material_receipt(text, uuid, numeric, timestamptz, text) IS
    'Atomically appends one receipt and synchronizes its canonical source. received_by is always resolved from the authenticated member.';

NOTIFY pgrst, 'reload schema';
