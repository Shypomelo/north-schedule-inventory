-- Only run against the disposable Foundation rehearsal, never a remote DB.
\set ON_ERROR_STOP on
BEGIN;
ALTER TABLE public.projects ADD COLUMN responsible_member_name text, ADD COLUMN deleted_at timestamptz;
GRANT SELECT ON public.projects,public.team_members TO authenticated;
\ir ../migrations/20260904004145_create_project_workflow_v2_schema.sql
\ir ../migrations/20260907131749_add_project_position_responsibilities.sql
\ir ../migrations/20260907155524_unify_project_engineering_responsibility.sql
\ir ../migrations/20260908140629_fix_admin_workflow_refresh_rls.sql
CREATE FUNCTION pg_temp.assert_ok(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.denied(statement text) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN EXECUTE statement; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
INSERT INTO public.project_workflow_templates(template_key,name) VALUES('REBUILD','Rebuild test') RETURNING id AS template_id \gset
INSERT INTO public.project_workflow_phases(phase_key,name,sort_order) VALUES('ARBITRARY','Original phase',10) RETURNING id AS phase_id \gset
INSERT INTO public.project_workflow_types(type_key,name,sort_order) VALUES('TYPE_TEST','Type test',10) RETURNING id AS type_id \gset
INSERT INTO public.project_workflow_template_steps(template_id,step_key,label,phase_id,type_id,sort_order) VALUES(:'template_id','FIRST','First',:'phase_id',:'type_id',10),(:'template_id','REMOVED','Removed',:'phase_id',:'type_id',20);
INSERT INTO public.project_workflow_instances(project_id,source_template_id,template_key_snapshot,template_name_snapshot) VALUES('20000000-0000-4000-8000-000000000001',:'template_id','REBUILD','Rebuild test') RETURNING id AS instance_id \gset
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"email":"admin@example.test"}';
SELECT public.refresh_project_workflow('20000000-0000-4000-8000-000000000001');
UPDATE public.project_milestones SET status='COMPLETED',actual_date='2026-09-01',planned_date='2026-08-31',notes='Keep business progress' WHERE milestone_key='FIRST';
INSERT INTO public.project_milestones(workflow_instance_id,project_id,origin,label,source_phase_id,source_type_id,sort_order) VALUES(:'instance_id','20000000-0000-4000-8000-000000000001','PROJECT_CUSTOM','Custom',:'phase_id',:'type_id',15);
RESET ROLE;
-- Upgrade an already populated old workflow; do not only test empty-schema installs.
\ir ../migrations/20260911054254_workflow_framework_rebuild.sql
SET LOCAL ROLE authenticated;
UPDATE public.project_workflow_phases SET name='Renamed arbitrary phase',sort_order=77 WHERE id=:'phase_id';
UPDATE public.project_workflow_template_steps SET label='Renamed first',sort_order=30 WHERE step_key='FIRST';
UPDATE public.project_workflow_template_steps SET is_active=false WHERE step_key='REMOVED';
INSERT INTO public.project_workflow_template_steps(template_id,step_key,label,phase_id,type_id,sort_order) VALUES(:'template_id','ADDED','Added',:'phase_id',:'type_id',40);
SELECT public.refresh_project_workflow('20000000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_ok((SELECT label='First' AND phase_name_snapshot='Original phase' FROM public.project_milestones WHERE milestone_key='FIRST'),'sync preserves old snapshots');
-- Add a second missing step after sync, so rebuild insertion is independently exercised.
INSERT INTO public.project_workflow_template_steps(template_id,step_key,label,phase_id,type_id,sort_order) VALUES(:'template_id','ADDED_REBUILD','Added rebuild',:'phase_id',:'type_id',50);
SELECT public.preview_project_workflow_rebuild('20000000-0000-4000-8000-000000000001') AS preview \gset
SELECT pg_temp.assert_ok((:'preview'::jsonb->>'matched')::int=2 AND (:'preview'::jsonb->>'added')::int=1 AND (:'preview'::jsonb->>'archived')::int=1 AND (:'preview'::jsonb->>'custom')::int=1,'preview counts exact template id matching');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.rebuild_project_workflow('20000000-0000-4000-8000-000000000001','stale')$q$),'stale preview rejected');
SELECT public.rebuild_project_workflow('20000000-0000-4000-8000-000000000001',:'preview'::jsonb->>'token');
SELECT pg_temp.assert_ok((SELECT status='COMPLETED' AND actual_date='2026-09-01' AND planned_date='2026-08-31' AND notes='Keep business progress' FROM public.project_milestones WHERE milestone_key='FIRST'),'matched business progress preserved');
SELECT pg_temp.assert_ok((SELECT label='Renamed first' AND phase_name_snapshot='Renamed arbitrary phase' AND phase_sort_order_snapshot=77 AND sort_order=30 FROM public.project_milestones WHERE milestone_key='FIRST'),'phase label and order snapshots rebuilt');
SELECT pg_temp.assert_ok((SELECT archived_at IS NOT NULL AND deleted_at IS NULL FROM public.project_milestones WHERE milestone_key='REMOVED'),'removed step archived not deleted');
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.project_milestones WHERE milestone_key='ADDED_REBUILD'),'missing step added once');
SELECT pg_temp.assert_ok((SELECT label='Custom' AND sort_order=15 AND phase_name_snapshot='Original phase' AND archived_at IS NULL FROM public.project_milestones WHERE origin='PROJECT_CUSTOM'),'custom snapshot and deterministic order preserved');
SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY id)::text) AS before_again FROM public.project_milestones m \gset
SELECT public.rebuild_project_workflow('20000000-0000-4000-8000-000000000001',public.preview_project_workflow_rebuild('20000000-0000-4000-8000-000000000001')->>'token');
SELECT pg_temp.assert_ok((SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY id)::text)=:'before_again' FROM public.project_milestones m),'second rebuild idempotent including timestamps');
SET LOCAL request.jwt.claims='{"email":"owner1@example.test"}';
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.preview_project_workflow_rebuild('20000000-0000-4000-8000-000000000001')$q$),'engineer preview denied');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.rebuild_project_workflow('20000000-0000-4000-8000-000000000001','anything')$q$),'engineer rebuild denied');
SELECT pg_temp.assert_ok(pg_temp.denied($q$UPDATE public.project_milestones SET phase_name_snapshot='spoof' WHERE milestone_key='FIRST'$q$),'direct nonadmin snapshot spoof denied');
SELECT pg_temp.assert_ok(pg_temp.denied($q$UPDATE public.project_milestones SET archived_at=now() WHERE milestone_key='FIRST'$q$),'nonadmin archive denied');
RESET ROLE;
SELECT pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM pg_proc WHERE proname IN ('preview_project_workflow_rebuild','rebuild_project_workflow','guard_workflow_framework_metadata','validate_project_milestone_contract') AND prosecdef),'all new/replaced functions invoker');
SELECT pg_temp.assert_ok(NOT has_table_privilege('authenticated','public.project_workflow_instances','UPDATE'),'no new instance update privilege');
ROLLBACK;
