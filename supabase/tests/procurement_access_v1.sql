-- Run only after the forward migration on a disposable local database or Candidate.
-- Every fixture write is rolled back. Execute with a privileged SQL runner.
BEGIN;
SET LOCAL statement_timeout = '45s';

CREATE FUNCTION pg_temp.ok(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;
CREATE FUNCTION pg_temp.denied(statement text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: %', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % succeeded', label;
END $$;
CREATE FUNCTION pg_temp.no_write(statement text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE affected bigint;
BEGIN
  BEGIN
    EXECUTE statement;
    GET DIAGNOSTICS affected = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: %', label;
    RETURN;
  END;
  IF affected <> 0 THEN RAISE EXCEPTION 'FAIL: % changed % rows', label, affected; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO public.team_members(id, name, email, role, category, is_active)
VALUES ('9a5c1000-0000-4000-8000-000000000001', 'Procurement fixture',
        'procurement-v1-fixture@example.invalid', 'procurement', 'other', true);

SELECT set_config('request.jwt.claims',
  '{"email":"procurement-v1-fixture@example.invalid","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT pg_temp.ok(app_private.is_procurement_member(), 'Procurement capability');
SELECT pg_temp.ok(NOT app_private.is_active_member(), 'no broad active-member capability');
SELECT pg_temp.ok(NOT app_private.is_editor_member(), 'no editor capability');
SELECT pg_temp.ok(app_private.current_member_id() IS NULL, 'no owner-scoped workbench capability');

SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.inventory_items), 'inventory SELECT');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.inventory_transactions), 'inventory transaction SELECT');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.receiving_arrivals), 'receiving arrival SELECT');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.project_materials), 'office receiving material SELECT');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.se_supply_records), 'receiving supply SELECT');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.get_procurement_project_labels()), 'project label RPC');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.get_procurement_actor_labels()), 'actor label RPC');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.team_members), 'own member profile only');
SELECT pg_temp.ok(public.get_receiving_pending_fulfilment(
  (SELECT id FROM public.project_materials ORDER BY id LIMIT 1), NULL)->>'expected' IS NOT NULL,
  'receiving fulfilment read RPC');

SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.schedule_tasks), 'schedule SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.projects), 'projects SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.project_milestones), 'project business SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.tool_links), 'toolbox SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.todos), 'todos SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.work_items), 'workbench SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.work_zones), 'work zones SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.dashboard_views), 'dashboard SELECT blocked');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.maintenance_equipment_records), 'maintenance SELECT blocked');

SELECT pg_temp.denied(
  $q$INSERT INTO public.inventory_items(id,code,name,unit,category,opening_quantity,requires_serial)
      VALUES(gen_random_uuid(),'PROC-DENY','Procurement denied','個','一般',0,false)$q$,
  'inventory INSERT blocked');
SELECT pg_temp.denied($q$INSERT INTO public.inventory_transactions DEFAULT VALUES$q$,
  'inventory transaction direct INSERT blocked');
WITH changed AS (
  UPDATE public.inventory_items SET name = name
  WHERE id = (SELECT id FROM public.inventory_items ORDER BY id LIMIT 1) RETURNING id
)
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM changed), 'inventory UPDATE blocked');
WITH removed AS (
  DELETE FROM public.inventory_items
  WHERE id = (SELECT id FROM public.inventory_items ORDER BY id LIMIT 1) RETURNING id
)
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM removed), 'inventory DELETE blocked');
SELECT pg_temp.denied(
  $q$SELECT public.write_inventory_transaction_atomic('CREATE','{}'::jsonb)$q$,
  'inventory mutation RPC blocked');
SELECT pg_temp.denied($q$INSERT INTO public.receiving_arrivals DEFAULT VALUES$q$,
  'receiving direct INSERT blocked');
SELECT pg_temp.no_write(
  $q$UPDATE public.receiving_arrivals SET notes=notes
      WHERE id=(SELECT id FROM public.receiving_arrivals ORDER BY id LIMIT 1)$q$,
  'receiving direct UPDATE blocked');
SELECT pg_temp.no_write(
  $q$DELETE FROM public.receiving_arrivals
      WHERE id=(SELECT id FROM public.receiving_arrivals ORDER BY id LIMIT 1)$q$,
  'receiving direct DELETE blocked');
SELECT pg_temp.denied(
  $q$SELECT public.initialize_inventory('[]'::jsonb)$q$,
  'inventory initialization RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.unseal_inventory_month('2099','12')$q$,
  'inventory unseal RPC blocked');

SELECT pg_temp.denied(
  $q$SELECT public.create_receiving_arrival(gen_random_uuid(),now(),'[]'::jsonb)$q$,
  'receiving create RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.post_receiving_arrival_line(gen_random_uuid(),gen_random_uuid(),1,'{}'::uuid[])$q$,
  'receiving post RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.route_staged_receiving(gen_random_uuid(),'STAGED',gen_random_uuid(),NULL,'SE',1,'{}'::uuid[],NULL,NULL,false,now())$q$,
  'receiving route RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.return_receiving_se_to_received(gen_random_uuid(),gen_random_uuid(),'denied')$q$,
  'receiving return RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.reenter_receiving_inventory(gen_random_uuid(),gen_random_uuid(),1,'{}'::uuid[],now(),NULL)$q$,
  'receiving reentry RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.cancel_receiving_arrival(gen_random_uuid(),'ARRIVAL',gen_random_uuid(),NULL)$q$,
  'receiving cancel RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.correct_receiving_inventory(gen_random_uuid(),gen_random_uuid(),1,'{}'::uuid[],now(),NULL)$q$,
  'receiving correction RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.update_material_receipt_plan(gen_random_uuid(),now())$q$,
  'material schedule mutation RPC blocked');
SELECT pg_temp.denied(
  $q$SELECT public.update_member_workspace_profile(NULL,'Denied','denied@example.invalid','admin',true,NULL,NULL,'{}'::uuid[],'{}'::uuid[],NULL,'{}'::uuid[],NULL)$q$,
  'admin RPC blocked');

RESET ROLE;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.ok(app_private.is_active_member() AND app_private.is_editor_member() AND app_private.is_admin_member(),
  'ADMIN capability regression');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.schedule_tasks), 'ADMIN schedule read regression');
WITH changed AS (UPDATE public.inventory_items SET name=name
  WHERE id=(SELECT id FROM public.inventory_items ORDER BY id LIMIT 1) RETURNING id)
SELECT pg_temp.ok((SELECT count(*)=1 FROM changed), 'ADMIN inventory write regression');

RESET ROLE;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.ok(app_private.is_active_member() AND app_private.is_editor_member() AND NOT app_private.is_admin_member(),
  'ENGINEER capability regression');
WITH changed AS (UPDATE public.inventory_items SET name=name
  WHERE id=(SELECT id FROM public.inventory_items ORDER BY id LIMIT 1) RETURNING id)
SELECT pg_temp.ok((SELECT count(*)=1 FROM changed), 'ENGINEER inventory write regression');

RESET ROLE;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.ok(app_private.is_active_member() AND NOT app_private.is_editor_member(),
  'VIEWER capability regression');
SELECT pg_temp.ok((SELECT count(*) > 0 FROM public.inventory_items), 'VIEWER inventory read regression');
WITH changed AS (UPDATE public.inventory_items SET name=name
  WHERE id=(SELECT id FROM public.inventory_items ORDER BY id LIMIT 1) RETURNING id)
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM changed), 'VIEWER write denial regression');

RESET ROLE;
ROLLBACK;
