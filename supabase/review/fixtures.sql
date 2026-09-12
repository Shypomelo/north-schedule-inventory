-- Deterministic Candidate review fixtures. Candidate-only; keep out of supabase/migrations.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM review_private.environment_guard
    WHERE singleton AND project_ref = 'fssogssryeunkjkdgewx' AND purpose = 'CANDIDATE_REVIEW'
  ) THEN
    RAISE EXCEPTION 'candidate review guard failed';
  END IF;
END
$guard$;

DO $fixture$
DECLARE
  v_owner uuid;
  v_owner_name text;
  v_assistant constant uuid := 'c0000000-0000-4000-8000-000000000001';
  v_group uuid;
  v_position uuid;
  v_engineering_position uuid;
  v_zone_t uuid;
  v_zone_a uuid;
  v_zone_q uuid;
  v_batch uuid;
BEGIN
  SELECT wz.owner_member_id INTO v_owner
  FROM public.work_zones wz
  WHERE wz.is_active AND wz.name IN ('T','A','Q')
  GROUP BY wz.owner_member_id
  HAVING count(DISTINCT wz.name) = 3
  ORDER BY wz.owner_member_id
  LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'fixture requires an entitled Candidate member with active T/A/Q work zones';
  END IF;

  SELECT name INTO v_owner_name FROM public.team_members WHERE id = v_owner AND is_active AND deleted_at IS NULL;
  IF v_owner_name IS NULL THEN
    RAISE EXCEPTION 'fixture owner must be an active Candidate member';
  END IF;

  SELECT id INTO v_zone_t FROM public.work_zones WHERE owner_member_id=v_owner AND name='T' AND is_active ORDER BY sort_order,id LIMIT 1;
  SELECT id INTO v_zone_a FROM public.work_zones WHERE owner_member_id=v_owner AND name='A' AND is_active ORDER BY sort_order,id LIMIT 1;
  SELECT id INTO v_zone_q FROM public.work_zones WHERE owner_member_id=v_owner AND name='Q' AND is_active ORDER BY sort_order,id LIMIT 1;

  INSERT INTO public.team_members(id,name,email,role,category,is_active,notes)
  VALUES (v_assistant,'CANDIDATE_協作測試員','candidate-review-assistant@example.invalid','EDITOR','engineering',true,'REVIEW_FIXTURE')
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,category=excluded.category,is_active=true,deleted_at=NULL,notes=excluded.notes;

  SELECT id INTO v_group FROM public.work_groups WHERE key='ENGINEERING' LIMIT 1;
  IF v_group IS NULL THEN
    v_group := 'c0000000-0000-4000-8000-000000000010';
    INSERT INTO public.work_groups(id,key,name,sort_order,is_active,google_calendar_sync_enabled)
    VALUES(v_group,'ENGINEERING','工程',10,true,false)
    ON CONFLICT (key) DO UPDATE SET is_active=true,google_calendar_sync_enabled=false
    RETURNING id INTO v_group;
  END IF;

  SELECT id INTO v_position FROM public.positions WHERE name='REVIEW_工程負責' AND is_active ORDER BY id LIMIT 1;
  IF v_position IS NULL THEN
    v_position := 'c0000000-0000-4000-8000-000000000020';
    INSERT INTO public.positions(id,name,sort_order,is_active)
    VALUES(v_position,'REVIEW_工程負責',900,true)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,is_active=true;
  END IF;

  SELECT id INTO v_engineering_position FROM public.positions WHERE name='工程' AND is_active ORDER BY id LIMIT 1;
  IF v_engineering_position IS NULL THEN
    v_engineering_position := 'c0000000-0000-4000-8000-000000000021';
    INSERT INTO public.positions(id,name,sort_order,is_active)
    VALUES(v_engineering_position,'工程',10,true)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,is_active=true;
  END IF;

  INSERT INTO public.member_work_groups(member_id,work_group_id,is_default)
  VALUES (v_owner,v_group,true),(v_assistant,v_group,false)
  ON CONFLICT (member_id,work_group_id) DO UPDATE SET is_default=excluded.is_default,updated_at=now();

  INSERT INTO public.member_positions(member_id,position_id)
  VALUES(v_owner,v_position),(v_assistant,v_position),(v_owner,v_engineering_position),(v_assistant,v_engineering_position)
  ON CONFLICT (member_id,position_id) DO NOTHING;

  INSERT INTO public.contractors(id,name,contractor_type,contact_person,phone,notes,is_active,work_capabilities)
  VALUES
   ('c0000000-0000-4000-8000-000000000200','REVIEW_支架承包商','racking','REVIEW_聯絡人','0900-000-200','REVIEW_FIXTURE',true,ARRAY['racking','steel']::text[]),
   ('c0000000-0000-4000-8000-000000000201','REVIEW_電力承包商','electrical','REVIEW_聯絡人','0900-000-201','REVIEW_FIXTURE',true,ARRAY['electrical']::text[])
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,contractor_type=excluded.contractor_type,contact_person=excluded.contact_person,phone=excluded.phone,notes=excluded.notes,is_active=true,deleted_at=NULL,work_capabilities=excluded.work_capabilities;

  INSERT INTO public.projects(id,project_code,project_name,project_short_name,capacity_kw,address,region,responsible_member_name,status,stage,meter_date,notes,deleted_at,completed_at)
  VALUES
   ('c0000000-0000-4000-8000-000000000100','REVIEW_P001','REVIEW_北區進行中一號','R-P001','99.9','台北市測試路1號','北區',v_owner_name,'進行中','工程中',NULL,'REVIEW_FIXTURE overdue construction',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000101','REVIEW_P002','REVIEW_北區進行中二號','R-P002','199.8','新北市測試路2號','北區',v_owner_name,'進行中','工程中',NULL,'REVIEW_FIXTURE overdue construction',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000102','REVIEW_P003','REVIEW_北區進行中三號','R-P003','299.7','桃園市測試路3號','北區',v_owner_name,'進行中','工程中',NULL,'REVIEW_FIXTURE overdue construction',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000103','REVIEW_P004','REVIEW_兩週內進場一號','R-P004','88.8','新竹市測試路4號','北區',v_owner_name,'進行中','準備進場',NULL,'REVIEW_FIXTURE next 14 days',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000104','REVIEW_P005','REVIEW_兩週內進場二號','R-P005','77.7','苗栗縣測試路5號','北區',v_owner_name,'進行中','準備進場',NULL,'REVIEW_FIXTURE next 14 days',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000105','REVIEW_P006','REVIEW_其他負責一號','R-P006','66.6','台中市測試路6號','中區',v_owner_name,'進行中','待排程',NULL,'REVIEW_FIXTURE no construction date',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000106','REVIEW_P007','REVIEW_其他負責二號','R-P007','55.5','彰化縣測試路7號','中區',v_owner_name,'進行中','待排程',(CURRENT_DATE-1)::text,'REVIEW_FIXTURE meter status',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000107','REVIEW_P008','REVIEW_已結案歷史案場','R-P008','44.4','基隆市測試路8號','北區',v_owner_name,'已結案','已結案',(CURRENT_DATE-21)::text,'REVIEW_FIXTURE completed project',NULL,now()-interval '14 day')
  ON CONFLICT (id) DO UPDATE SET project_code=excluded.project_code,project_name=excluded.project_name,project_short_name=excluded.project_short_name,capacity_kw=excluded.capacity_kw,address=excluded.address,region=excluded.region,responsible_member_name=excluded.responsible_member_name,status=excluded.status,stage=excluded.stage,meter_date=excluded.meter_date,notes=excluded.notes,deleted_at=NULL,completed_at=excluded.completed_at,updated_at=now();

  INSERT INTO public.project_position_assignments(id,project_id,position_id,member_id)
  VALUES
   ('c0000000-0000-4000-8000-000000000300','c0000000-0000-4000-8000-000000000100',v_engineering_position,v_owner),
   ('c0000000-0000-4000-8000-000000000301','c0000000-0000-4000-8000-000000000101',v_engineering_position,v_owner),
   ('c0000000-0000-4000-8000-000000000302','c0000000-0000-4000-8000-000000000102',v_engineering_position,v_owner)
  ON CONFLICT (id) DO UPDATE SET project_id=excluded.project_id,position_id=excluded.position_id,member_id=excluded.member_id,updated_at=now();

  INSERT INTO public.project_construction_progress(id,project_id,work_type,work_name,sort_order,contractor_id,contractor_name,planned_start_date,planned_end_date,is_completed,actual_completed_date,status_override,notes,deleted_at)
  VALUES
   ('c0000000-0000-4000-8000-000000000400','c0000000-0000-4000-8000-000000000100','racking',NULL,10,'c0000000-0000-4000-8000-000000000200','REVIEW_支架承包商',(CURRENT_DATE-7)::text,(CURRENT_DATE+2)::text,false,NULL,NULL,'REVIEW_FIXTURE 支架',NULL),
   ('c0000000-0000-4000-8000-000000000401','c0000000-0000-4000-8000-000000000101','electrical',NULL,20,'c0000000-0000-4000-8000-000000000201','REVIEW_電力承包商',(CURRENT_DATE-3)::text,(CURRENT_DATE+5)::text,false,NULL,NULL,'REVIEW_FIXTURE 電力',NULL),
   ('c0000000-0000-4000-8000-000000000402','c0000000-0000-4000-8000-000000000102','racking',NULL,10,'c0000000-0000-4000-8000-000000000200','REVIEW_支架承包商',(CURRENT_DATE-1)::text,(CURRENT_DATE+4)::text,false,NULL,NULL,'REVIEW_FIXTURE 支架',NULL),
   ('c0000000-0000-4000-8000-000000000403','c0000000-0000-4000-8000-000000000103','racking',NULL,10,'c0000000-0000-4000-8000-000000000200','REVIEW_支架承包商',(CURRENT_DATE+3)::text,(CURRENT_DATE+8)::text,false,NULL,NULL,'REVIEW_FIXTURE upcoming',NULL),
   ('c0000000-0000-4000-8000-000000000404','c0000000-0000-4000-8000-000000000104','electrical',NULL,20,'c0000000-0000-4000-8000-000000000201','REVIEW_電力承包商',(CURRENT_DATE+10)::text,(CURRENT_DATE+14)::text,false,NULL,NULL,'REVIEW_FIXTURE upcoming',NULL)
  ON CONFLICT (id) DO UPDATE SET contractor_id=excluded.contractor_id,contractor_name=excluded.contractor_name,planned_start_date=excluded.planned_start_date,planned_end_date=excluded.planned_end_date,is_completed=false,actual_completed_date=NULL,status_override=NULL,notes=excluded.notes,deleted_at=NULL,updated_at=now();

  INSERT INTO public.schedule_tasks(id,title,task_date,start_time,end_time,is_all_day,status,task_type,project_id,project_name,address,notes,work_group_id,primary_member_id,primary_member_name,assistant_member_ids,assistant_member_names,creation_source,google_sync_status)
  VALUES
   ('c0000000-0000-4000-8000-000000000500','REVIEW_今日現勘',CURRENT_DATE,'09:00','10:00',false,'未開始','現勘','c0000000-0000-4000-8000-000000000100','REVIEW_北區進行中一號','台北市測試路1號','REVIEW_FIXTURE',v_group,v_owner::text,v_owner_name,ARRAY[v_assistant::text],ARRAY['CANDIDATE_協作測試員'],'APP','pending'),
   ('c0000000-0000-4000-8000-000000000501','REVIEW_今日工程協作',CURRENT_DATE,'13:30','15:00',false,'進行中','工程','c0000000-0000-4000-8000-000000000101','REVIEW_北區進行中二號','新北市測試路2號','REVIEW_FIXTURE',v_group,v_owner::text,v_owner_name,ARRAY[v_assistant::text],ARRAY['CANDIDATE_協作測試員'],'SYSTEM','pending'),
   ('c0000000-0000-4000-8000-000000000502','REVIEW_今日驗收',CURRENT_DATE,'16:00','17:00',false,'未開始','驗收','c0000000-0000-4000-8000-000000000102','REVIEW_北區進行中三號','桃園市測試路3號','REVIEW_FIXTURE',v_group,v_owner::text,v_owner_name,ARRAY[]::text[],ARRAY[]::text[],'SYSTEM','pending')
  ON CONFLICT (id) DO UPDATE SET title=excluded.title,task_date=excluded.task_date,start_time=excluded.start_time,end_time=excluded.end_time,status=excluded.status,task_type=excluded.task_type,project_id=excluded.project_id,project_name=excluded.project_name,address=excluded.address,notes=excluded.notes,work_group_id=excluded.work_group_id,primary_member_id=excluded.primary_member_id,primary_member_name=excluded.primary_member_name,assistant_member_ids=excluded.assistant_member_ids,assistant_member_names=excluded.assistant_member_names,creation_source=excluded.creation_source,google_sync_status=excluded.google_sync_status,deleted_at=NULL,updated_at=now();

  INSERT INTO public.todos(id,scope,title,content,status,received_at,created_by,assigned_by,assigned_to,work_group_id,project_id,task_type,converted_task_id)
  VALUES
   ('c0000000-0000-4000-8000-000000000510','PRIVATE','REVIEW_待處理私人 Todo','REVIEW_FIXTURE','待安排',now()-interval '3 hour',v_owner,NULL,NULL,NULL,NULL,NULL,NULL),
   ('c0000000-0000-4000-8000-000000000511','PRIVATE','REVIEW_已收納私人 Todo','REVIEW_FIXTURE','待安排',now()-interval '2 day',v_owner,NULL,NULL,NULL,NULL,NULL,NULL),
   ('c0000000-0000-4000-8000-000000000512','PRIVATE','REVIEW_已完成私人 Todo','REVIEW_FIXTURE','已完成',now()-interval '5 day',v_owner,NULL,NULL,NULL,NULL,NULL,NULL),
   ('c0000000-0000-4000-8000-000000000516','PRIVATE','REVIEW_獨立已收納 Todo','REVIEW_FIXTURE','已收納',now()-interval '4 day',v_owner,NULL,NULL,NULL,NULL,NULL,NULL),
   ('c0000000-0000-4000-8000-000000000513','TEAM','REVIEW_團隊待安排 Todo','REVIEW_FIXTURE','待安排',now()-interval '1 hour',v_owner,v_owner,v_assistant,v_group,'c0000000-0000-4000-8000-000000000100','工程',NULL),
   ('c0000000-0000-4000-8000-000000000514','TEAM','REVIEW_團隊已排程 Todo','REVIEW_FIXTURE','已排程',now()-interval '1 day',v_owner,v_owner,v_owner,v_group,'c0000000-0000-4000-8000-000000000101','工程','c0000000-0000-4000-8000-000000000501'),
   ('c0000000-0000-4000-8000-000000000515','TEAM','REVIEW_團隊未完成 Todo','REVIEW_FIXTURE','待安排',now()-interval '4 day',v_assistant,v_assistant,v_owner,v_group,'c0000000-0000-4000-8000-000000000102','驗收',NULL)
  ON CONFLICT (id) DO UPDATE SET scope=excluded.scope,title=excluded.title,content=excluded.content,status=excluded.status,received_at=excluded.received_at,created_by=excluded.created_by,assigned_by=excluded.assigned_by,assigned_to=excluded.assigned_to,work_group_id=excluded.work_group_id,project_id=excluded.project_id,task_type=excluded.task_type,converted_task_id=excluded.converted_task_id,updated_at=now();

  INSERT INTO public.work_items(id,owner_member_id,work_zone_id,title,content,status,received_at,expected_start_date,due_date,completed_at,project_id,project_label,source_todo_id,source_created_at)
  VALUES
   ('c0000000-0000-4000-8000-000000000520',v_owner,v_zone_t,'REVIEW_T 區工作','REVIEW_FIXTURE drag/drop','待處理',now()-interval '3 day',CURRENT_DATE,CURRENT_DATE+3,NULL,NULL,'REVIEW_自訂案件標籤',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000521',v_owner,v_zone_a,'REVIEW_A 區工作','REVIEW_FIXTURE linked project','進行中',now()-interval '2 day',CURRENT_DATE-1,CURRENT_DATE+5,NULL,'c0000000-0000-4000-8000-000000000100',NULL,NULL,NULL),
   ('c0000000-0000-4000-8000-000000000522',v_owner,v_zone_q,'REVIEW_Q 區工作','REVIEW_FIXTURE complete/delete','已完成',now()-interval '5 day',CURRENT_DATE-4,CURRENT_DATE-1,now()-interval '1 day','c0000000-0000-4000-8000-000000000101',NULL,'c0000000-0000-4000-8000-000000000511',now()-interval '2 day')
  ON CONFLICT (id) DO UPDATE SET owner_member_id=excluded.owner_member_id,work_zone_id=excluded.work_zone_id,title=excluded.title,content=excluded.content,status=excluded.status,received_at=excluded.received_at,expected_start_date=excluded.expected_start_date,due_date=excluded.due_date,completed_at=excluded.completed_at,project_id=excluded.project_id,project_label=excluded.project_label,source_todo_id=excluded.source_todo_id,source_created_at=excluded.source_created_at,updated_at=now();

  -- The insert trigger archives the source Todo on first load. Re-assert that
  -- deterministic final state after an upsert rerun as well.
  UPDATE public.todos
  SET status = '已收納', updated_at = now()
  WHERE id = 'c0000000-0000-4000-8000-000000000511';

  INSERT INTO public.project_workflow_phases(id,phase_key,name,sort_order,is_active)
  VALUES
   ('c0000000-0000-4000-8000-000000000700','REVIEW_BUILD','REVIEW_施工',10,true),
   ('c0000000-0000-4000-8000-000000000701','REVIEW_CLOSE','REVIEW_驗收掛表',20,true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.project_workflow_types(id,type_key,name,sort_order,is_active)
  VALUES
   ('c0000000-0000-4000-8000-000000000710','REVIEW_RACKING','REVIEW_支架',10,true),
   ('c0000000-0000-4000-8000-000000000711','INTERNAL_ACCEPTANCE','驗收',20,true),
   ('c0000000-0000-4000-8000-000000000712','METER_INSTALLATION','掛表',30,true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.project_workflow_templates(id,template_key,name,description,is_default,is_active)
  VALUES('c0000000-0000-4000-8000-000000000720','REVIEW_BASELINE','REVIEW_驗收流程','REVIEW_FIXTURE',false,true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.project_workflow_templates(id,template_key,name,description,is_default,is_active)
  VALUES('c0000000-0000-4000-8000-000000000721','NORTH_DEFAULT','REVIEW_NORTH_DEFAULT','REVIEW_FIXTURE settings baseline',true,true)
  ON CONFLICT (template_key) DO NOTHING;

  INSERT INTO public.project_workflow_template_steps(id,template_id,step_key,label,phase_id,type_id,sort_order,default_is_applicable,is_active,responsible_position_id)
  VALUES
   ('c0000000-0000-4000-8000-000000000730','c0000000-0000-4000-8000-000000000720','REVIEW_CURRENT_A','REVIEW_目前節點 A','c0000000-0000-4000-8000-000000000700','c0000000-0000-4000-8000-000000000710',10,true,true,v_position),
   ('c0000000-0000-4000-8000-000000000731','c0000000-0000-4000-8000-000000000720','REVIEW_CURRENT_B','REVIEW_目前平行節點 B','c0000000-0000-4000-8000-000000000700','c0000000-0000-4000-8000-000000000710',10,true,true,v_position),
   ('c0000000-0000-4000-8000-000000000732','c0000000-0000-4000-8000-000000000720','REVIEW_NEXT','REVIEW_下一節點','c0000000-0000-4000-8000-000000000701','c0000000-0000-4000-8000-000000000711',20,true,true,v_position)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.project_workflow_template_steps(id,template_id,step_key,label,phase_id,type_id,sort_order,default_is_applicable,is_active,responsible_position_id)
  SELECT fixture.id,template.id,fixture.step_key,fixture.label,fixture.phase_id,fixture.type_id,fixture.sort_order,true,true,v_position
  FROM public.project_workflow_templates template
  CROSS JOIN (VALUES
   ('c0000000-0000-4000-8000-000000000733'::uuid,'REVIEW_NORTH_CURRENT_A','REVIEW_預設目前節點 A','c0000000-0000-4000-8000-000000000700'::uuid,'c0000000-0000-4000-8000-000000000710'::uuid,10),
   ('c0000000-0000-4000-8000-000000000734'::uuid,'REVIEW_NORTH_CURRENT_B','REVIEW_預設平行節點 B','c0000000-0000-4000-8000-000000000700'::uuid,'c0000000-0000-4000-8000-000000000710'::uuid,10),
   ('c0000000-0000-4000-8000-000000000735'::uuid,'REVIEW_NORTH_NEXT','REVIEW_預設下一節點','c0000000-0000-4000-8000-000000000701'::uuid,'c0000000-0000-4000-8000-000000000711'::uuid,20)
  ) AS fixture(id,step_key,label,phase_id,type_id,sort_order)
  WHERE template.template_key='NORTH_DEFAULT'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.project_workflow_instances(id,project_id,source_template_id,template_key_snapshot,template_name_snapshot,snapshot_at,deleted_at)
  VALUES('c0000000-0000-4000-8000-000000000740','c0000000-0000-4000-8000-000000000100','c0000000-0000-4000-8000-000000000720','REVIEW_BASELINE','REVIEW_驗收流程',now(),NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.project_milestones(id,project_id,workflow_instance_id,milestone_key,label,phase_key_snapshot,phase_name_snapshot,phase_sort_order_snapshot,type_key_snapshot,type_name_snapshot,sort_order,status,planned_date,actual_date,is_applicable,origin,source_phase_id,source_type_id,source_template_step_id,responsible_position_id,notes,deleted_at,archived_at)
  VALUES
   ('c0000000-0000-4000-8000-000000000750','c0000000-0000-4000-8000-000000000100','c0000000-0000-4000-8000-000000000740','REVIEW_CURRENT_A','REVIEW_目前節點 A','REVIEW_BUILD','REVIEW_施工',10,'REVIEW_RACKING','REVIEW_支架',10,'IN_PROGRESS',CURRENT_DATE+2,NULL,true,'TEMPLATE','c0000000-0000-4000-8000-000000000700','c0000000-0000-4000-8000-000000000710','c0000000-0000-4000-8000-000000000730',v_position,'REVIEW_FIXTURE',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000751','c0000000-0000-4000-8000-000000000100','c0000000-0000-4000-8000-000000000740','REVIEW_CURRENT_B','REVIEW_目前平行節點 B','REVIEW_BUILD','REVIEW_施工',10,'REVIEW_RACKING','REVIEW_支架',10,'IN_PROGRESS',CURRENT_DATE+3,NULL,true,'TEMPLATE','c0000000-0000-4000-8000-000000000700','c0000000-0000-4000-8000-000000000710','c0000000-0000-4000-8000-000000000731',v_position,'REVIEW_FIXTURE parallel',NULL,NULL),
   ('c0000000-0000-4000-8000-000000000752','c0000000-0000-4000-8000-000000000100','c0000000-0000-4000-8000-000000000740','INTERNAL_ACCEPTANCE','REVIEW_下一節點驗收','REVIEW_CLOSE','REVIEW_驗收掛表',20,'INTERNAL_ACCEPTANCE','驗收',20,'NOT_STARTED',CURRENT_DATE+7,NULL,true,'TEMPLATE','c0000000-0000-4000-8000-000000000701','c0000000-0000-4000-8000-000000000711','c0000000-0000-4000-8000-000000000732',v_position,'REVIEW_FIXTURE next',NULL,NULL)
  ON CONFLICT (id) DO UPDATE SET project_id=excluded.project_id,workflow_instance_id=excluded.workflow_instance_id,milestone_key=excluded.milestone_key,label=excluded.label,phase_key_snapshot=excluded.phase_key_snapshot,phase_name_snapshot=excluded.phase_name_snapshot,phase_sort_order_snapshot=excluded.phase_sort_order_snapshot,type_key_snapshot=excluded.type_key_snapshot,type_name_snapshot=excluded.type_name_snapshot,sort_order=excluded.sort_order,status=excluded.status,planned_date=excluded.planned_date,actual_date=excluded.actual_date,is_applicable=true,origin=excluded.origin,source_phase_id=excluded.source_phase_id,source_type_id=excluded.source_type_id,source_template_step_id=excluded.source_template_step_id,responsible_position_id=excluded.responsible_position_id,notes=excluded.notes,deleted_at=NULL,archived_at=NULL,updated_at=now();

  INSERT INTO public.inventory_items(id,code,category,item_category,name,source_type,unit,opening_quantity,low_stock_threshold,requires_serial,notes,is_active)
  VALUES
   ('c0000000-0000-4000-8000-000000000600','REVIEW_INV_001','設備維修','設備','REVIEW_序號逆變器','TEST','台',1,1,true,'REVIEW_FIXTURE',true),
   ('c0000000-0000-4000-8000-000000000601','REVIEW_INV_002','建置 / 維修','材料','REVIEW_測試線材','TEST','米',100,10,false,'REVIEW_FIXTURE',true),
   ('c0000000-0000-4000-8000-000000000602','REVIEW_INV_003','建置 / 維修','材料','REVIEW_測試支架','TEST','組',20,3,false,'REVIEW_FIXTURE',true)
  ON CONFLICT (id) DO UPDATE SET code=excluded.code,category=excluded.category,item_category=excluded.item_category,name=excluded.name,source_type=excluded.source_type,unit=excluded.unit,opening_quantity=excluded.opening_quantity,low_stock_threshold=excluded.low_stock_threshold,requires_serial=excluded.requires_serial,notes=excluded.notes,is_active=true,updated_at=now();

  INSERT INTO public.inventory_transactions(id,item_id,transaction_type,transaction_date,quantity,unit,project_id,project_name,handler,source,notes,is_voided,pending_serial_count)
  VALUES
   ('c0000000-0000-4000-8000-000000000610','c0000000-0000-4000-8000-000000000600','IN',CURRENT_DATE-3,1,'台',NULL,NULL,'REVIEW_測試人員','REVIEW_TEST','REVIEW_FIXTURE IN',false,0),
   ('c0000000-0000-4000-8000-000000000611','c0000000-0000-4000-8000-000000000601','OUT',CURRENT_DATE-2,5,'米','c0000000-0000-4000-8000-000000000100','REVIEW_北區進行中一號','REVIEW_測試人員','REVIEW_TEST','REVIEW_FIXTURE OUT',false,0),
   ('c0000000-0000-4000-8000-000000000612','c0000000-0000-4000-8000-000000000602','RETURN',CURRENT_DATE-1,2,'組','c0000000-0000-4000-8000-000000000101','REVIEW_北區進行中二號','REVIEW_測試人員','REVIEW_TEST','REVIEW_FIXTURE RETURN',false,0)
  ON CONFLICT (id) DO UPDATE SET item_id=excluded.item_id,transaction_type=excluded.transaction_type,transaction_date=excluded.transaction_date,quantity=excluded.quantity,unit=excluded.unit,project_id=excluded.project_id,project_name=excluded.project_name,handler=excluded.handler,source=excluded.source,notes=excluded.notes,is_voided=false,pending_serial_count=0,updated_at=now();

  SELECT id INTO v_batch FROM public.inventory_batches WHERE source_transaction_id='c0000000-0000-4000-8000-000000000610' LIMIT 1;
  IF v_batch IS NULL THEN
    v_batch := 'c0000000-0000-4000-8000-000000000620';
    INSERT INTO public.inventory_batches(id,batch_number,item_id,in_date,source,quantity,unit,handler,notes,source_transaction_id)
    VALUES(v_batch,'REVIEW_BATCH_001','c0000000-0000-4000-8000-000000000600',CURRENT_DATE-3,'REVIEW_TEST',1,'台','REVIEW_測試人員','REVIEW_FIXTURE','c0000000-0000-4000-8000-000000000610');
  END IF;

  INSERT INTO public.inventory_serials(id,item_id,batch_id,serial_number,status,project_id,notes)
  VALUES('c0000000-0000-4000-8000-000000000630','c0000000-0000-4000-8000-000000000600',v_batch,'REVIEW-SERIAL-0001','在庫',NULL,'REVIEW_FIXTURE')
  ON CONFLICT (id) DO UPDATE SET item_id=excluded.item_id,batch_id=excluded.batch_id,serial_number=excluded.serial_number,status='在庫',project_id=NULL,notes=excluded.notes,updated_at=now();

  INSERT INTO public.inventory_transaction_serials(id,transaction_id,serial_id,serial_no,is_pending)
  VALUES('c0000000-0000-4000-8000-000000000640','c0000000-0000-4000-8000-000000000610','c0000000-0000-4000-8000-000000000630','REVIEW-SERIAL-0001',false)
  ON CONFLICT (id) DO UPDATE SET transaction_id=excluded.transaction_id,serial_id=excluded.serial_id,serial_no=excluded.serial_no,is_pending=false;

  INSERT INTO public.se_supply_records(id,project_id,project_name,receive_date,replace_date,receive_method,old_model,new_model,faulty_serial,new_serial,fault_reason,notes)
  VALUES('c0000000-0000-4000-8000-000000000650','c0000000-0000-4000-8000-000000000100','REVIEW_北區進行中一號',CURRENT_DATE-5,CURRENT_DATE-2,'REVIEW_TEST','REVIEW_OLD','REVIEW_NEW','REVIEW-FAULT-001','REVIEW-NEW-001','REVIEW_FIXTURE 測試故障','REVIEW_FIXTURE')
  ON CONFLICT (id) DO UPDATE SET project_id=excluded.project_id,project_name=excluded.project_name,receive_date=excluded.receive_date,replace_date=excluded.replace_date,receive_method=excluded.receive_method,old_model=excluded.old_model,new_model=excluded.new_model,faulty_serial=excluded.faulty_serial,new_serial=excluded.new_serial,fault_reason=excluded.fault_reason,notes=excluded.notes,updated_at=timezone('utc',now());

  DELETE FROM public.activity_logs WHERE target_id LIKE 'c0000000-0000-4000-8000-%' OR message='REVIEW_FIXTURE baseline ready';
  INSERT INTO public.activity_logs(action,target_type,target_id,description,user_name,action_type,target_label,project_id,project_name,message)
  VALUES('REVIEW_SETUP','CANDIDATE_REVIEW','c0000000-0000-4000-8000-000000000999','Candidate review fixtures installed',v_owner_name,'REVIEW_SETUP','REVIEW_FIXTURE','c0000000-0000-4000-8000-000000000100','REVIEW_北區進行中一號','REVIEW_FIXTURE baseline ready');
END
$fixture$;

NOTIFY pgrst, 'reload schema';
COMMIT;
