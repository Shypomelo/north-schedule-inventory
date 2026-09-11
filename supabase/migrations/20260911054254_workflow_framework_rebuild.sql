-- Candidate only. No existing business dates/status/notes or custom ordering changed.
ALTER TABLE public.project_milestones ADD COLUMN archived_at timestamptz,
 ADD COLUMN phase_sort_order_snapshot integer;
UPDATE public.project_milestones m SET phase_sort_order_snapshot=p.sort_order
FROM public.project_workflow_phases p WHERE p.id=m.source_phase_id;

CREATE OR REPLACE FUNCTION app_private.validate_project_milestone_contract()
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
                IF NOT coalesce(app_private.is_admin_member(),false) OR NOT EXISTS (
                    SELECT 1 FROM public.project_workflow_template_steps s
                    JOIN public.project_workflow_phases p ON p.id=s.phase_id
                    JOIN public.project_workflow_types t ON t.id=s.type_id
                    WHERE s.id=OLD.source_template_step_id AND s.template_id=v_instance_template_id
                    AND s.is_active AND p.is_active AND t.is_active
                    AND NEW.source_phase_id=p.id AND NEW.phase_key_snapshot=p.phase_key
                    AND NEW.phase_name_snapshot=p.name AND NEW.source_type_id=t.id
                    AND NEW.type_key_snapshot=t.type_key AND NEW.type_name_snapshot=t.name
                ) THEN
                    RAISE EXCEPTION 'Template framework changes require admin and exact canonical step'
                        USING ERRCODE = 'check_violation';
                END IF;
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

CREATE FUNCTION app_private.guard_workflow_framework_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'New milestones cannot start archived' USING ERRCODE='23514'; END IF;
  SELECT sort_order INTO NEW.phase_sort_order_snapshot FROM public.project_workflow_phases WHERE id=NEW.source_phase_id;
 ELSIF NEW.archived_at IS DISTINCT FROM OLD.archived_at
 OR (NEW.origin='TEMPLATE' AND (NEW.label IS DISTINCT FROM OLD.label OR NEW.responsible_position_id IS DISTINCT FROM OLD.responsible_position_id OR NEW.phase_sort_order_snapshot IS DISTINCT FROM OLD.phase_sort_order_snapshot)) THEN
  IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin may update framework metadata' USING ERRCODE='42501'; END IF;
  IF NEW.origin='PROJECT_CUSTOM' THEN RAISE EXCEPTION 'Custom milestones cannot be archived by template rebuild' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_workflow_framework_metadata() FROM PUBLIC;
CREATE TRIGGER zz_workflow_framework_metadata BEFORE INSERT OR UPDATE ON public.project_milestones
FOR EACH ROW EXECUTE FUNCTION app_private.guard_workflow_framework_metadata();

CREATE FUNCTION public.preview_project_workflow_rebuild(p_project_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE instance public.project_workflow_instances%ROWTYPE; result jsonb;
BEGIN
 IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin may preview workflow rebuild' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT instance FROM public.project_workflow_instances WHERE project_id=p_project_id AND deleted_at IS NULL;
 WITH steps AS (
  SELECT s.*,p.phase_key,p.name phase_name,p.sort_order phase_order,t.type_key,t.name type_name
  FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id
  JOIN public.project_workflow_types t ON t.id=s.type_id
  WHERE s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active
 ), milestones AS (SELECT * FROM public.project_milestones WHERE workflow_instance_id=instance.id AND deleted_at IS NULL)
 SELECT jsonb_build_object(
  'matched',(SELECT count(*) FROM milestones m JOIN steps s ON s.id=m.source_template_step_id WHERE m.origin='TEMPLATE'),
  'added',(SELECT count(*) FROM steps s WHERE NOT EXISTS(SELECT 1 FROM milestones m WHERE m.source_template_step_id=s.id AND m.origin='TEMPLATE')),
  'archived',(SELECT count(*) FROM milestones m WHERE m.origin='TEMPLATE' AND m.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM steps s WHERE s.id=m.source_template_step_id)),
  'custom',(SELECT count(*) FROM milestones WHERE origin='PROJECT_CUSTOM'),
  'token',md5(instance.id::text||coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)::text FROM steps s),'[]')||coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id)::text FROM milestones m),'[]'))
 ) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.preview_project_workflow_rebuild(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_project_workflow_rebuild(uuid) TO authenticated;

CREATE FUNCTION public.rebuild_project_workflow(p_project_id uuid,p_preview_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE instance public.project_workflow_instances%ROWTYPE; preview jsonb;
BEGIN
 IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin may rebuild workflow' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.refresh_project_workflow:'||p_project_id::text,0));
 -- Keep template metadata and project progress stable between preview validation and writes.
 LOCK TABLE public.project_workflow_template_steps,public.project_workflow_phases,public.project_workflow_types IN SHARE MODE;
 SELECT * INTO STRICT instance FROM public.project_workflow_instances WHERE project_id=p_project_id AND deleted_at IS NULL;
 PERFORM id FROM public.project_milestones WHERE workflow_instance_id=instance.id FOR UPDATE;
 preview:=public.preview_project_workflow_rebuild(p_project_id);
 IF p_preview_token IS NULL OR p_preview_token IS DISTINCT FROM preview->>'token' THEN RAISE EXCEPTION 'Workflow changed; preview again before rebuilding' USING ERRCODE='40001'; END IF;
 UPDATE public.project_milestones m SET label=s.label,source_phase_id=p.id,phase_key_snapshot=p.phase_key,
  phase_name_snapshot=p.name,phase_sort_order_snapshot=p.sort_order,source_type_id=t.id,type_key_snapshot=t.type_key,
  type_name_snapshot=t.name,responsible_position_id=s.responsible_position_id,sort_order=s.sort_order,archived_at=NULL
 FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id
 JOIN public.project_workflow_types t ON t.id=s.type_id
 WHERE m.workflow_instance_id=instance.id AND m.origin='TEMPLATE' AND m.deleted_at IS NULL
 AND s.id=m.source_template_step_id AND s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active
 AND ROW(m.label,m.source_phase_id,m.phase_key_snapshot,m.phase_name_snapshot,m.phase_sort_order_snapshot,m.source_type_id,m.type_key_snapshot,m.type_name_snapshot,m.responsible_position_id,m.sort_order,m.archived_at)
 IS DISTINCT FROM ROW(s.label,p.id,p.phase_key,p.name,p.sort_order,t.id,t.type_key,t.name,s.responsible_position_id,s.sort_order,NULL::timestamptz);
 UPDATE public.project_milestones m SET archived_at=now()
 WHERE m.workflow_instance_id=instance.id AND m.origin='TEMPLATE' AND m.deleted_at IS NULL AND m.archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id JOIN public.project_workflow_types t ON t.id=s.type_id WHERE s.id=m.source_template_step_id AND s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active);
 INSERT INTO public.project_milestones(workflow_instance_id,project_id,origin,source_template_step_id,milestone_key,label,source_phase_id,phase_key_snapshot,phase_name_snapshot,phase_sort_order_snapshot,source_type_id,type_key_snapshot,type_name_snapshot,sort_order,is_applicable,status,responsible_position_id)
 SELECT instance.id,p_project_id,'TEMPLATE',s.id,s.step_key,s.label,p.id,p.phase_key,p.name,p.sort_order,t.id,t.type_key,t.name,s.sort_order,s.default_is_applicable,'NOT_STARTED',s.responsible_position_id
 FROM public.project_workflow_template_steps s JOIN public.project_workflow_phases p ON p.id=s.phase_id JOIN public.project_workflow_types t ON t.id=s.type_id
 WHERE s.template_id=instance.source_template_id AND s.is_active AND p.is_active AND t.is_active
 ON CONFLICT(workflow_instance_id,source_template_step_id) WHERE origin='TEMPLATE' AND deleted_at IS NULL DO NOTHING;
 RETURN preview;
END $$;
REVOKE ALL ON FUNCTION public.rebuild_project_workflow(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rebuild_project_workflow(uuid,text) TO authenticated;
NOTIFY pgrst,'reload schema';
