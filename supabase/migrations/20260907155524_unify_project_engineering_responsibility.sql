-- Keep the member FK used by project responsibilities and the legacy engineer
-- name snapshot in one atomic operation. The name remains available to older
-- schedule and weekly-report consumers while the assignment is canonical for
-- position-based features.
CREATE OR REPLACE FUNCTION public.set_project_position_assignment(
    p_project_id uuid,
    p_position_id uuid,
    p_member_id uuid DEFAULT NULL
)
RETURNS TABLE (
    assignment_id uuid,
    assigned_member_id uuid,
    assignment_created_at timestamptz,
    assignment_updated_at timestamptz,
    compatibility_member_name text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
    v_position_name text;
    v_member_name text;
    v_compatibility_member_name text;
    v_assignment public.project_position_assignments%ROWTYPE;
BEGIN
    SELECT project.responsible_member_name
    INTO v_compatibility_member_name
    FROM public.projects AS project
    WHERE project.id = p_project_id
      AND project.deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project % does not exist or is not accessible', p_project_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT position.name
    INTO v_position_name
    FROM public.positions AS position
    WHERE position.id = p_position_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position % does not exist or is not accessible', p_position_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF p_member_id IS NULL THEN
        DELETE FROM public.project_position_assignments AS assignment
        WHERE assignment.project_id = p_project_id
          AND assignment.position_id = p_position_id;

        IF btrim(v_position_name) = '工程' THEN
            UPDATE public.projects AS project
            SET responsible_member_name = NULL
            WHERE project.id = p_project_id;
            v_compatibility_member_name := NULL;
        END IF;

        RETURN QUERY SELECT
            NULL::uuid,
            NULL::uuid,
            NULL::timestamptz,
            NULL::timestamptz,
            v_compatibility_member_name;
        RETURN;
    END IF;

    SELECT member.name
    INTO v_member_name
    FROM public.team_members AS member
    JOIN public.member_positions AS member_position
      ON member_position.member_id = member.id
     AND member_position.position_id = p_position_id
    WHERE member.id = p_member_id
      AND member.is_active = true
      AND member.deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project assignee must be an active member with the selected position'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.project_position_assignments AS assignment (
        project_id,
        position_id,
        member_id
    ) VALUES (
        p_project_id,
        p_position_id,
        p_member_id
    )
    ON CONFLICT (project_id, position_id)
    DO UPDATE SET member_id = EXCLUDED.member_id
    RETURNING assignment.* INTO v_assignment;

    IF btrim(v_position_name) = '工程' THEN
        UPDATE public.projects AS project
        SET responsible_member_name = v_member_name
        WHERE project.id = p_project_id;
        v_compatibility_member_name := v_member_name;
    END IF;

    RETURN QUERY SELECT
        v_assignment.id,
        v_assignment.member_id,
        v_assignment.created_at,
        v_assignment.updated_at,
        v_compatibility_member_name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_project_position_assignment(uuid, uuid, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_project_position_assignment(uuid, uuid, uuid)
    TO authenticated;

-- Exact template-step identity makes concurrent and repeated refreshes safe.
CREATE UNIQUE INDEX project_milestones_active_template_step_idx
    ON public.project_milestones (workflow_instance_id, source_template_step_id)
    WHERE origin = 'TEMPLATE'
      AND deleted_at IS NULL;

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

    SELECT instance.*
    INTO v_instance
    FROM public.project_workflow_instances AS instance
    WHERE instance.project_id = p_project_id
      AND instance.deleted_at IS NULL
    FOR UPDATE;

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

REVOKE EXECUTE ON FUNCTION public.refresh_project_workflow(uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_project_workflow(uuid)
    TO authenticated;

-- Align only legacy engineer names that resolve to exactly one active member
-- who already holds the Engineering position. No fuzzy matching is allowed.
WITH engineering_position AS (
    SELECT position.id
    FROM public.positions AS position
    WHERE position.is_active = true
      AND lower(btrim(position.name)) = lower('工程')
), unique_active_member AS (
    SELECT
        member.name,
        (array_agg(member.id ORDER BY member.id))[1] AS member_id
    FROM public.team_members AS member
    WHERE member.is_active = true
      AND member.deleted_at IS NULL
    GROUP BY member.name
    HAVING count(*) = 1
), alignable AS (
    SELECT
        project.id AS project_id,
        engineering_position.id AS position_id,
        unique_active_member.member_id
    FROM public.projects AS project
    JOIN unique_active_member
      ON unique_active_member.name = project.responsible_member_name
    CROSS JOIN engineering_position
    JOIN public.member_positions AS member_position
      ON member_position.member_id = unique_active_member.member_id
     AND member_position.position_id = engineering_position.id
    WHERE project.deleted_at IS NULL
      AND nullif(btrim(project.responsible_member_name), '') IS NOT NULL
)
INSERT INTO public.project_position_assignments AS assignment (
    project_id,
    position_id,
    member_id
)
SELECT
    alignable.project_id,
    alignable.position_id,
    alignable.member_id
FROM alignable
ON CONFLICT (project_id, position_id)
DO UPDATE SET member_id = EXCLUDED.member_id
WHERE assignment.member_id IS DISTINCT FROM EXCLUDED.member_id;
