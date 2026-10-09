-- One project form submission updates its project row and any construction
-- progress rows in one transaction. Existing progress rows are updated in
-- place so their IDs, histories, and shared order positions are preserved.
CREATE FUNCTION public.save_project_with_progress(
  p_project_id uuid, p_create boolean, p_project jsonb, p_progress jsonb)
RETURNS public.projects
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_op jsonb;
  v_values jsonb;
  v_rows integer;
  v_work_type text;
  v_contractor_id uuid;
  v_contractor_name text;
BEGIN
  IF NOT app_private.is_editor_member() THEN
    RAISE EXCEPTION 'Editor required' USING ERRCODE='42501';
  END IF;
  IF p_create IS NULL OR jsonb_typeof(p_project) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_progress) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid project payload' USING ERRCODE='22023';
  END IF;
  IF p_create THEN
    IF p_project_id IS NOT NULL THEN
      RAISE EXCEPTION 'New project must not provide an ID' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.projects (
      project_code,project_name,project_short_name,capacity_kw,address,region,
      responsible_member_name,status,stage,meter_date,notes,completed_at)
    VALUES (
      p_project->>'project_code',coalesce(p_project->>'project_name','未命名案場'),
      p_project->>'project_short_name',p_project->>'capacity_kw',
      p_project->>'address',p_project->>'region',p_project->>'responsible_member_name',
      coalesce(p_project->>'status','開案'),p_project->>'stage',
      p_project->>'meter_date',p_project->>'notes',
      (p_project->>'completed_at')::timestamptz)
    RETURNING * INTO v_project;
  ELSE
    IF p_project_id IS NULL THEN
      RAISE EXCEPTION 'Project ID required' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_project FROM public.projects WHERE id=p_project_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project not found' USING ERRCODE='P0002'; END IF;
    UPDATE public.projects project_row SET
      project_code=CASE WHEN p_project ? 'project_code' THEN p_project->>'project_code' ELSE project_row.project_code END,
      project_name=CASE WHEN p_project ? 'project_name' THEN p_project->>'project_name' ELSE project_row.project_name END,
      project_short_name=CASE WHEN p_project ? 'project_short_name' THEN p_project->>'project_short_name' ELSE project_row.project_short_name END,
      capacity_kw=CASE WHEN p_project ? 'capacity_kw' THEN p_project->>'capacity_kw' ELSE project_row.capacity_kw END,
      address=CASE WHEN p_project ? 'address' THEN p_project->>'address' ELSE project_row.address END,
      region=CASE WHEN p_project ? 'region' THEN p_project->>'region' ELSE project_row.region END,
      responsible_member_name=CASE WHEN p_project ? 'responsible_member_name' THEN p_project->>'responsible_member_name' ELSE project_row.responsible_member_name END,
      status=CASE WHEN p_project ? 'status' THEN p_project->>'status' ELSE project_row.status END,
      stage=CASE WHEN p_project ? 'stage' THEN p_project->>'stage' ELSE project_row.stage END,
      meter_date=CASE WHEN p_project ? 'meter_date' THEN p_project->>'meter_date' ELSE project_row.meter_date END,
      notes=CASE WHEN p_project ? 'notes' THEN p_project->>'notes' ELSE project_row.notes END,
      completed_at=CASE WHEN p_project ? 'completed_at' THEN (p_project->>'completed_at')::timestamptz ELSE project_row.completed_at END,
      updated_at=now()
    WHERE project_row.id=p_project_id RETURNING * INTO v_project;
  END IF;

  FOR v_op IN SELECT value FROM jsonb_array_elements(p_progress) LOOP
    IF jsonb_typeof(v_op) IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_op->'values') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid progress operation' USING ERRCODE='22023';
    END IF;
    v_values := v_op->'values';
    v_work_type := v_op->>'work_type';
    IF v_work_type NOT IN ('racking','electrical','steel','roof_cover','civil','other') THEN
      RAISE EXCEPTION 'Invalid construction type' USING ERRCODE='22023';
    END IF;
    IF (v_values->>'actual_completed_date')::date > (now() AT TIME ZONE 'Asia/Taipei')::date THEN
      RAISE EXCEPTION 'Actual completion cannot be in the future' USING ERRCODE='23514';
    END IF;
    v_contractor_id := (v_values->>'contractor_id')::uuid;
    IF v_values ? 'contractor_id' THEN
      SELECT name INTO v_contractor_name FROM public.contractors WHERE id=v_contractor_id;
    END IF;
    IF v_op->>'kind'='update' THEN
      IF v_op->>'id' IS NULL THEN
        RAISE EXCEPTION 'Progress ID required' USING ERRCODE='22023';
      END IF;
      UPDATE public.project_construction_progress progress SET
        contractor_id=CASE WHEN v_values ? 'contractor_id' THEN v_contractor_id ELSE progress.contractor_id END,
        contractor_name=CASE WHEN v_values ? 'contractor_id' THEN v_contractor_name ELSE progress.contractor_name END,
        planned_start_date=CASE WHEN v_values ? 'planned_start_date' THEN v_values->>'planned_start_date' ELSE progress.planned_start_date END,
        planned_end_date=CASE WHEN v_values ? 'planned_end_date' THEN v_values->>'planned_end_date' ELSE progress.planned_end_date END,
        actual_completed_date=CASE WHEN v_values ? 'actual_completed_date' THEN v_values->>'actual_completed_date' ELSE progress.actual_completed_date END,
        is_completed=CASE WHEN v_values ? 'is_completed' THEN (v_values->>'is_completed')::boolean ELSE progress.is_completed END,
        status_override=CASE WHEN v_values ? 'status_override' THEN v_values->>'status_override' ELSE progress.status_override END,
        notes=CASE WHEN v_values ? 'notes' THEN v_values->>'notes' ELSE progress.notes END,
        updated_at=now()
      WHERE progress.id=(v_op->>'id')::uuid AND progress.project_id=v_project.id
        AND progress.work_type=v_work_type AND progress.deleted_at IS NULL;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'Progress changed; reload before saving' USING ERRCODE='40001';
      END IF;
    ELSIF v_op->>'kind'='create' THEN
      IF v_work_type='other' OR v_op ? 'id' THEN
        RAISE EXCEPTION 'Invalid new progress row' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.project_construction_progress (
        project_id,work_type,sort_order,contractor_id,contractor_name,
        planned_start_date,planned_end_date,actual_completed_date,is_completed,
        status_override,notes)
      VALUES (
        v_project.id,v_work_type,coalesce((v_op->>'sort_order')::integer,0),
        v_contractor_id,v_contractor_name,v_values->>'planned_start_date',
        v_values->>'planned_end_date',v_values->>'actual_completed_date',
        coalesce((v_values->>'is_completed')::boolean,false),v_values->>'status_override',
        v_values->>'notes');
    ELSE
      RAISE EXCEPTION 'Invalid progress operation kind' USING ERRCODE='22023';
    END IF;
  END LOOP;
  RETURN v_project;
END $$;
REVOKE ALL ON FUNCTION public.save_project_with_progress(uuid,boolean,jsonb,jsonb)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_project_with_progress(uuid,boolean,jsonb,jsonb)
  TO authenticated;

NOTIFY pgrst,'reload schema';
