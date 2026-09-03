-- Project Workflow V2 data contract.
--
-- This migration is intentionally schema-only. Application wiring, existing
-- project initialization, and UI integration are separate release phases.

CREATE TABLE public.project_workflow_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key text NOT NULL UNIQUE,
    name text NOT NULL,
    description text,
    is_active boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_workflow_templates_key_not_blank
        CHECK (btrim(template_key) <> ''),
    CONSTRAINT project_workflow_templates_name_not_blank
        CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX project_workflow_templates_one_active_default_idx
    ON public.project_workflow_templates (is_default)
    WHERE is_active = true AND is_default = true;

CREATE TABLE public.project_workflow_phases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phase_key text NOT NULL UNIQUE,
    name text NOT NULL,
    sort_order integer NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_workflow_phases_key_not_blank
        CHECK (btrim(phase_key) <> ''),
    CONSTRAINT project_workflow_phases_name_not_blank
        CHECK (btrim(name) <> ''),
    CONSTRAINT project_workflow_phases_sort_order_nonnegative
        CHECK (sort_order >= 0)
);

CREATE TABLE public.project_workflow_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type_key text NOT NULL UNIQUE,
    name text NOT NULL,
    sort_order integer NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_workflow_types_key_not_blank
        CHECK (btrim(type_key) <> ''),
    CONSTRAINT project_workflow_types_name_not_blank
        CHECK (btrim(name) <> ''),
    CONSTRAINT project_workflow_types_sort_order_nonnegative
        CHECK (sort_order >= 0)
);

CREATE TABLE public.project_workflow_template_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL
        REFERENCES public.project_workflow_templates(id) ON DELETE RESTRICT,
    step_key text NOT NULL,
    label text NOT NULL,
    phase_id uuid NOT NULL
        REFERENCES public.project_workflow_phases(id) ON DELETE RESTRICT,
    type_id uuid NOT NULL
        REFERENCES public.project_workflow_types(id) ON DELETE RESTRICT,
    sort_order integer NOT NULL,
    default_is_applicable boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_workflow_template_steps_template_step_key_key
        UNIQUE (template_id, step_key),
    CONSTRAINT project_workflow_template_steps_key_not_blank
        CHECK (btrim(step_key) <> ''),
    CONSTRAINT project_workflow_template_steps_label_not_blank
        CHECK (btrim(label) <> ''),
    CONSTRAINT project_workflow_template_steps_sort_order_nonnegative
        CHECK (sort_order >= 0)
);

CREATE INDEX project_workflow_template_steps_lookup_idx
    ON public.project_workflow_template_steps (template_id, is_active, sort_order);

CREATE TABLE public.project_workflow_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL
        REFERENCES public.projects(id) ON DELETE RESTRICT,
    source_template_id uuid NOT NULL
        REFERENCES public.project_workflow_templates(id) ON DELETE RESTRICT,
    template_key_snapshot text NOT NULL,
    template_name_snapshot text NOT NULL,
    snapshot_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT project_workflow_instances_template_key_snapshot_not_blank
        CHECK (btrim(template_key_snapshot) <> ''),
    CONSTRAINT project_workflow_instances_template_name_snapshot_not_blank
        CHECK (btrim(template_name_snapshot) <> '')
);

CREATE UNIQUE INDEX project_workflow_instances_one_active_project_idx
    ON public.project_workflow_instances (project_id)
    WHERE deleted_at IS NULL;

CREATE TABLE public.project_milestones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_instance_id uuid NOT NULL
        REFERENCES public.project_workflow_instances(id) ON DELETE RESTRICT,
    project_id uuid NOT NULL
        REFERENCES public.projects(id) ON DELETE RESTRICT,
    origin text NOT NULL,
    source_template_step_id uuid
        REFERENCES public.project_workflow_template_steps(id) ON DELETE RESTRICT,
    milestone_key text NOT NULL
        DEFAULT ('CUSTOM_' || replace(gen_random_uuid()::text, '-', '')),
    label text NOT NULL,
    source_phase_id uuid NOT NULL
        REFERENCES public.project_workflow_phases(id) ON DELETE RESTRICT,
    phase_key_snapshot text NOT NULL,
    phase_name_snapshot text NOT NULL,
    source_type_id uuid NOT NULL
        REFERENCES public.project_workflow_types(id) ON DELETE RESTRICT,
    type_key_snapshot text NOT NULL,
    type_name_snapshot text NOT NULL,
    sort_order integer NOT NULL,
    is_applicable boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'NOT_STARTED',
    planned_date date,
    actual_date date,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT project_milestones_origin_check
        CHECK (origin IN ('TEMPLATE', 'PROJECT_CUSTOM')),
    CONSTRAINT project_milestones_template_provenance_check
        CHECK (
            (origin = 'TEMPLATE' AND source_template_step_id IS NOT NULL)
            OR
            (origin = 'PROJECT_CUSTOM' AND source_template_step_id IS NULL)
        ),
    CONSTRAINT project_milestones_key_not_blank
        CHECK (btrim(milestone_key) <> ''),
    CONSTRAINT project_milestones_label_not_blank
        CHECK (btrim(label) <> ''),
    CONSTRAINT project_milestones_phase_key_snapshot_not_blank
        CHECK (btrim(phase_key_snapshot) <> ''),
    CONSTRAINT project_milestones_phase_name_snapshot_not_blank
        CHECK (btrim(phase_name_snapshot) <> ''),
    CONSTRAINT project_milestones_type_key_snapshot_not_blank
        CHECK (btrim(type_key_snapshot) <> ''),
    CONSTRAINT project_milestones_type_name_snapshot_not_blank
        CHECK (btrim(type_name_snapshot) <> ''),
    CONSTRAINT project_milestones_sort_order_nonnegative
        CHECK (sort_order >= 0),
    CONSTRAINT project_milestones_status_check
        CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED')),
    CONSTRAINT project_milestones_completion_consistency
        CHECK ((status = 'COMPLETED') = (actual_date IS NOT NULL))
);

CREATE UNIQUE INDEX project_milestones_active_instance_key_idx
    ON public.project_milestones (workflow_instance_id, milestone_key)
    WHERE deleted_at IS NULL;

CREATE INDEX project_milestones_active_project_sort_idx
    ON public.project_milestones (project_id, sort_order)
    WHERE deleted_at IS NULL;

CREATE INDEX project_milestones_active_project_status_idx
    ON public.project_milestones (project_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX project_milestones_active_project_planned_date_idx
    ON public.project_milestones (project_id, planned_date)
    WHERE deleted_at IS NULL;

CREATE FUNCTION app_private.set_project_workflow_v2_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_project_workflow_templates_updated_at
BEFORE UPDATE ON public.project_workflow_templates
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE TRIGGER set_project_workflow_phases_updated_at
BEFORE UPDATE ON public.project_workflow_phases
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE TRIGGER set_project_workflow_types_updated_at
BEFORE UPDATE ON public.project_workflow_types
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE TRIGGER set_project_workflow_template_steps_updated_at
BEFORE UPDATE ON public.project_workflow_template_steps
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE TRIGGER set_project_workflow_instances_updated_at
BEFORE UPDATE ON public.project_workflow_instances
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE TRIGGER set_project_milestones_updated_at
BEFORE UPDATE ON public.project_milestones
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE FUNCTION app_private.protect_project_workflow_instance_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
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
$$;

CREATE TRIGGER protect_project_workflow_instance_provenance
BEFORE UPDATE OF
    project_id,
    source_template_id,
    template_key_snapshot,
    template_name_snapshot,
    snapshot_at
ON public.project_workflow_instances
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_project_workflow_instance_provenance();

CREATE FUNCTION app_private.validate_project_milestone_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
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
                RAISE EXCEPTION 'Template milestone classification provenance is immutable'
                    USING ERRCODE = 'check_violation';
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
$$;

CREATE TRIGGER validate_project_milestone_contract
BEFORE INSERT OR UPDATE ON public.project_milestones
FOR EACH ROW
EXECUTE FUNCTION app_private.validate_project_milestone_contract();

-- Idempotent initial settings. Re-running seed statements never overwrites
-- administrator changes made after the initial insert.
INSERT INTO public.project_workflow_phases (phase_key, name, sort_order)
VALUES
    ('PREPARATION', '前期', 10),
    ('STARTUP', '開工準備', 20),
    ('CONSTRUCTION', '施工', 30),
    ('CLOSEOUT', '收尾', 40)
ON CONFLICT (phase_key) DO NOTHING;

INSERT INTO public.project_workflow_types (type_key, name, sort_order)
VALUES
    ('ENGINEERING', '工程', 10),
    ('DESIGN', '設計', 20),
    ('GOVERNMENT', '政府', 30),
    ('MATERIAL', '物料', 40),
    ('ACCEPTANCE', '驗收', 50),
    ('TAIPOWER', '台電', 60)
ON CONFLICT (type_key) DO NOTHING;

INSERT INTO public.project_workflow_templates (
    template_key,
    name,
    is_active,
    is_default
)
VALUES ('NORTH_DEFAULT', '北部工程預設流程', true, true)
ON CONFLICT (template_key) DO NOTHING;

WITH seed(step_key, label, phase_key, type_key, sort_order) AS (
    VALUES
        ('SITE_SURVEY', '初次現勘', 'PREPARATION', 'ENGINEERING', 10),
        ('STRUCTURAL_DRAWING', '結構圖確認', 'PREPARATION', 'DESIGN', 20),
        ('GOVERNMENT_DOCUMENTS', '政府文件確認', 'STARTUP', 'GOVERNMENT', 30),
        ('ELECTRICAL_DRAWING', '電力圖確認', 'STARTUP', 'DESIGN', 40),
        ('MATERIAL_REQUEST', '物料申請', 'STARTUP', 'MATERIAL', 50),
        ('START_WORK_CHECKLIST', '開工清單', 'STARTUP', 'ENGINEERING', 60),
        ('ENTRY_READINESS', '進場條件確認', 'STARTUP', 'ENGINEERING', 70),
        ('SITE_ENTRY', '進場', 'CONSTRUCTION', 'ENGINEERING', 80),
        ('COMPLETION', '完工', 'CONSTRUCTION', 'ENGINEERING', 90),
        ('INTERNAL_ACCEPTANCE', '工程內部驗收', 'CLOSEOUT', 'ACCEPTANCE', 100),
        ('METER_INSTALLATION', '掛表', 'CLOSEOUT', 'TAIPOWER', 110)
)
INSERT INTO public.project_workflow_template_steps (
    template_id,
    step_key,
    label,
    phase_id,
    type_id,
    sort_order,
    default_is_applicable,
    is_active
)
SELECT
    template.id,
    seed.step_key,
    seed.label,
    phase.id,
    workflow_type.id,
    seed.sort_order,
    true,
    true
FROM seed
JOIN public.project_workflow_templates AS template
  ON template.template_key = 'NORTH_DEFAULT'
JOIN public.project_workflow_phases AS phase
  ON phase.phase_key = seed.phase_key
JOIN public.project_workflow_types AS workflow_type
  ON workflow_type.type_key = seed.type_key
ON CONFLICT (template_id, step_key) DO NOTHING;

ALTER TABLE public.project_workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_template_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_milestones ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.project_workflow_templates FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_workflow_phases FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_workflow_types FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_workflow_template_steps FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_workflow_instances FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_milestones FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE
    ON TABLE public.project_workflow_templates,
             public.project_workflow_phases,
             public.project_workflow_types,
             public.project_workflow_template_steps
    TO authenticated;

GRANT SELECT
    ON TABLE public.project_workflow_instances
    TO authenticated;

GRANT SELECT, INSERT, UPDATE
    ON TABLE public.project_milestones
    TO authenticated;

CREATE POLICY "Active members can view project workflow templates"
ON public.project_workflow_templates
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Admin members can insert project workflow templates"
ON public.project_workflow_templates
FOR INSERT TO authenticated
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Admin members can update project workflow templates"
ON public.project_workflow_templates
FOR UPDATE TO authenticated
USING (app_private.is_admin_member())
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Active members can view project workflow phases"
ON public.project_workflow_phases
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Admin members can insert project workflow phases"
ON public.project_workflow_phases
FOR INSERT TO authenticated
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Admin members can update project workflow phases"
ON public.project_workflow_phases
FOR UPDATE TO authenticated
USING (app_private.is_admin_member())
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Active members can view project workflow types"
ON public.project_workflow_types
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Admin members can insert project workflow types"
ON public.project_workflow_types
FOR INSERT TO authenticated
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Admin members can update project workflow types"
ON public.project_workflow_types
FOR UPDATE TO authenticated
USING (app_private.is_admin_member())
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Active members can view project workflow template steps"
ON public.project_workflow_template_steps
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Admin members can insert project workflow template steps"
ON public.project_workflow_template_steps
FOR INSERT TO authenticated
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Admin members can update project workflow template steps"
ON public.project_workflow_template_steps
FOR UPDATE TO authenticated
USING (app_private.is_admin_member())
WITH CHECK (app_private.is_admin_member());

CREATE POLICY "Active members can view project workflow instances"
ON public.project_workflow_instances
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Active members can view project milestones"
ON public.project_milestones
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Editor members can insert project custom milestones"
ON public.project_milestones
FOR INSERT TO authenticated
WITH CHECK (
    app_private.is_editor_member()
    AND origin = 'PROJECT_CUSTOM'
    AND deleted_at IS NULL
);

CREATE POLICY "Editor members can update project milestones"
ON public.project_milestones
FOR UPDATE TO authenticated
USING (app_private.is_editor_member())
WITH CHECK (app_private.is_editor_member());

-- Intentionally no DELETE grants or policies. Soft deletion is modeled by
-- deleted_at, and is_applicable is independent of status and date fields.

CREATE FUNCTION public.snapshot_project_workflow(
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

    -- Lock the project so concurrent snapshot calls for the same project are
    -- serialized before checking historical workflow instances.
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
        RETURN QUERY
        SELECT 'already_initialized'::text, v_existing_instance_id, 0;
        RETURN;
    END IF;

    IF p_template_id IS NULL THEN
        SELECT count(*)::integer
        INTO v_default_count
        FROM public.project_workflow_templates AS template
        WHERE template.is_active = true
          AND template.is_default = true;

        IF v_default_count = 0 THEN
            RAISE EXCEPTION 'No active default project workflow template exists'
                USING ERRCODE = 'no_data_found';
        ELSIF v_default_count > 1 THEN
            RAISE EXCEPTION 'Multiple active default project workflow templates exist'
                USING ERRCODE = 'cardinality_violation';
        END IF;

        SELECT template.*
        INTO v_template
        FROM public.project_workflow_templates AS template
        WHERE template.is_active = true
          AND template.is_default = true;
    ELSE
        SELECT template.*
        INTO v_template
        FROM public.project_workflow_templates AS template
        WHERE template.id = p_template_id
          AND template.is_active = true;

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
        project_id,
        source_template_id,
        template_key_snapshot,
        template_name_snapshot
    )
    VALUES (
        p_project_id,
        v_template.id,
        v_template.template_key,
        v_template.name
    )
    RETURNING id INTO v_instance_id;

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
        status
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
        'NOT_STARTED'
    FROM public.project_workflow_template_steps AS step
    JOIN public.project_workflow_phases AS phase ON phase.id = step.phase_id
    JOIN public.project_workflow_types AS workflow_type ON workflow_type.id = step.type_id
    WHERE step.template_id = v_template.id
      AND step.is_active = true
    ORDER BY step.sort_order, step.id;

    GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

    RETURN QUERY
    SELECT 'created'::text, v_instance_id, v_inserted_count;
END;
$$;

ALTER FUNCTION public.snapshot_project_workflow(uuid, uuid) OWNER TO postgres;

REVOKE EXECUTE
    ON FUNCTION public.snapshot_project_workflow(uuid, uuid)
    FROM PUBLIC, anon;

GRANT EXECUTE
    ON FUNCTION public.snapshot_project_workflow(uuid, uuid)
    TO authenticated;

COMMENT ON FUNCTION public.snapshot_project_workflow(uuid, uuid) IS
    'Atomically creates one workflow instance and snapshots active template steps. Returns already_initialized when any historical instance exists.';
