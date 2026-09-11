-- Run on the disposable Foundation fixture ONLY (KEEP_SCHEMA=1).
\set ON_ERROR_STOP on
BEGIN;
\ir ../migrations/20260911052802_workspace_perspectives.sql
CREATE FUNCTION pg_temp.assert_ok(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.denied(statement text) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN EXECUTE statement; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
SELECT pg_temp.assert_ok((SELECT position('is_active_member' in coalesce(qual,''))>0 AND position('work_groups' in coalesce(qual,''))=0 FROM pg_policies WHERE schemaname='public' AND tablename='member_work_groups' AND policyname='member_work_groups_active_read'),'membership existence policy is active-member read only');
SELECT pg_temp.assert_ok((SELECT position('is_active' in coalesce(qual,''))>0 FROM pg_policies WHERE schemaname='public' AND tablename='work_groups' AND policyname='work_groups_active_read'),'work group active selector policy remains restricted');
SELECT pg_temp.assert_ok((SELECT count(*)=4 FROM pg_policies WHERE schemaname='public' AND tablename='work_zones'),'work zone private RLS policy set unchanged');
SELECT pg_temp.assert_ok((SELECT count(*)=4 FROM pg_policies WHERE schemaname='public' AND tablename='work_items'),'work item private RLS policy set unchanged');
INSERT INTO public.work_groups (id,key,name,is_active,sort_order)
VALUES ('30000000-0000-4000-8000-000000000099','INACTIVE_PROJECT_FIXTURE','Inactive fixture',false,99);
INSERT INTO public.member_work_groups (member_id,work_group_id,is_default)
VALUES ('10000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000099',true);
SELECT pg_temp.assert_ok((SELECT count(*)=3 FROM public.dashboard_views),'three perspective seeds');
SELECT pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM pg_proc WHERE proname IN ('configure_my_work_zones','set_member_dashboard_views') AND prosecdef),'new RPCs SECURITY INVOKER');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"email":"owner1@example.test"}';
SELECT pg_temp.assert_ok((SELECT count(*)=3 FROM public.dashboard_views),'active member reads views');
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.member_work_groups WHERE member_id='10000000-0000-4000-8000-000000000003' AND work_group_id='30000000-0000-4000-8000-000000000099'),'active member can observe inactive membership existence');
SELECT pg_temp.assert_ok((SELECT count(*)=0 FROM public.work_groups WHERE id='30000000-0000-4000-8000-000000000099'),'inactive group remains hidden from general selector reads');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.set_member_dashboard_views('10000000-0000-4000-8000-000000000002','{}',NULL)$q$),'nonadmin assignment denied');
SET LOCAL request.jwt.claims='{"email":"admin@example.test"}';
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.member_work_groups WHERE member_id='10000000-0000-4000-8000-000000000003' AND work_group_id='30000000-0000-4000-8000-000000000099'),'ADMIN reads inactive membership');
UPDATE public.member_work_groups SET is_default=false
WHERE member_id='10000000-0000-4000-8000-000000000003' AND work_group_id='30000000-0000-4000-8000-000000000099';
SELECT pg_temp.assert_ok((SELECT is_default=false FROM public.member_work_groups WHERE member_id='10000000-0000-4000-8000-000000000003' AND work_group_id='30000000-0000-4000-8000-000000000099'),'ADMIN manages inactive membership');
SELECT public.set_member_dashboard_views('10000000-0000-4000-8000-000000000002',ARRAY(SELECT id FROM public.dashboard_views),(SELECT id FROM public.dashboard_views WHERE key='DESIGN'));
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.member_dashboard_views WHERE is_default),'one assigned default');
SELECT pg_temp.assert_ok(pg_temp.denied($q$UPDATE public.member_dashboard_views SET is_default=true$q$),'second default rejected');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.set_member_dashboard_views('10000000-0000-4000-8000-000000000002','{}',(SELECT id FROM public.dashboard_views WHERE key='DESIGN'))$q$),'invalid replacement atomic');
SELECT pg_temp.assert_ok((SELECT count(*)=3 FROM public.member_dashboard_views),'failed replacement preserved memberships');
RESET ROLE;
UPDATE public.dashboard_views SET is_active=false WHERE key='DESIGN';
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.set_member_dashboard_views('10000000-0000-4000-8000-000000000002',ARRAY(SELECT id FROM public.dashboard_views WHERE key='DESIGN'),NULL)$q$),'inactive view assignment rejected');
SELECT pg_temp.assert_ok((SELECT count(*)=3 FROM public.member_dashboard_views),'inactive assignment failure preserves original state');
SET LOCAL request.jwt.claims='{"email":"owner2@example.test"}';
SELECT pg_temp.assert_ok((SELECT count(*)=0 FROM public.member_dashboard_views),'nonadmin cannot read other membership');
SET LOCAL request.jwt.claims='{"email":"admin@example.test"}';
SELECT public.configure_my_work_zones('[{"name":"A"},{"name":"B"}]',NULL);
SELECT pg_temp.assert_ok((SELECT count(*)=2 FROM public.work_zones WHERE is_active),'zero to two zones atomic');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.configure_my_work_zones('[{"name":"A"},{"name":"B"},{"name":"C"},{"name":"D"}]',NULL)$q$),'over three zones denied');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.configure_my_work_zones(NULL,NULL)$q$),'null configuration denied');
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.configure_my_work_zones('[{"name":""},{"name":"B"}]',NULL)$q$),'blank zone denied');
SELECT public.configure_my_work_zones('[{"name":"A"},{"name":"B"},{"name":"C"}]',NULL);
SELECT pg_temp.assert_ok((SELECT count(*)=3 FROM public.work_zones WHERE is_active),'two to three zones atomic');
SELECT pg_temp.assert_ok((SELECT count(*)=0 FROM public.work_items),'ADMIN cannot see others work items');
SET LOCAL request.jwt.claims='{"email":"owner1@example.test"}';
SELECT pg_temp.assert_ok(pg_temp.denied($q$SELECT public.configure_my_work_zones('[{"name":"X"},{"name":"Y"}]',NULL)$q$),'item-bearing zone removal requires destination');
SELECT public.configure_my_work_zones((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name)) FROM (SELECT * FROM public.work_zones WHERE is_active ORDER BY sort_order LIMIT 2) z),(SELECT id FROM public.work_zones WHERE is_active ORDER BY sort_order LIMIT 1));
SELECT pg_temp.assert_ok((SELECT count(*)=2 FROM public.work_zones WHERE is_active),'three to two keeps owned items accessible');
SELECT pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.work_items i JOIN public.work_zones z ON z.id=i.work_zone_id WHERE NOT z.is_active),'removed-zone items moved safely');
RESET ROLE;
ROLLBACK;
