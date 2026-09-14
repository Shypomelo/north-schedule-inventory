CREATE TABLE public.project_material_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    batch_name text NOT NULL,
    ordered_at timestamptz,
    notes text,
    created_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_material_batches_name_not_blank
        CHECK (btrim(batch_name) <> ''),
    CONSTRAINT project_material_batches_id_project_key
        UNIQUE (id, project_id)
);

ALTER TABLE public.project_materials
    ADD COLUMN batch_id uuid,
    ADD COLUMN expected_delivery_at timestamptz,
    ADD COLUMN received_at timestamptz;

UPDATE public.project_materials
SET expected_delivery_at = expected_delivery_on::timestamp AT TIME ZONE 'Asia/Taipei'
WHERE expected_delivery_on IS NOT NULL
  AND expected_delivery_at IS NULL;

UPDATE public.project_materials
SET received_at = received_on::timestamp AT TIME ZONE 'Asia/Taipei'
WHERE received_on IS NOT NULL
  AND received_at IS NULL;

WITH legacy_batch_sources AS (
    SELECT
        project_id,
        (array_agg(created_by ORDER BY created_at, id))[1] AS created_by,
        min(created_at) AS created_at,
        max(updated_at) AS updated_at,
        min(ordered_on) AS ordered_on
    FROM public.project_materials
    WHERE batch_id IS NULL
    GROUP BY project_id
), inserted_legacy_batches AS (
    INSERT INTO public.project_material_batches (
        project_id,
        batch_name,
        ordered_at,
        created_by,
        created_at,
        updated_at
    )
    SELECT
        project_id,
        '既有物料',
        ordered_on::timestamp AT TIME ZONE 'Asia/Taipei',
        created_by,
        created_at,
        updated_at
    FROM legacy_batch_sources
    RETURNING id, project_id
)
UPDATE public.project_materials AS material
SET batch_id = batch.id
FROM inserted_legacy_batches AS batch
WHERE material.project_id = batch.project_id
  AND material.batch_id IS NULL;

ALTER TABLE public.project_materials
    ALTER COLUMN batch_id SET NOT NULL,
    ADD CONSTRAINT project_materials_batch_project_fkey
        FOREIGN KEY (batch_id, project_id)
        REFERENCES public.project_material_batches(id, project_id)
        ON DELETE CASCADE;

CREATE INDEX project_material_batches_project_created_idx
    ON public.project_material_batches (project_id, created_at DESC, id DESC);

CREATE INDEX project_materials_batch_created_idx
    ON public.project_materials (batch_id, created_at, id);

CREATE INDEX project_materials_expected_delivery_at_reminder_idx
    ON public.project_materials (expected_delivery_at, procurement_status)
    WHERE reminder_enabled = true
      AND expected_delivery_at IS NOT NULL
      AND procurement_status <> 'RECEIVED';

COMMENT ON COLUMN public.project_materials.expected_delivery_at IS
    'Phase 2 reminder time basis. Phase 1 stores the timestamp but creates no reminder or todo rows.';

CREATE TRIGGER set_project_material_batches_updated_at
BEFORE UPDATE ON public.project_material_batches
FOR EACH ROW
EXECUTE FUNCTION app_private.set_material_updated_at();

CREATE TRIGGER protect_project_material_batch_creator
BEFORE UPDATE OF created_by ON public.project_material_batches
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_material_creator();

ALTER TABLE public.project_material_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.project_material_batches FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_material_batches TO authenticated;

CREATE POLICY "Active members can view project material batches"
ON public.project_material_batches FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Editors can insert project material batches"
ON public.project_material_batches FOR INSERT
TO authenticated
WITH CHECK (
    (SELECT app_private.is_editor_member())
    AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Editors can update project material batches"
ON public.project_material_batches FOR UPDATE
TO authenticated
USING ((SELECT app_private.is_editor_member()))
WITH CHECK (
    (SELECT app_private.is_editor_member())
    AND created_by IS NOT NULL
);

CREATE POLICY "Editors can delete project material batches"
ON public.project_material_batches FOR DELETE
TO authenticated
USING ((SELECT app_private.is_editor_member()));
