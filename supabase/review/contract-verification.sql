-- Read-only Candidate contract and fixture verification.
WITH required_relations(name) AS (
  VALUES
    ('public.activity_logs'),
    ('public.contractors'),
    ('public.dashboard_views'),
    ('public.inventory_batches'),
    ('public.inventory_initialization_items'),
    ('public.inventory_initialization_serials'),
    ('public.inventory_initializations'),
    ('public.inventory_items'),
    ('public.inventory_monthly_closing_items'),
    ('public.inventory_monthly_closings'),
    ('public.inventory_serials'),
    ('public.inventory_transaction_serials'),
    ('public.inventory_transactions'),
    ('public.member_dashboard_views'),
    ('public.member_positions'),
    ('public.member_work_groups'),
    ('public.positions'),
    ('public.project_construction_progress'),
    ('public.project_difficulty_assessments'),
    ('public.project_milestones'),
    ('public.project_position_assignments'),
    ('public.project_workflow_instances'),
    ('public.project_workflow_phases'),
    ('public.project_workflow_template_steps'),
    ('public.project_workflow_templates'),
    ('public.project_workflow_types'),
    ('public.projects'),
    ('public.schedule_task_types'),
    ('public.schedule_tasks'),
    ('public.se_supply_records'),
    ('public.team_members'),
    ('public.todos'),
    ('public.work_groups'),
    ('public.work_items'),
    ('public.work_zones')
),
required_functions(signature) AS (
  VALUES
    ('public.classify_inventory_serial_format(text)'),
    ('public.configure_my_work_zones(jsonb,uuid)'),
    ('public.derive_inventory_serial_short_key(text)'),
    ('public.enforce_inventory_cutoff_guard()'),
    ('public.initialize_inventory(jsonb)'),
    ('public.lookup_inventory_serial(text,uuid,text[])'),
    ('public.normalize_inventory_serial(text)'),
    ('public.preview_inventory_initialization(jsonb)'),
    ('public.preview_project_workflow_rebuild(uuid)'),
    ('public.promote_private_todo_to_work_item(uuid,uuid,uuid,date,date)'),
    ('public.promote_private_todo_to_work_item(uuid,uuid,uuid,text,date,date)'),
    ('public.rebuild_project_workflow(uuid,text)'),
    ('public.refresh_project_workflow(uuid)'),
    ('public.reject_todo(uuid,text)'),
    ('public.set_member_dashboard_views(uuid,uuid[],uuid)'),
    ('public.set_project_position_assignment(uuid,uuid,uuid)'),
    ('public.set_updated_at()'),
    ('public.snapshot_project_workflow(uuid,uuid)'),
    ('public.unseal_inventory_month(text,text)'),
    ('public.update_member_workspace_profile(uuid,text,text,text,boolean,text,text,uuid[],uuid[],uuid,uuid[],uuid)')
),
missing_relations AS (
  SELECT name FROM required_relations WHERE to_regclass(name) IS NULL
),
missing_functions AS (
  SELECT signature FROM required_functions WHERE to_regprocedure(signature) IS NULL
),
fixture_counts AS (
  SELECT jsonb_build_object(
    'projects',(SELECT count(*) FROM public.projects WHERE project_code LIKE 'REVIEW_%'),
    'schedule_tasks',(SELECT count(*) FROM public.schedule_tasks WHERE title LIKE 'REVIEW_%'),
    'private_todos',(SELECT count(*) FROM public.todos WHERE scope='PRIVATE' AND title LIKE 'REVIEW_%'),
    'stored_private_todos',(SELECT count(*) FROM public.todos WHERE scope='PRIVATE' AND status='已收納' AND title LIKE 'REVIEW_%'),
    'team_todos',(SELECT count(*) FROM public.todos WHERE scope='TEAM' AND title LIKE 'REVIEW_%'),
    'work_items',(SELECT count(*) FROM public.work_items WHERE title LIKE 'REVIEW_%'),
    'work_item_zones',(SELECT count(DISTINCT work_zone_id) FROM public.work_items WHERE title LIKE 'REVIEW_%'),
    'contractors',(SELECT count(*) FROM public.contractors WHERE name LIKE 'REVIEW_%'),
    'construction_progress',(SELECT count(*) FROM public.project_construction_progress WHERE notes LIKE 'REVIEW_FIXTURE%'),
    'inventory_items',(SELECT count(*) FROM public.inventory_items WHERE code LIKE 'REVIEW_%'),
    'inventory_transactions',(SELECT count(*) FROM public.inventory_transactions WHERE notes LIKE 'REVIEW_FIXTURE%'),
    'inventory_serials',(SELECT count(*) FROM public.inventory_serials WHERE serial_number LIKE 'REVIEW-%'),
    'se_supply',(SELECT count(*) FROM public.se_supply_records WHERE notes='REVIEW_FIXTURE'),
    'workflow_instances',(SELECT count(*) FROM public.project_workflow_instances WHERE template_key_snapshot='REVIEW_BASELINE'),
    'north_default_templates',(SELECT count(*) FROM public.project_workflow_templates WHERE template_key='NORTH_DEFAULT' AND is_active),
    'workflow_milestones',(SELECT count(*) FROM public.project_milestones WHERE milestone_key LIKE 'REVIEW_%' OR notes LIKE 'REVIEW_FIXTURE%')
  ) value
)
SELECT jsonb_build_object(
  'guard_ok',EXISTS(SELECT 1 FROM review_private.environment_guard WHERE singleton AND project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW'),
  'missing_relations',COALESCE((SELECT jsonb_agg(name ORDER BY name) FROM missing_relations),'[]'::jsonb),
  'missing_functions',COALESCE((SELECT jsonb_agg(signature ORDER BY signature) FROM missing_functions),'[]'::jsonb),
  'fixtures',(SELECT value FROM fixture_counts),
  'fixture_ready',(
    (SELECT count(*) FROM public.projects WHERE project_code LIKE 'REVIEW_%') >= 8 AND
    (SELECT count(*) FROM public.schedule_tasks WHERE title LIKE 'REVIEW_%') >= 3 AND
    (SELECT count(*) FROM public.todos WHERE scope='PRIVATE' AND title LIKE 'REVIEW_%') >= 4 AND
    (SELECT count(*) FROM public.todos WHERE scope='PRIVATE' AND status='已收納' AND title LIKE 'REVIEW_%') >= 1 AND
    (SELECT count(*) FROM public.todos WHERE scope='TEAM' AND title LIKE 'REVIEW_%') >= 3 AND
    (SELECT count(*) FROM public.work_items WHERE title LIKE 'REVIEW_%') >= 3 AND
    (SELECT count(DISTINCT work_zone_id) FROM public.work_items WHERE title LIKE 'REVIEW_%') = 3 AND
    (SELECT count(*) FROM public.inventory_items WHERE code LIKE 'REVIEW_%') >= 3 AND
    (SELECT count(*) FROM public.project_workflow_templates WHERE template_key='NORTH_DEFAULT' AND is_active) = 1
  )
) AS candidate_review_verification;
