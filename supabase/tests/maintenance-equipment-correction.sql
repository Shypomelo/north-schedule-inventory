-- Candidate/disposable LOCAL only; every fixture and injected failure is rolled back.
BEGIN;
SET LOCAL statement_timeout='45s';
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.reject(sql text,pattern text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE msg text; BEGIN
 BEGIN EXECUTE sql; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF position(pattern IN msg)>0 THEN RETURN; END IF; RAISE EXCEPTION 'Expected %, got %',pattern,msg;
 END; RAISE EXCEPTION 'Expected error: %',pattern;
END $$;
CREATE FUNCTION pg_temp.uid(kind int,n int) RETURNS uuid LANGUAGE sql AS $$
 SELECT ('7b000000-0000-4000-'||kind::text||'-'||lpad(n::text,12,'0'))::uuid $$;
SELECT set_config('test.project',(SELECT id::text FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.editor',(SELECT email FROM team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial,is_se_maintenance_equipment)
 VALUES(pg_temp.uid(8000,1),'EQ-V2','EQ-V2','台','設備維修',0,true,true);
INSERT INTO schedule_tasks(id,title,task_date,task_type,status,project_id,work_group_id)
 SELECT pg_temp.uid(9000,1),'[TEST equipment V2]',CURRENT_DATE,'維修','完成',current_setting('test.project'),(SELECT id FROM work_groups ORDER BY id LIMIT 1);
INSERT INTO se_supply_records(id,project_name,new_model,new_serial,quantity)
 SELECT pg_temp.uid(7000,n),'[原 SE 案場]','EQ-V2','EQV'||lpad(n::text,6,'0')||'-AA',1 FROM generate_series(3,9)n;
CREATE FUNCTION pg_temp.pick(serial text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT c FROM jsonb_array_elements(public.search_maintenance_equipment(pg_temp.uid(9000,1)))c WHERE c->>'serial'=serial $$;
CREATE FUNCTION pg_temp.register(n int,serial text,confirmed boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c jsonb:=pg_temp.pick(serial); BEGIN
 RETURN public.register_maintenance_equipment_replacement(pg_temp.uid(6000,n),pg_temp.uid(9000,1),
 (c->>'inventory_serial_id')::uuid,(c->>'se_supply_record_id')::uuid,'2026-08-01T06:20:00Z','V2',c->>'version',confirmed);
END $$;
CREATE FUNCTION pg_temp.correct(event_id uuid,serial text,dt timestamptz DEFAULT '2026-08-02T07:30:00Z',request_id uuid DEFAULT gen_random_uuid()) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c jsonb; e public.maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM public.maintenance_equipment_records WHERE id=event_id;
 SELECT x INTO c FROM jsonb_array_elements(public.search_maintenance_equipment_for_edit(event_id))x WHERE x->>'serial'=serial;
 RETURN public.correct_maintenance_equipment_replacement(request_id,e.id,(c->>'inventory_serial_id')::uuid,
 (c->>'se_supply_record_id')::uuid,dt,'V2 corrected',c->>'version',e.revision,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.uid(8000,1),'quantity',3,'transaction_type','IN','transaction_date',(now() AT TIME ZONE 'Asia/Taipei')::date),'["EQV000001-AA","EQV000002-AA","EQV000003-AA"]');
DO $$
DECLARE a jsonb; b jsonb; original_tx uuid; old_revision bigint; old_candidate jsonb; result jsonb;
BEGIN
 PERFORM pg_temp.ok((pg_temp.pick('EQV000004-AA')->>'eligible')::boolean AND (pg_temp.pick('EQV000004-AA')->>'cross_project')::boolean,'cross-project selectable');
 PERFORM pg_temp.reject($q$SELECT pg_temp.register(1,'EQV000004-AA',false)$q$,'CROSS_PROJECT_CONFIRMATION_REQUIRED');
 a:=pg_temp.register(1,'EQV000004-AA');
 PERFORM pg_temp.ok((SELECT replace_date='2026-08-01' AND project_id IS NULL AND project_name='[原 SE 案場]' FROM se_supply_records WHERE id=pg_temp.uid(7000,4)),'CASE1 confirmed registration preserves SE project');
 PERFORM pg_temp.ok((SELECT changes->'cross_project'->>'cross_project'='true' AND changes->>'cross_project_confirmed'='true' FROM activity_logs WHERE target_id=a->>'id' AND action='REGISTER_MAINTENANCE_EQUIPMENT'),'cross-project audit');
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000005-AA');
 PERFORM pg_temp.ok((SELECT replace_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,4)) AND (SELECT replace_date='2026-08-02' FROM se_supply_records WHERE id=pg_temp.uid(7000,5)),'CASE5 SE A to B restores A');
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000001-AA'); original_tx:=(a->>'inventory_transaction_id')::uuid;
 PERFORM pg_temp.ok(a->>'source_type'='INVENTORY' AND (SELECT replace_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,5)) AND (SELECT status='已出庫' FROM inventory_serials WHERE serial_number='EQV000001-AA'),'CASE7 SE to Inventory');
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000002-AA');
 PERFORM pg_temp.ok((a->>'inventory_transaction_id')::uuid=original_tx AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='EQV000001-AA') AND (SELECT status='已出庫' FROM inventory_serials WHERE serial_number='EQV000002-AA'),'CASE4 canonical Inventory A to B EDIT');
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000006-AA');
 PERFORM pg_temp.ok((SELECT is_voided FROM inventory_transactions WHERE id=original_tx) AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='EQV000002-AA') AND (SELECT replace_date='2026-08-02' FROM se_supply_records WHERE id=pg_temp.uid(7000,6)),'CASE6 Inventory to SE canonical VOID');
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000003-AA');
 PERFORM pg_temp.ok(a->>'source_type'='BOTH' AND (SELECT replace_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,6)) AND (SELECT replace_date='2026-08-02' FROM se_supply_records WHERE id=pg_temp.uid(7000,3)),'SE to BOTH');
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000003-AA','2026-08-03T16:30:00Z');
 PERFORM pg_temp.ok((SELECT replace_date='2026-08-04' FROM se_supply_records WHERE id=pg_temp.uid(7000,3)) AND (SELECT transaction_date=(now() AT TIME ZONE 'Asia/Taipei')::date FROM inventory_transactions WHERE id=(a->>'inventory_transaction_id')::uuid),'CASE9 actual date changes SE, posting stays original');
 original_tx:=(a->>'inventory_transaction_id')::uuid;
 a:=pg_temp.correct((a->>'id')::uuid,'EQV000007-AA');
 PERFORM pg_temp.ok((SELECT is_voided FROM inventory_transactions WHERE id=original_tx) AND (SELECT replace_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,3)) AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='EQV000003-AA'),'BOTH to SE restores both old sources');
 SELECT x INTO old_candidate FROM jsonb_array_elements(search_maintenance_equipment_for_edit((a->>'id')::uuid))x WHERE x->>'serial'='EQV000007-AA';
 old_revision:=(a->>'revision')::bigint;
 b:=correct_maintenance_equipment_replacement(pg_temp.uid(6000,50),(a->>'id')::uuid,NULL,pg_temp.uid(7000,7),'2026-08-05T00:00:00Z','retry',old_candidate->>'version',old_revision,true);
 result:=correct_maintenance_equipment_replacement(pg_temp.uid(6000,50),(a->>'id')::uuid,NULL,pg_temp.uid(7000,7),'2026-08-05T00:00:00Z','retry',old_candidate->>'version',old_revision,true);
 PERFORM pg_temp.ok((result->>'already_corrected')::boolean AND result->>'revision'=b->>'revision','correction retry is idempotent');
 PERFORM pg_temp.reject(format('SELECT correct_maintenance_equipment_replacement(gen_random_uuid(),%L,NULL,%L,now(),NULL,%L,%s,true)',a->>'id',pg_temp.uid(7000,7),old_candidate->>'version',old_revision),'EQUIPMENT_CONFLICT');
 PERFORM pg_temp.ok((SELECT count(*)>=7 FROM activity_logs WHERE target_id=a->>'id' AND action='CORRECT_MAINTENANCE_EQUIPMENT'),'correction audit preserved');
 PERFORM pg_temp.reject($q$UPDATE maintenance_equipment_records SET notes='direct' WHERE false$q$,'permission denied');
 PERFORM pg_temp.reject($q$DELETE FROM maintenance_equipment_records WHERE false$q$,'permission denied');
 PERFORM pg_temp.reject($q$UPDATE se_supply_records SET replace_date=NULL WHERE id=pg_temp.uid(7000,7)$q$,'請從設備維修修改');
 PERFORM pg_temp.ok((SELECT status='完成' FROM schedule_tasks WHERE id=pg_temp.uid(9000,1)),'completed schedule remains independent');
END $$;
RESET ROLE;
-- Editing the current source never bypasses identity/ownership checks.
DO $$ DECLARE e maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,1);
 UPDATE maintenance_equipment_records SET se_replace_owned=false WHERE id=e.id;
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L)',e.id,'EQV000007-AA'),'非本事件持有');
 UPDATE maintenance_equipment_records SET se_replace_owned=true WHERE id=e.id;
 INSERT INTO se_supply_records(id,new_serial,new_model,quantity) VALUES(pg_temp.uid(7000,99),'EQV000007-AA','EQ-V2',1);
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L)',e.id,'EQV000007-AA'),'重複 SE');
 DELETE FROM se_supply_records WHERE id=pg_temp.uid(7000,99);
 PERFORM pg_temp.ok((SELECT revision=e.revision FROM maintenance_equipment_records WHERE id=e.id),'current source ownership and duplicate conflicts remain blocked');
END $$;
-- Fail after canonical mutation, after event relink, and at the final audit boundary.
CREATE FUNCTION pg_temp.fail_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected V2 failure'; END $$;
CREATE TRIGGER v2_inject BEFORE UPDATE ON maintenance_equipment_records FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_v2();
DO $$ DECLARE e maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,1);
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L)',e.id,'EQV000001-AA'),'injected V2 failure');
 PERFORM pg_temp.ok((SELECT status='在庫' FROM inventory_serials WHERE serial_number='EQV000001-AA') AND (SELECT replace_date='2026-08-05' FROM se_supply_records WHERE id=pg_temp.uid(7000,7)) AND (SELECT revision=e.revision FROM maintenance_equipment_records WHERE id=e.id),'CASE8 event failure rolls back canonical OUT');
END $$;
DROP TRIGGER v2_inject ON maintenance_equipment_records;
CREATE TRIGGER v2_inject BEFORE UPDATE ON se_supply_records FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_v2();
DO $$ DECLARE e maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,1);
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L)',e.id,'EQV000001-AA'),'injected V2 failure');
 PERFORM pg_temp.ok((SELECT source_type='SE_SUPPLY' AND revision=e.revision FROM maintenance_equipment_records WHERE id=e.id) AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='EQV000001-AA'),'CASE8 SE failure rolls back event and OUT');
END $$;
DROP TRIGGER v2_inject ON se_supply_records;
CREATE TRIGGER v2_inject BEFORE INSERT ON activity_logs FOR EACH ROW WHEN(NEW.action='CORRECT_MAINTENANCE_EQUIPMENT') EXECUTE FUNCTION pg_temp.fail_v2();
DO $$ DECLARE e maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,1);
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L)',e.id,'EQV000003-AA'),'injected V2 failure');
 PERFORM pg_temp.ok((SELECT revision=e.revision FROM maintenance_equipment_records WHERE id=e.id) AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='EQV000003-AA') AND (SELECT replace_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,3)) AND (SELECT replace_date='2026-08-05' FROM se_supply_records WHERE id=pg_temp.uid(7000,7)),'CASE8 final audit failure rolls back BOTH and old SE');
END $$;
DROP TRIGGER v2_inject ON activity_logs;
-- Simulated closed current posting month: date-only correction must not bypass existing trigger.
SELECT pg_temp.register(2,'EQV000001-AA');
CREATE TRIGGER v2_inject BEFORE INSERT ON activity_logs FOR EACH ROW WHEN(NEW.action='CORRECT_MAINTENANCE_EQUIPMENT') EXECUTE FUNCTION pg_temp.fail_v2();
DO $$ DECLARE e maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,2);
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L)',e.id,'EQV000009-AA'),'injected V2 failure');
 PERFORM pg_temp.ok((SELECT NOT is_voided FROM inventory_transactions WHERE id=e.inventory_transaction_id)
  AND (SELECT status='已出庫' FROM inventory_serials WHERE id=e.inventory_serial_id)
  AND (SELECT replace_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,9))
  AND (SELECT inventory_transaction_id=e.inventory_transaction_id AND revision=1 FROM maintenance_equipment_records WHERE id=e.id),'CASE8 VOID, new SE and event rollback together');
END $$;
DROP TRIGGER v2_inject ON activity_logs;
INSERT INTO inventory_monthly_closings(year,month,status,closed_at,closed_by) VALUES(to_char(now() AT TIME ZONE 'Asia/Taipei','YYYY'),to_char(now() AT TIME ZONE 'Asia/Taipei','MM'),'CLOSED',now(),'V2 test')
ON CONFLICT(year,month) DO UPDATE SET status='CLOSED';
DO $$ DECLARE e maintenance_equipment_records; BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,2);
 PERFORM pg_temp.reject(format('SELECT pg_temp.correct(%L,%L,%L)',e.id,'EQV000001-AA','2026-07-01T00:00:00Z'),'已封存');
 PERFORM pg_temp.ok((SELECT revision=1 AND replaced_at=e.replaced_at FROM maintenance_equipment_records WHERE id=e.id),'CASE9 closed month correction rolled back');
END $$;
SET LOCAL ROLE anon;
SELECT pg_temp.reject($q$SELECT search_maintenance_equipment_for_edit(gen_random_uuid())$q$,'permission denied');
SELECT pg_temp.reject($q$SELECT correct_maintenance_equipment_replacement(gen_random_uuid(),gen_random_uuid(),NULL,NULL,now(),NULL,NULL,1,false)$q$,'permission denied');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL LIMIT 1),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject($q$SELECT correct_maintenance_equipment_replacement(gen_random_uuid(),gen_random_uuid(),NULL,NULL,now(),NULL,NULL,1,false)$q$,'Inventory writes require an active editor');
RESET ROLE;
ROLLBACK;
