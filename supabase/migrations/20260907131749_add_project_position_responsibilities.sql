-- Add an independent, data-driven position model without changing the
-- existing team_members.role or team_members.category contracts.

CREATE TABLE public.positions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT positions_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT positions_sort_order_nonnegative CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX positions_active_name_unique_idx
    ON public.positions (lower(btrim(name)))
    WHERE is_active = true;

CREATE INDEX positions_order_idx
    ON public.positions (is_active DESC, sort_order, name, id);

CREATE TABLE public.member_positions (
    member_id uuid NOT NULL
        REFERENCES public.team_members(id) ON DELETE CASCADE,
    position_id uuid NOT NULL
        REFERENCES public.positions(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (member_id, position_id)
);

CREATE INDEX member_positions_position_member_idx
    ON public.member_positions (position_id, member_id);

CREATE TABLE public.project_position_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL
        REFERENCES public.projects(id) ON DELETE CASCADE,
    position_id uuid NOT NULL
        REFERENCES public.positions(id) ON DELETE RESTRICT,
    member_id uuid NOT NULL
        REFERENCES public.team_members(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_position_assignments_project_position_key
        UNIQUE (project_id, position_id)
);

CREATE INDEX project_position_assignments_member_project_idx
    ON public.project_position_assignments (member_id, project_id);

ALTER TABLE public.project_workflow_template_steps
    ADD COLUMN responsible_position_id uuid
        REFERENCES public.positions(id) ON DELETE RESTRICT;

ALTER TABLE public.project_milestones
    ADD COLUMN responsible_position_id uuid
        REFERENCES public.positions(id) ON DELETE RESTRICT;

CREATE INDEX project_workflow_template_steps_responsible_position_idx
    ON public.project_workflow_template_steps (responsible_position_id)
    WHERE responsible_position_id IS NOT NULL;

CREATE INDEX project_milestones_responsible_position_idx
    ON public.project_milestones (project_id, responsible_position_id, sort_order)
    WHERE deleted_at IS NULL
      AND is_applicable = true
      AND responsible_position_id IS NOT NULL;

CREATE FUNCTION app_private.set_position_responsibility_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_positions_updated_at
BEFORE UPDATE ON public.positions
FOR EACH ROW
EXECUTE FUNCTION app_private.set_position_responsibility_updated_at();

CREATE TRIGGER set_project_position_assignments_updated_at
BEFORE UPDATE ON public.project_position_assignments
FOR EACH ROW
EXECUTE FUNCTION app_private.set_position_responsibility_updated_at();

CREATE FUNCTION app_private.validate_project_position_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
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
$$;

CREATE TRIGGER validate_project_position_assignment
BEFORE INSERT OR UPDATE OF position_id, member_id
ON public.project_position_assignments
FOR EACH ROW
EXECUTE FUNCTION app_private.validate_project_position_assignment();

INSERT INTO public.positions (name, sort_order)
VALUES
    ('工程', 10),
    ('電力設計', 20),
    ('結構設計', 30),
    ('行政', 40)
ON CONFLICT DO NOTHING;

WITH desired(step_key, position_name) AS (
    VALUES
        ('SITE_SURVEY', '工程'),
        ('STRUCTURAL_DRAWING', '結構設計'),
        ('ELECTRICAL_DRAWING', '電力設計'),
        ('MATERIAL_REQUEST', '工程'),
        ('START_WORK_CHECKLIST', '工程'),
        ('TAIPOWER_SUBMISSION', '電力設計'),
        ('REVIEW_OPINION_RECEIVED', '電力設計'),
        ('CONSENT_FILING_RECEIVED', '行政'),
        ('MISC_EXEMPTION_SUBMISSION', '行政'),
        ('MISC_EXEMPTION_RECEIVED', '行政'),
        ('TAIPOWER_COORDINATION', '電力設計'),
        ('ENTRY_READINESS', '工程'),
        ('SITE_ENTRY', '工程'),
        ('EXTERNAL_LINE_COMPLETED', '電力設計'),
        ('COMPLETION', '工程'),
        ('INTERNAL_ACCEPTANCE', '工程'),
        ('COMPLETION_REPORT', '工程'),
        ('METER_INSTALLATION', '工程')
), resolved AS (
    SELECT step.id AS step_id, position.id AS position_id
    FROM desired
    JOIN public.project_workflow_templates AS template
      ON template.template_key = 'NORTH_DEFAULT'
    JOIN public.project_workflow_template_steps AS step
      ON step.template_id = template.id
     AND step.step_key = desired.step_key
     AND step.is_active = true
    JOIN public.positions AS position
      ON lower(btrim(position.name)) = lower(desired.position_name)
     AND position.is_active = true
)
UPDATE public.project_workflow_template_steps AS step
SET responsible_position_id = resolved.position_id
FROM resolved
WHERE step.id = resolved.step_id;

-- Backfill only milestones with exact template-step provenance. Custom and
-- ambiguous legacy rows remain NULL, and no workflow progress fields change.
-- The existing validation trigger intentionally rehydrates template identity
-- on every update, so suspend it only for this exact metadata-only backfill.
ALTER TABLE public.project_milestones
    DISABLE TRIGGER validate_project_milestone_contract;

UPDATE public.project_milestones AS milestone
SET responsible_position_id = step.responsible_position_id
FROM public.project_workflow_template_steps AS step
WHERE milestone.origin = 'TEMPLATE'
  AND milestone.source_template_step_id = step.id
  AND milestone.responsible_position_id IS NULL
  AND step.responsible_position_id IS NOT NULL;

ALTER TABLE public.project_milestones
    ENABLE TRIGGER validate_project_milestone_contract;

-- Keep the existing RPC signature and result contract so DB-new/App-old is
-- safe. The only added behavior is copying the nullable position snapshot.
CREATE OR REPLACE FUNCTION public.snapshot_project_workflow(
    p_project_id uuid,
    p_template_id uuid DEFAULT NULL
)
RETURNS TABLE (
    result text,
    workflow_instance_id uuid,
    milestones_created integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
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
$$;

ALTER FUNCTION public.snapshot_project_workflow(uuid, uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.snapshot_project_workflow(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.snapshot_project_workflow(uuid, uuid) TO authenticated;

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_position_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.positions, public.member_positions, public.project_position_assignments
    FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.positions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.member_positions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_position_assignments TO authenticated;

CREATE POLICY "Active members can view positions"
ON public.positions FOR SELECT TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Admin members can insert positions"
ON public.positions FOR INSERT TO authenticated
WITH CHECK ((SELECT app_private.is_admin_member()));

CREATE POLICY "Admin members can update positions"
ON public.positions FOR UPDATE TO authenticated
USING ((SELECT app_private.is_admin_member()))
WITH CHECK ((SELECT app_private.is_admin_member()));

CREATE POLICY "Active members can view member positions"
ON public.member_positions FOR SELECT TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Admin members can insert member positions"
ON public.member_positions FOR INSERT TO authenticated
WITH CHECK ((SELECT app_private.is_admin_member()));

CREATE POLICY "Admin members can update member positions"
ON public.member_positions FOR UPDATE TO authenticated
USING ((SELECT app_private.is_admin_member()))
WITH CHECK ((SELECT app_private.is_admin_member()));

CREATE POLICY "Admin members can delete member positions"
ON public.member_positions FOR DELETE TO authenticated
USING ((SELECT app_private.is_admin_member()));

CREATE POLICY "Active members can view project position assignments"
ON public.project_position_assignments FOR SELECT TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Editor members can insert project position assignments"
ON public.project_position_assignments FOR INSERT TO authenticated
WITH CHECK ((SELECT app_private.is_editor_member()));

CREATE POLICY "Editor members can update project position assignments"
ON public.project_position_assignments FOR UPDATE TO authenticated
USING ((SELECT app_private.is_editor_member()))
WITH CHECK ((SELECT app_private.is_editor_member()));

CREATE POLICY "Editor members can delete project position assignments"
ON public.project_position_assignments FOR DELETE TO authenticated
USING ((SELECT app_private.is_editor_member()));
