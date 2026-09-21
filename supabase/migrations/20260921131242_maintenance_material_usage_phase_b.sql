-- Phase B composes the released canonical writer; it never duplicates stock logic.
ALTER TABLE public.inventory_transactions
  ADD COLUMN schedule_task_id uuid REFERENCES public.schedule_tasks(id) ON DELETE RESTRICT;
CREATE INDEX inventory_transactions_schedule_task_idx
  ON public.inventory_transactions(schedule_task_id) WHERE schedule_task_id IS NOT NULL;
CREATE UNIQUE INDEX inventory_transactions_schedule_item_out_key
  ON public.inventory_transactions(schedule_task_id,item_id)
  WHERE schedule_task_id IS NOT NULL AND transaction_type='OUT'
    AND is_voided IS NOT TRUE AND excluded_by_initialization_id IS NULL;

CREATE FUNCTION public.complete_maintenance_with_inventory_usage(
  p_schedule_task_id uuid, p_materials jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor public.team_members := app_private.inventory_actor();
  task public.schedule_tasks;
  project public.projects;
  material jsonb;
  tx jsonb;
  transactions jsonb := '[]'::jsonb;
  before_snapshot jsonb;
  after_snapshot jsonb;
  completed_at timestamptz := clock_timestamp();
  execution_exists boolean;
BEGIN
  SELECT * INTO task FROM public.schedule_tasks WHERE id=p_schedule_task_id FOR UPDATE;
  IF NOT FOUND OR task.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Schedule not found' USING ERRCODE='P0002';
  END IF;
  IF btrim(replace(task.task_type,chr(12288),' ')) IS DISTINCT FROM '維修' THEN
    RAISE EXCEPTION 'Only maintenance schedules may use materials' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_materials) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Materials array required' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.item_id),'[]'::jsonb) INTO transactions
    FROM public.inventory_transactions t WHERE t.schedule_task_id=task.id
      AND t.transaction_type='OUT' AND t.is_voided IS NOT TRUE AND t.excluded_by_initialization_id IS NULL;
  -- The existing audit records empty-material executions too; no second ledger.
  SELECT EXISTS(SELECT 1 FROM public.activity_logs l
    WHERE l.target_type='ScheduleTask' AND l.target_id=task.id::text
      AND l.action_type='COMPLETE_TASK' AND l.changes->>'execution'='maintenance_material_usage_phase_b')
    INTO execution_exists;
  IF task.status IN ('完成','已完成') THEN
    IF jsonb_array_length(transactions)>0 OR execution_exists THEN
      RETURN jsonb_build_object('schedule_task_id',task.id,'status',task.status,'transactions',transactions,'already_completed',true);
    END IF;
    RAISE EXCEPTION 'MAINTENANCE_CONFLICT: 排程已完成且無本次執行紀錄，請重新載入。' USING ERRCODE='PT409';
  END IF;
  IF jsonb_array_length(transactions)>0 OR execution_exists THEN
    RAISE EXCEPTION 'MAINTENANCE_CONFLICT: 排程已有物料使用紀錄，請重新載入。' USING ERRCODE='PT409';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_materials) m
    WHERE jsonb_typeof(m) IS DISTINCT FROM 'object' OR NULLIF(m->>'item_id','') IS NULL)
    OR (SELECT count(DISTINCT (m->>'item_id')::uuid) FROM jsonb_array_elements(p_materials) m)<>jsonb_array_length(p_materials) THEN
    RAISE EXCEPTION 'Each material must have a unique item' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_materials)>0 THEN
    -- schedule_tasks.project_id is text in the released schema. Resolve the
    -- actual project row, instead of trusting a name or casting arbitrary text.
    SELECT * INTO project FROM public.projects p WHERE p.id::text=task.project_id AND p.deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION '使用物料需指定案場' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public.inventory_items i
      WHERE i.id IN (SELECT (m->>'item_id')::uuid FROM jsonb_array_elements(p_materials) m)
      ORDER BY i.id FOR UPDATE;
  END IF;
  before_snapshot := jsonb_build_object('status',task.status);
  FOR material IN SELECT m FROM jsonb_array_elements(p_materials) m ORDER BY (m->>'item_id')::uuid LOOP
    tx := public.write_inventory_transaction_atomic('CREATE',jsonb_build_object(
      'item_id',material->>'item_id','transaction_type','OUT','quantity',material->'quantity',
      'transaction_date',(completed_at AT TIME ZONE 'Asia/Taipei')::date,
      'project_id',project.id,'source','維修使用物料','notes','維修：'||task.title
    ),COALESCE(material->'serials','[]'::jsonb));
    UPDATE public.inventory_transactions t SET schedule_task_id=task.id
      WHERE t.id=(tx->>'id')::uuid RETURNING to_jsonb(t) INTO tx;
    PERFORM app_private.inventory_audit('LINK_MAINTENANCE_USAGE',NULL,
      tx||jsonb_build_object('serials',app_private.inventory_transaction_serial_snapshot((tx->>'id')::uuid)), '維修使用物料');
    transactions := transactions||jsonb_build_array(tx);
  END LOOP;
  -- Last business mutation: any exception, including audit failure, rolls back
  -- every canonical OUT, link, serial state/project, and this completion.
  UPDATE public.schedule_tasks SET status='完成',updated_at=completed_at WHERE id=task.id;
  after_snapshot := jsonb_build_object('status','完成');
  INSERT INTO public.activity_logs(action,target_type,target_id,description,changes,user_id,user_name,
    actor_user_id,actor_name,action_type,target_label,project_id,project_name,before_value,after_value,message)
  VALUES('COMPLETE_TASK','ScheduleTask',task.id::text,'完成維修',
    jsonb_build_object('execution','maintenance_material_usage_phase_b','before',before_snapshot,'after',after_snapshot,
      'completed_at',completed_at,'transactions',transactions),actor.id::text,actor.name,
    actor.id::text,actor.name,'COMPLETE_TASK',task.title,task.project_id,COALESCE(project.project_name,task.project_name),
    before_snapshot::text,after_snapshot::text,'完成維修');
  RETURN jsonb_build_object('schedule_task_id',task.id,'status','完成','transactions',transactions,'already_completed',false);
END $$;
REVOKE ALL ON FUNCTION public.complete_maintenance_with_inventory_usage(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_maintenance_with_inventory_usage(uuid,jsonb) TO authenticated;
COMMENT ON COLUMN public.inventory_transactions.schedule_task_id IS 'Maintenance usage origin; ledger history prevents hard deletion of its schedule.';
NOTIFY pgrst,'reload schema';
