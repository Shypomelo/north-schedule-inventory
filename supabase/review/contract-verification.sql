-- Read-only Candidate contract, safety, and Production-like baseline verification.
WITH required_relations(name) AS (
  VALUES
    ('public.activity_logs'), ('public.contractors'), ('public.dashboard_views'),
    ('public.inventory_batches'), ('public.inventory_initialization_items'),
    ('public.inventory_initialization_serials'), ('public.inventory_initializations'),
    ('public.inventory_items'), ('public.inventory_monthly_closing_items'),
    ('public.inventory_monthly_closings'), ('public.inventory_serials'),
    ('public.inventory_transaction_serials'), ('public.inventory_transactions'),
    ('public.member_dashboard_views'), ('public.member_positions'), ('public.member_work_groups'),
    ('public.positions'), ('public.project_construction_progress'),
    ('public.project_difficulty_assessments'), ('public.project_milestones'),
    ('public.project_position_assignments'), ('public.project_workflow_instances'),
    ('public.project_workflow_phases'), ('public.project_workflow_template_steps'),
    ('public.project_workflow_templates'), ('public.project_workflow_types'),
    ('public.projects'), ('public.schedule_task_types'), ('public.schedule_tasks'),
    ('public.se_supply_records'), ('public.team_members'), ('public.todos'),
    ('public.work_groups'), ('public.work_items'), ('public.work_zones')
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
baseline_counts AS (
  SELECT jsonb_build_object(
    'team_members',(SELECT count(*) FROM public.team_members),
    'projects',(SELECT count(*) FROM public.projects),
    'schedule_tasks',(SELECT count(*) FROM public.schedule_tasks),
    'todos',(SELECT count(*) FROM public.todos),
    'workflow_instances',(SELECT count(*) FROM public.project_workflow_instances),
    'workflow_milestones',(SELECT count(*) FROM public.project_milestones),
    'inventory_items',(SELECT count(*) FROM public.inventory_items),
    'inventory_transactions',(SELECT count(*) FROM public.inventory_transactions),
    'se_supply',(SELECT count(*) FROM public.se_supply_records)
  ) value
),
auth_links AS (
  SELECT
    count(*) FILTER (WHERE member.id IS NOT NULL) AS matched_users,
    count(*) FILTER (WHERE member.id IS NULL) AS unmatched_users
  FROM auth.users auth_user
  LEFT JOIN public.team_members member
    ON lower(btrim(member.email)) = lower(btrim(auth_user.email))
    AND member.deleted_at IS NULL
)
SELECT jsonb_build_object(
  'guard_ok',EXISTS(
    SELECT 1 FROM review_private.environment_guard
    WHERE singleton AND project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW'
  ),
  'missing_relations',COALESCE((SELECT jsonb_agg(name ORDER BY name) FROM missing_relations),'[]'::jsonb),
  'missing_functions',COALESCE((SELECT jsonb_agg(signature ORDER BY signature) FROM missing_functions),'[]'::jsonb),
  'unvalidated_foreign_keys',(
    SELECT count(*) FROM pg_constraint con
    JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace nsp ON nsp.oid=rel.relnamespace
    WHERE nsp.nspname='public' AND con.contype='f' AND NOT con.convalidated
  ),
  'active_cron_jobs',(SELECT count(*) FROM cron.job WHERE active),
  'google_enabled_work_groups',(SELECT count(*) FROM public.work_groups WHERE google_calendar_sync_enabled),
  'external_network_routines',(
    SELECT count(*) FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname IN ('public','app_private') AND routine.prokind='f'
      AND pg_get_functiondef(routine.oid) ~* '(net\.http|http_post|http_get|webhook|https?://)'
  ),
  'auth_team_member_links',(SELECT to_jsonb(auth_links) FROM auth_links),
  'business_counts',(SELECT value FROM baseline_counts),
  'fixture_prefix_rows',(
    SELECT count(*) FROM (
      SELECT id FROM public.projects WHERE id::text LIKE 'c0000000-0000-4000-8000-%'
      UNION ALL SELECT id FROM public.schedule_tasks WHERE id::text LIKE 'c0000000-0000-4000-8000-%'
      UNION ALL SELECT id FROM public.todos WHERE id::text LIKE 'c0000000-0000-4000-8000-%'
      UNION ALL SELECT id FROM public.work_items WHERE id::text LIKE 'c0000000-0000-4000-8000-%'
      UNION ALL SELECT id FROM public.team_members WHERE id::text LIKE 'c0000000-0000-4000-8000-%'
    ) fixture_rows
  )
) AS candidate_review_verification;
