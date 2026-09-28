-- LOCAL / verified Candidate only. Every fixture and injected failure rolls back.
BEGIN;
SET LOCAL statement_timeout='45s';
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.reject(q text,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PASS: % rejected (%)',label,SQLERRM; RETURN; END; RAISE EXCEPTION 'FAIL: % did not reject',label; END $$;
CREATE FUNCTION pg_temp.id(n integer) RETURNS uuid LANGUAGE sql AS $$ SELECT ('82000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
SELECT set_config('test.editor',(SELECT email FROM team_members WHERE role='engineer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.admin',(SELECT email FROM team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.viewer',(SELECT email FROM team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.project',(SELECT id::text FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial,is_se_maintenance_equipment)
VALUES(pg_temp.id(1),'[TEST] SE10000H','[TEST] equipment','台','設備維修',0,true,true),
(pg_temp.id(2),'[TEST] material','[TEST] material','個','一般',0,false,false),
(pg_temp.id(3),'[TEST] other','[TEST] other','台','設備維修',0,true,true);
INSERT INTO schedule_tasks(id,title,task_date,task_type,status,project_id,work_group_id)
VALUES(pg_temp.id(4),'[TEST receiving] maintenance',current_date,'維修','已排程',current_setting('test.project'),(SELECT id FROM work_groups ORDER BY id LIMIT 1));
CREATE FUNCTION pg_temp.arrival(n integer,item integer,qty numeric,serials jsonb DEFAULT '[]') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN r:=public.create_office_equipment_arrival(pg_temp.id(n),pg_temp.id(item),qty,now(),NULL,'[TEST receiving]',serials); RETURN (r->>'id')::uuid; END $$;
CREATE FUNCTION pg_temp.receive(n integer,source uuid,item integer,qty numeric,names text[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.confirm_receiving_into_inventory(pg_temp.id(n),'SE_SUPPLY',source,pg_temp.id(item),qty,
 COALESCE((SELECT array_agg(id ORDER BY normalized_serial) FROM receiving_serial_entries WHERE se_supply_record_id=source AND normalized_serial=ANY(names)),'{}'),now(),'[TEST receiving]') $$;
CREATE FUNCTION pg_temp.balance(item integer) RETURNS numeric LANGUAGE sql AS $$ SELECT opening_quantity+COALESCE((SELECT sum(CASE transaction_type WHEN 'OUT' THEN -quantity ELSE quantity END) FROM inventory_transactions WHERE item_id=i.id AND NOT is_voided AND excluded_by_initialization_id IS NULL),0) FROM inventory_items i WHERE id=pg_temp.id(item) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE source uuid; receipt jsonb; r2 jsonb; before_balance numeric; entry_ids uuid[]; c jsonb; se jsonb; serial_id uuid; material_id uuid; batch uuid;
BEGIN
 PERFORM pg_temp.ok(classify_inventory_serial_format('RIT00001-AA')='exact','FORMAT-1 8+2 exact');
 PERFORM pg_temp.ok(classify_inventory_serial_format('0306856C0-AE')='short' AND classify_inventory_serial_format('SJ1823A-0306856C0-AE')='full','FORMAT-2 9+2/full unchanged');
 source:=pg_temp.arrival(10,2,5);
 receipt:=pg_temp.receive(11,source,2,3);
 PERFORM pg_temp.ok(pg_temp.balance(2)=3 AND (receipt->>'quantity_received')::numeric=3,'RECEIVE-1 plain IN+RECEIVE');
 PERFORM pg_temp.ok((SELECT procurement_status='PARTIAL_RECEIVED' FROM se_supply_records WHERE id=source),'RECEIVE-6 partial projection');
 r2:=pg_temp.receive(11,source,2,3);
 PERFORM pg_temp.ok(r2=receipt AND pg_temp.balance(2)=3,'RECEIVE-7 same request idempotent');
 source:=pg_temp.arrival(20,1,5,'["RIT00001-AA","RIT00002-AA","EQR000001-AA"]');
 PERFORM pg_temp.ok(pg_temp.balance(1)=0 AND (SELECT count(*)=0 FROM inventory_serials WHERE item_id=pg_temp.id(1)),'pending serials have zero stock effects');
 receipt:=pg_temp.receive(21,source,1,3,ARRAY['RIT00001-AA','RIT00002-AA','EQR000001-AA']);
 PERFORM pg_temp.ok(pg_temp.balance(1)=3 AND (SELECT count(*)=3 FROM receiving_serial_entries WHERE active_receipt_id=(receipt->>'id')::uuid),'RECEIVE-2/6 three new identities, partial 3/5');
 PERFORM pg_temp.reject(format('SELECT pg_temp.receive(22,%L,1,2,ARRAY[''RIT00001-AA''])',source),'serial count mismatch');
 -- Existing stock created by the released canonical writer, not this receipt.
 PERFORM write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(1),'transaction_type','IN','quantity',1,'transaction_date',current_date),'["EXIST001-AA"]');
 source:=pg_temp.arrival(30,1,1,'["EXIST001-AA"]');
 before_balance:=pg_temp.balance(1); r2:=pg_temp.receive(31,source,1,1,ARRAY['EXIST001-AA']);
 PERFORM pg_temp.ok(pg_temp.balance(1)=before_balance AND r2->>'inventory_transaction_id' IS NULL AND (SELECT linked_existing FROM material_receipt_serials WHERE receipt_id=(r2->>'id')::uuid),'RECEIVE-3 existing same-item stock does not double IN');
 PERFORM pg_temp.reject($q$SELECT pg_temp.arrival(32,1,1,'["EXIST001-AA"]')$q$,'existing identity cannot be claimed twice');
 -- OUT identity is not new incoming stock.
 PERFORM write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(1),'transaction_type','IN','quantity',1,'transaction_date',current_date),'["ISSUED01-AA"]');
 PERFORM write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(1),'transaction_type','OUT','quantity',1,'transaction_date',current_date,'project_id',current_setting('test.project')),'["ISSUED01-AA"]');
 source:=pg_temp.arrival(40,1,1,'["ISSUED01-AA"]');
 PERFORM pg_temp.reject(format('SELECT pg_temp.receive(41,%L,1,1,ARRAY[''ISSUED01-AA''])',source),'RECEIVE-4 outgoing rejected');
 PERFORM write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',pg_temp.id(3),'transaction_type','IN','quantity',1,'transaction_date',current_date),'["OTHER001-AA"]');
 source:=pg_temp.arrival(50,1,1,'["OTHER001-AA"]');
 PERFORM pg_temp.reject(format('SELECT pg_temp.receive(51,%L,1,1,ARRAY[''OTHER001-AA''])',source),'RECEIVE-5 other item rejected');
 -- Partial correction removes exactly the selected new serial.
 SELECT array_agg(entry_id) INTO entry_ids FROM material_receipt_serials WHERE receipt_id=(receipt->>'id')::uuid AND inventory_serial_id=(SELECT id FROM inventory_serials WHERE serial_number='EQR000001-AA');
 PERFORM correct_receiving_inventory(pg_temp.id(60),(receipt->>'id')::uuid,1,entry_ids,now(),'[TEST] partial correction');
 PERFORM pg_temp.ok((SELECT status='作廢' FROM inventory_serials WHERE serial_number='EQR000001-AA') AND pg_temp.balance(1)=3,'CORRECT-2 exact serial correction');
 -- Reserve first remaining device and consume via matching maintenance only.
 SELECT id INTO serial_id FROM inventory_serials WHERE serial_number='RIT00001-AA';
 before_balance:=pg_temp.balance(1);
 se:=reserve_inventory_for_se(pg_temp.id(70),serial_id,current_setting('test.project')::uuid);
 PERFORM pg_temp.ok(pg_temp.balance(1)=before_balance AND (SELECT status='在庫' FROM inventory_serials WHERE id=serial_id),'SE-1 reserve without OUT');
 PERFORM pg_temp.reject(format('SELECT write_inventory_transaction_atomic(''CREATE'',%L::jsonb,''["RIT00001-AA"]'')',jsonb_build_object('item_id',pg_temp.id(1),'transaction_type','OUT','quantity',1,'transaction_date',current_date,'project_id',current_setting('test.project'))),'SE-2 ordinary OUT blocked');
 SELECT x INTO c FROM jsonb_array_elements(search_maintenance_equipment(pg_temp.id(4))) x WHERE (x->>'se_supply_record_id')::uuid=(se->>'id')::uuid;
 PERFORM register_maintenance_equipment_replacement(pg_temp.id(71),pg_temp.id(4),serial_id,(se->>'id')::uuid,now(),'[TEST]',c->>'version',false);
 PERFORM pg_temp.ok(pg_temp.balance(1)=before_balance-1,'SE-3 matching maintenance performs OUT');
 SELECT array_agg(entry_id) INTO entry_ids FROM material_receipt_serials WHERE receipt_id=(receipt->>'id')::uuid AND inventory_serial_id=serial_id;
 PERFORM pg_temp.reject(format('SELECT correct_receiving_inventory(%L,%L,1,%L,now(),''downstream'')',pg_temp.id(72),receipt->>'id',entry_ids),'CORRECT-3 downstream OUT rejected');
 SELECT id INTO serial_id FROM inventory_serials WHERE serial_number='RIT00002-AA';
 se:=reserve_inventory_for_se(pg_temp.id(73),serial_id,NULL);
 PERFORM cancel_se_inventory_reservation((se->>'id')::uuid,(se->>'updated_at')::timestamptz);
 PERFORM pg_temp.ok((SELECT status='在庫' FROM inventory_serials WHERE id=serial_id),'SE-4 cancellation keeps stock');
 -- New material and explicit existing SITE requirement.
 r2:=deliver_inventory_to_project(pg_temp.id(80),pg_temp.id(2),current_setting('test.project')::uuid,1,'{}',NULL,true,now(),'[TEST] project');
 material_id:=(r2->>'project_material_id')::uuid;
 PERFORM pg_temp.ok(pg_temp.balance(2)=2 AND r2->>'receipt_location'='SITE' AND (SELECT procurement_status='RECEIVED' AND delivery_destination='SITE' FROM project_materials WHERE id=material_id),'PROJECT-2 new material + OUT + SITE');
 INSERT INTO project_material_batches(project_id,batch_name,created_by) VALUES(current_setting('test.project')::uuid,'[TEST] routing',app_private.current_member_id()) RETURNING id INTO batch;
 INSERT INTO project_materials(project_id,batch_id,item_name,quantity,unit,created_by,delivery_destination,inventory_item_id) VALUES(current_setting('test.project')::uuid,batch,'[TEST] existing',2,'個',app_private.current_member_id(),'SITE',pg_temp.id(2)) RETURNING id INTO material_id;
 r2:=deliver_inventory_to_project(pg_temp.id(81),pg_temp.id(2),current_setting('test.project')::uuid,1,'{}',material_id,false,now(),'[TEST] existing');
 PERFORM pg_temp.ok(pg_temp.balance(2)=1 AND (SELECT procurement_status='PARTIAL_RECEIVED' FROM project_materials WHERE id=material_id),'PROJECT-1 existing requirement receives partial');
 PERFORM pg_temp.reject(format('SELECT deliver_inventory_to_project(%L,%L,%L,1,''{}'',NULL,false,now())',pg_temp.id(82),pg_temp.id(2),current_setting('test.project')),'PROJECT-3 explicit selection required');
 PERFORM pg_temp.reject(format('SELECT write_inventory_transaction_atomic(''VOID'',''{}'',''[]'',%L,''bypass'')',r2->>'inventory_transaction_id'),'linked transaction cannot bypass receipt correction');
END $$;
DO $$
DECLARE e public.maintenance_equipment_records; s uuid; se jsonb; candidate jsonb; result jsonb; old_balance numeric;
BEGIN
 SELECT * INTO e FROM maintenance_equipment_records WHERE schedule_task_id=pg_temp.id(4);
 SELECT id INTO s FROM inventory_serials WHERE serial_number='RIT00002-AA';
 old_balance:=pg_temp.balance(1);
 se:=reserve_inventory_for_se(pg_temp.id(90),s,current_setting('test.project')::uuid);
 SELECT c INTO candidate FROM jsonb_array_elements(search_maintenance_equipment_for_edit(e.id)) c WHERE (c->>'se_supply_record_id')::uuid=(se->>'id')::uuid;
 result:=correct_maintenance_equipment_replacement(pg_temp.id(91),e.id,s,(se->>'id')::uuid,now(),'[TEST] reserved replacement correction',candidate->>'version',e.revision,false);
 PERFORM pg_temp.ok(pg_temp.balance(1)=old_balance AND (SELECT status='已出庫' FROM inventory_serials WHERE id=s) AND (SELECT status='在庫' FROM inventory_serials WHERE id=e.inventory_serial_id),'SE correction reuses canonical swap, no second OUT quantity');
 SELECT to_jsonb(r) INTO se FROM se_supply_records r WHERE id=e.se_supply_record_id;
 SELECT id INTO s FROM inventory_serials WHERE serial_number='EXIST001-AA';
 result:=change_se_inventory_reservation((se->>'id')::uuid,s,(se->>'updated_at')::timestamptz);
 PERFORM pg_temp.ok((SELECT NOT EXISTS(SELECT 1 FROM se_supply_records WHERE inventory_serial_id=e.inventory_serial_id AND replace_date IS NULL AND cancelled_at IS NULL AND NOT receiving_only)),'SE edit releases the original serial reservation');
 PERFORM cancel_se_inventory_reservation((result->>'id')::uuid,(result->>'updated_at')::timestamptz);
END $$;
RESET ROLE;
CREATE FUNCTION pg_temp.fail_receiving() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('test.fail_receiving',true)='yes' THEN RAISE EXCEPTION 'INJECTED_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER receiving_test_failure AFTER INSERT ON public.material_receipts FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_receiving();
SET LOCAL ROLE authenticated;
DO $$
DECLARE source uuid; receipt jsonb; ids uuid[]; before_balance numeric; before_tx bigint; before_serial bigint; before_receipt bigint; before_material bigint;
BEGIN
 -- A serial created before the failing RECEIVE must disappear with its IN.
 source:=pg_temp.arrival(100,1,1,'["ROLLBACK-AA"]');
 SELECT count(*) INTO before_tx FROM inventory_transactions; SELECT count(*) INTO before_serial FROM inventory_serials; SELECT count(*) INTO before_receipt FROM material_receipts;
 PERFORM set_config('test.fail_receiving','yes',true);
 PERFORM pg_temp.reject(format('SELECT pg_temp.receive(101,%L,1,1,ARRAY[''ROLLBACK-AA''])',source),'RECEIVE-8 injected failure');
 PERFORM set_config('test.fail_receiving','no',true);
 PERFORM pg_temp.ok((SELECT count(*)=before_tx FROM inventory_transactions) AND (SELECT count(*)=before_serial FROM inventory_serials) AND (SELECT count(*)=before_receipt FROM material_receipts),'RECEIVE-8 all stock/serial/receipt effects rolled back');
 receipt:=pg_temp.receive(101,source,1,1,ARRAY['ROLLBACK-AA']);
 -- Editor cannot acquire global ADMIN IN-void permission through Receiving.
 SELECT array_agg(id) INTO ids FROM receiving_serial_entries WHERE active_receipt_id=(receipt->>'id')::uuid;
 PERFORM pg_temp.reject(format('SELECT correct_receiving_inventory(%L,%L,1,%L,now(),''full'')',pg_temp.id(102),receipt->>'id',ids),'CORRECT permission boundary');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.admin'),'role','authenticated')::text,true);
 PERFORM correct_receiving_inventory(pg_temp.id(103),(receipt->>'id')::uuid,1,ids,now(),'[TEST] full');
 PERFORM pg_temp.ok((SELECT is_voided FROM inventory_transactions WHERE id=(receipt->>'inventory_transaction_id')::uuid) AND (SELECT status='作廢' FROM inventory_serials WHERE serial_number='ROLLBACK-AA') AND (SELECT count(*)=1 FROM material_receipts WHERE reversal_of_id=(receipt->>'id')::uuid),'CORRECT-1 full reversal preserves both histories');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor'),'role','authenticated')::text,true);
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM receiving_serial_entries WHERE se_supply_record_id=source AND retired_at IS NOT NULL),'corrected void serial releases pending capacity without deleting history');
 PERFORM register_receiving_serial('SE_SUPPLY',source,pg_temp.id(1),'RIT00005-AA');
 PERFORM pg_temp.receive(108,source,1,1,ARRAY['RIT00005-AA']);
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM receiving_serial_entries WHERE se_supply_record_id=source AND active_receipt_id IS NOT NULL),'corrected receipt can receive the actual replacement device');
 -- Existing-only correction leaves its independently created stock untouched.
 SELECT to_jsonb(r) INTO receipt FROM material_receipts r JOIN material_receipt_serials l ON l.receipt_id=r.id JOIN inventory_serials s ON s.id=l.inventory_serial_id WHERE s.serial_number='EXIST001-AA' AND r.event_type='RECEIVE';
 SELECT array_agg(id) INTO ids FROM receiving_serial_entries WHERE active_receipt_id=(receipt->>'id')::uuid;
 before_balance:=pg_temp.balance(1);
 PERFORM correct_receiving_inventory(pg_temp.id(104),(receipt->>'id')::uuid,1,ids,now(),'[TEST] undo link only');
 PERFORM pg_temp.ok(pg_temp.balance(1)=before_balance AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='EXIST001-AA'),'legacy link reversal does not subtract pre-existing stock');
 -- An injected SITE receipt failure must roll back OUT, batch and material creation.
 SELECT count(*) INTO before_tx FROM inventory_transactions; SELECT count(*) INTO before_material FROM project_materials; SELECT count(*) INTO before_receipt FROM material_receipts;
 before_balance:=pg_temp.balance(2);
 PERFORM set_config('test.fail_receiving','yes',true);
 PERFORM pg_temp.reject(format('SELECT deliver_inventory_to_project(%L,%L,%L,1,''{}'',NULL,true,now())',pg_temp.id(105),pg_temp.id(2),current_setting('test.project')),'PROJECT-4 injected SITE failure');
 PERFORM set_config('test.fail_receiving','no',true);
 PERFORM pg_temp.ok(pg_temp.balance(2)=before_balance AND (SELECT count(*)=before_tx FROM inventory_transactions) AND (SELECT count(*)=before_material FROM project_materials) AND (SELECT count(*)=before_receipt FROM material_receipts),'PROJECT-4 OUT/material/receipt rollback');
 PERFORM pg_temp.reject($q$SELECT pg_temp.arrival(106,1,2,'["DUPL0001-AA","dupl0001-aa"]')$q$,'duplicate normalized arrival identities');
 PERFORM pg_temp.ok(NOT has_table_privilege('authenticated','public.receiving_serial_entries','INSERT') AND NOT has_table_privilege('authenticated','public.material_receipt_serials','DELETE'),'RLS direct identity/audit mutation unavailable');
 PERFORM pg_temp.ok(NOT has_function_privilege('authenticated','app_private.write_inventory_transaction_before_routing(text,jsonb,jsonb,uuid,text,timestamptz)','EXECUTE'),'RLS private writer cannot bypass routing');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.viewer'),'role','authenticated')::text,true);
 PERFORM pg_temp.reject($q$SELECT pg_temp.arrival(107,2,1)$q$,'RLS viewer cannot create arrival');
 PERFORM pg_temp.reject(format('SELECT cancel_se_inventory_reservation(%L,now())',pg_temp.id(1)),'RLS viewer cannot cancel reservation');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor'),'role','authenticated')::text,true);
END $$;
-- A failure after the Inventory EDIT must roll the serial status and quantity back.
DO $$
DECLARE source uuid; receipt jsonb; ids uuid[];
BEGIN
 source:=pg_temp.arrival(110,1,2,'["RIT00003-AA","RIT00004-AA"]');
 receipt:=pg_temp.receive(111,source,1,2,ARRAY['RIT00003-AA','RIT00004-AA']);
 SELECT array_agg(id) INTO ids FROM receiving_serial_entries WHERE active_receipt_id=(receipt->>'id')::uuid AND normalized_serial='RIT00003-AA';
 PERFORM set_config('test.fail_receiving','yes',true);
 PERFORM pg_temp.reject(format('SELECT correct_receiving_inventory(%L,%L,1,%L,now(),''rollback correction'')',pg_temp.id(112),receipt->>'id',ids),'CORRECT injected failure after Inventory EDIT');
 PERFORM set_config('test.fail_receiving','no',true);
 PERFORM pg_temp.ok((SELECT quantity=2 FROM inventory_transactions WHERE id=(receipt->>'inventory_transaction_id')::uuid) AND (SELECT status='在庫' FROM inventory_serials WHERE serial_number='RIT00003-AA') AND NOT EXISTS(SELECT 1 FROM material_receipts WHERE reversal_of_id=(receipt->>'id')::uuid),'CORRECT rollback restores quantity/serial/audit consistency');
END $$;
RESET ROLE;
ROLLBACK;
