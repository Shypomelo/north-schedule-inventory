-- ADMIN refresh needs to insert TEMPLATE milestones, while editor-created
-- PROJECT_CUSTOM milestones keep their existing policy unchanged.
CREATE POLICY "Admin members can insert project template milestones"
ON public.project_milestones
FOR INSERT TO authenticated
WITH CHECK (
    app_private.is_admin_member()
    AND origin = 'TEMPLATE'
    AND deleted_at IS NULL
);

-- SELECT ... FOR UPDATE requires an UPDATE table/column privilege before RLS
-- is evaluated. Granting that privilege to the shared `authenticated` role
-- would also let every active member lock workflow-instance rows. Serialize
-- ADMIN refreshes with a transaction-scoped advisory lock instead, so the
-- function remains SECURITY INVOKER and no table privilege is widened.
CREATE OR REPLACE FUNCTION public.refresh_project_workflow(p_project_id uuid)
RETURNS TABLE (
    result text,
    refreshed_workflow_instance_id uuid,
    milestones_created integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog'
AS $$
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
$$;
