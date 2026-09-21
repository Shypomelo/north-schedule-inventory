-- Candidate / disposable LOCAL only. Fixtures and injected failures always roll back.
BEGIN;
SET LOCAL statement_timeout='45s';
CREATE FUNCTION pg_temp.ok(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
CREATE FUNCTION pg_temp.reject(sql text,pattern text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE msg text; BEGIN
 BEGIN EXECUTE sql; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF position(pattern IN msg)>0 THEN RETURN; END IF; RAISE EXCEPTION 'Expected %, got %',pattern,msg;
 END; RAISE EXCEPTION 'Expected error: %',pattern;
END $$;
CREATE FUNCTION pg_temp.uid(kind int,n int) RETURNS uuid LANGUAGE sql AS $$
 SELECT ('78000000-0000-4000-'||kind::text||'-'||lpad(n::text,12,'0'))::uuid $$;
SELECT set_config('test.project',(SELECT id::text FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.other_project',(SELECT id::text FROM projects WHERE deleted_at IS NULL AND id::text<>current_setting('test.project') ORDER BY id LIMIT 1),true);
SELECT set_config('test.editor',(SELECT email FROM team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.viewer',(SELECT email FROM team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial,is_se_maintenance_equipment)
 VALUES(pg_temp.uid(8000,1),'EQ-TEST','EQ-TEST','台','設備維修',0,true,true);
INSERT INTO schedule_tasks(id,title,task_date,task_type,status,project_id,work_group_id)
 SELECT pg_temp.uid(9000,n),'[TEST equipment] '||n,CURRENT_DATE,'維修',CASE WHEN n=2 THEN '完成' ELSE '已排程' END,
 current_setting('test.project'),(SELECT id FROM work_groups ORDER BY id LIMIT 1) FROM generate_series(1,4)n;
INSERT INTO se_supply_records(id,project_id,new_model,new_serial,quantity)
 SELECT pg_temp.uid(7000,n),CASE WHEN n IN(2,9) THEN NULL ELSE current_setting('test.project')::uuid END,'EQ-TEST',
 CASE WHEN n=2 THEN '75SE0002-AA' WHEN n=9 THEN '75SE0009-AA' ELSE 'EQT'||lpad(n::text,6,'0')||'-AA' END,
 CASE WHEN n=13 THEN 2 ELSE 1 END FROM generate_series(2,13)n WHERE n<>7;
UPDATE se_supply_records SET project_id=nullif(current_setting('test.other_project'),'')::uuid WHERE id=pg_temp.uid(7000,8);
-- If the local baseline only has one project, a conflicting name still exercises project rejection.
UPDATE se_supply_records SET project_name='[DIFFERENT PROJECT]' WHERE id=pg_temp.uid(7000,8);
CREATE FUNCTION pg_temp.pick(serial text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT c FROM jsonb_array_elements(public.search_maintenance_equipment(pg_temp.uid(9000,1))) c WHERE c->>'serial'=serial $$;
CREATE FUNCTION pg_temp.register(n int,serial text,task int DEFAULT 1,confirmed boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c jsonb:=pg_temp.pick(serial); BEGIN
 RETURN public.register_maintenance_equipment_replacement(pg_temp.uid(6000,n),pg_temp.uid(9000,task),
 (c->>'inventory_serial_id')::uuid,(c->>'se_supply_record_id')::uuid,'2026-08-01T06:20:00Z','test equipment',c->>'version',confirmed);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.uid(8000,1),'quantity',10,'transaction_type','IN','transaction_date',(now() AT TIME ZONE 'Asia/Taipei')::date),
 (SELECT jsonb_agg('EQT'||lpad(n::text,6,'0')||'-AA') FROM generate_series(1,11)n WHERE n<>2));
DO $$
DECLARE a jsonb; c jsonb; before_out int;
BEGIN
 a:=pg_temp.register(1,'EQT000001-AA');
 PERFORM pg_temp.ok(a->>'source_type'='INVENTORY' AND a->>'inventory_transaction_id' IS NOT NULL,'CASE1 inventory event');
 PERFORM pg_temp.ok((SELECT status='已出庫' FROM inventory_serials WHERE id=(a->>'inventory_serial_id')::uuid),'CASE1 immediate OUT');
 PERFORM pg_temp.ok((SELECT transaction_date=(now() AT TIME ZONE 'Asia/Taipei')::date FROM inventory_transactions WHERE id=(a->>'inventory_transaction_id')::uuid),'historical event posts today');
 PERFORM pg_temp.ok((a->>'replaced_at')::timestamptz='2026-08-01T06:20:00Z','historical event time retained');
 PERFORM pg_temp.ok((SELECT status='已排程' FROM schedule_tasks WHERE id=pg_temp.uid(9000,1)),'CASE6 ongoing status unchanged');
 SELECT count(*) INTO before_out FROM inventory_transactions WHERE schedule_task_id=pg_temp.uid(9000,1);
 a:=pg_temp.register(2,'75SE0002-AA');
 PERFORM pg_temp.ok(a->>'source_type'='SE_SUPPLY' AND a->>'inventory_transaction_id' IS NULL,'CASE2 SE-only event');
 PERFORM pg_temp.ok((SELECT replace_date='2026-08-01' AND procurement_status='ORDERED' AND received_at IS NULL AND receive_date IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,2)),'CASE2 replace only, no fake receipt');
 PERFORM pg_temp.ok((SELECT count(*)=before_out FROM inventory_transactions WHERE schedule_task_id=pg_temp.uid(9000,1)),'CASE2 no OUT');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM jsonb_array_elements(public.search_maintenance_equipment(pg_temp.uid(9000,1)))candidate_row WHERE candidate_row->>'serial'='EQT000003-AA'),'CASE3 BOTH dedupe');
 a:=pg_temp.register(3,'EQT000003-AA');
 PERFORM pg_temp.ok(a->>'source_type'='BOTH' AND (SELECT replace_date IS NOT NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,3)),'CASE3 BOTH success');
 a:=pg_temp.register(7,'EQT000007-AA',2);
 PERFORM pg_temp.ok((SELECT status='完成' FROM schedule_tasks WHERE id=pg_temp.uid(9000,2)),'CASE7 completed supplement');
 PERFORM pg_temp.reject($q$SELECT pg_temp.register(8,'EQT000008-AA',1,false)$q$,'CROSS_PROJECT_CONFIRMATION_REQUIRED');
 a:=pg_temp.register(9,'75SE0009-AA');
 PERFORM pg_temp.ok((SELECT project_id IS NULL FROM se_supply_records WHERE id=pg_temp.uid(7000,9)),'CASE9 original project preserved');
 c:=pg_temp.pick('EQT000010-AA');
 PERFORM public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.uid(8000,1),'quantity',1,'transaction_type','OUT','transaction_date',(now() AT TIME ZONE 'Asia/Taipei')::date,'project_id',current_setting('test.project')),'["EQT000010-AA"]');
 PERFORM pg_temp.ok(NOT (pg_temp.pick('EQT000010-AA')->>'eligible')::boolean,'CASE10 no SE fallback');
 PERFORM pg_temp.reject($q$SELECT pg_temp.register(10,'EQT000010-AA')$q$,'EQUIPMENT_CONFLICT');
 a:=pg_temp.register(11,'EQT000011-AA');
 a:=public.register_maintenance_equipment_replacement(pg_temp.uid(6000,11),pg_temp.uid(9000,1),(a->>'inventory_serial_id')::uuid,(a->>'se_supply_record_id')::uuid,'2026-08-01T06:20:00Z','test equipment',NULL,true);
 PERFORM pg_temp.ok((a->>'already_registered')::boolean AND (SELECT count(*)=1 FROM maintenance_equipment_records WHERE request_id=pg_temp.uid(6000,11)),'CASE11 idempotency');
 PERFORM pg_temp.reject($q$SELECT public.register_maintenance_equipment_replacement(pg_temp.uid(6000,11),pg_temp.uid(9000,1),NULL,NULL,now(),'different',NULL)$q$,'request_id');
 PERFORM pg_temp.ok(NOT (pg_temp.pick('EQT000013-AA')->>'eligible')::boolean,'CASE13 multi-unit conflict');
 PERFORM pg_temp.reject($q$SELECT pg_temp.register(13,'EQT000013-AA')$q$,'EQUIPMENT_CONFLICT');
 PERFORM pg_temp.reject($q$UPDATE maintenance_equipment_records SET notes='bad' WHERE false$q$,'permission denied');
 PERFORM pg_temp.reject($q$SELECT complete_maintenance_with_inventory_usage(pg_temp.uid(9000,3),'[]')$q$,'permission denied');
END $$;
RESET ROLE;
-- Source-resolution regressions: no fuzzy identity merge and stale labels must conflict.
DO $$
DECLARE c jsonb:=pg_temp.pick('EQT000004-AA');
BEGIN
 UPDATE inventory_items SET name='Changed display identity' WHERE id=pg_temp.uid(8000,1);
 PERFORM pg_temp.reject(format('SELECT public.register_maintenance_equipment_replacement(%L,%L,%L,%L,%L,%L,%L)',
  pg_temp.uid(6000,20),pg_temp.uid(9000,1),c->>'inventory_serial_id',c->>'se_supply_record_id','2026-08-01T06:20:00Z','test equipment',c->>'version'),'來源已更新');
 UPDATE inventory_items SET name='EQ-TEST' WHERE id=pg_temp.uid(8000,1);
 INSERT INTO se_supply_records(id,new_serial,new_model) VALUES(pg_temp.uid(7000,20),'eqt000004-aa','EQ-TEST');
 PERFORM pg_temp.ok(NOT (pg_temp.pick('EQT000004-AA')->>'eligible')::boolean,'duplicate SE identity blocked');
 DELETE FROM se_supply_records WHERE id=pg_temp.uid(7000,20);
 UPDATE se_supply_records SET new_model='DIFFERENT-MODEL' WHERE id=pg_temp.uid(7000,4);
 PERFORM pg_temp.ok(NOT (pg_temp.pick('EQT000004-AA')->>'eligible')::boolean,'model conflict blocked');
 UPDATE se_supply_records SET new_model='EQ-TEST',inventory_serial_id=(c->>'inventory_serial_id')::uuid,new_serial='LEGACY8B-AA' WHERE id=pg_temp.uid(7000,4);
 PERFORM pg_temp.ok((pg_temp.pick('EQT000004-AA')->>'eligible')::boolean,'reviewed FK resolves an alternate legacy serial');
 UPDATE se_supply_records SET inventory_serial_id=NULL,new_serial='EQT000004-AA' WHERE id=pg_temp.uid(7000,4);
 UPDATE inventory_items SET is_se_maintenance_equipment=false WHERE id=pg_temp.uid(8000,1);
 PERFORM pg_temp.ok(NOT (pg_temp.pick('EQT000004-AA')->>'eligible')::boolean,'unmarked inventory cannot fall back to SE');
 UPDATE inventory_items SET is_se_maintenance_equipment=true WHERE id=pg_temp.uid(8000,1);
END $$;
-- Fail canonical OUT (CASE4), then a SE update AFTER successful OUT (CASE5), then final event/audit.
CREATE FUNCTION pg_temp.inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='inventory_transactions' THEN
  IF NEW.source='設備維修更換' AND current_setting('test.failure',true)='inventory' THEN RAISE EXCEPTION 'test inventory failure'; END IF;
 END IF;
 IF TG_TABLE_NAME='se_supply_records' AND current_setting('test.failure',true)='se' THEN RAISE EXCEPTION 'test SE failure'; END IF;
 IF TG_TABLE_NAME='maintenance_equipment_records' AND current_setting('test.failure',true)='event' THEN RAISE EXCEPTION 'test event failure'; END IF;
 IF TG_TABLE_NAME='activity_logs' AND current_setting('test.failure',true)='audit' THEN
  IF NEW.target_type='MaintenanceEquipmentRecord' THEN RAISE EXCEPTION 'test final audit failure'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER equipment_test_inventory BEFORE INSERT ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_failure();
CREATE TRIGGER equipment_test_se BEFORE UPDATE ON se_supply_records FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_failure();
CREATE TRIGGER equipment_test_event BEFORE INSERT ON maintenance_equipment_records FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_failure();
CREATE TRIGGER equipment_test_audit BEFORE INSERT ON activity_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_failure();
SET LOCAL ROLE authenticated;
SELECT set_config('test.failure','inventory',true);
SELECT pg_temp.reject($q$SELECT pg_temp.register(4,'EQT000004-AA')$q$,'test inventory failure');
SELECT set_config('test.failure','se',true);
SELECT pg_temp.reject($q$SELECT pg_temp.register(5,'EQT000005-AA')$q$,'test SE failure');
SELECT set_config('test.failure','event',true);
SELECT pg_temp.reject($q$SELECT pg_temp.register(6,'EQT000006-AA')$q$,'test event failure');
SELECT set_config('test.failure','audit',true);
SELECT pg_temp.reject($q$SELECT pg_temp.register(6,'EQT000006-AA')$q$,'test final audit failure');
SELECT set_config('test.failure','',true);
SELECT pg_temp.ok((SELECT count(*)=3 FROM inventory_serials WHERE serial_number IN('EQT000004-AA','EQT000005-AA','EQT000006-AA') AND status='在庫' AND project_id IS NULL),'failures roll back serial OUT');
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM maintenance_equipment_records WHERE request_id IN(pg_temp.uid(6000,4),pg_temp.uid(6000,5),pg_temp.uid(6000,6))) AND NOT EXISTS(SELECT 1 FROM se_supply_records WHERE id IN(pg_temp.uid(7000,4),pg_temp.uid(7000,5),pg_temp.uid(7000,6)) AND replace_date IS NOT NULL),'failures roll back SE and event');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.viewer'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject($q$SELECT pg_temp.register(12,'EQT000012-AA')$q$,'active editor');
SELECT pg_temp.ok((SELECT count(*)>0 FROM maintenance_equipment_records WHERE schedule_task_id=pg_temp.uid(9000,1)),'Viewer can read records via RLS');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.reject($q$SELECT search_maintenance_equipment(pg_temp.uid(9000,1))$q$,'permission denied');
SELECT pg_temp.reject($q$SELECT * FROM maintenance_equipment_records$q$,'permission denied');
RESET ROLE;
SELECT 'PASS equipment SQL/RLS CASE1-13, historical posting, source dedupe, request mismatch and late-stage rollback' AS result;
ROLLBACK;
