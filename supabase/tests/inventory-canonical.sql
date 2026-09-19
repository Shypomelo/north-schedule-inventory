-- Migrated Candidate or disposable local database only. All fixtures roll back.
BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.expect_error(statement text, expected text, expected_code text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text; error_code text;
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS message=MESSAGE_TEXT,error_code=RETURNED_SQLSTATE;
    IF expected_code IS NOT NULL AND error_code<>expected_code THEN RAISE EXCEPTION 'Wrong SQLSTATE: expected %, got %',expected_code,error_code; END IF;
    IF position(expected IN message)>0 THEN RAISE NOTICE 'PASS rejected: %',expected; RETURN; END IF;
    RAISE EXCEPTION 'Wrong error: expected %, got %',expected,message;
  END;
  RAISE EXCEPTION 'Expected rejection: %',expected;
END $$;
CREATE FUNCTION pg_temp.payload(item uuid,kind text,qty numeric) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('item_id',item,'transaction_type',kind,'quantity',qty,'transaction_date','2099-01-15',
  'project_id',current_setting('test.project_id'),'notes','[TEST inventory canonical]','handler','Fixture') $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
SELECT set_config('test.editor_email',(SELECT email FROM public.team_members WHERE is_active AND deleted_at IS NULL AND lower(role)='engineer' ORDER BY id LIMIT 1),true);
SELECT set_config('test.admin_email',(SELECT email FROM public.team_members WHERE is_active AND deleted_at IS NULL AND lower(role)='admin' ORDER BY id LIMIT 1),true);
SELECT set_config('test.viewer_email',(SELECT email FROM public.team_members WHERE is_active AND deleted_at IS NULL AND lower(role)='viewer' ORDER BY id LIMIT 1),true);
SELECT set_config('test.project_id',(SELECT id::text FROM public.projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,opening_quantity) VALUES
('72000000-0000-4000-8000-000000000001','TEST-CANON-1','[TEST] ordinary','個','設備維修',false,5),
('72000000-0000-4000-8000-000000000002','TEST-CANON-2','[TEST] counted','個','設備維修',false,5),
('72000000-0000-4000-8000-000000000003','TEST-CANON-3','[TEST] serial','個','設備維修',true,0),
('72000000-0000-4000-8000-000000000004','TEST-CANON-4','[TEST] parity','米','設備維修',false,10);
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor_email'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE tx jsonb; receipt jsonb; ret jsonb; edited jsonb; baseline_serial jsonb; baseline_links jsonb; pending_link uuid; registered jsonb; BEGIN
  tx:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','OUT',4));
  PERFORM pg_temp.assert_true((tx->>'quantity')::numeric=4 AND tx->>'project_id'=current_setting('test.project_id'),'OUT fields/project');
  PERFORM set_config('test.out_id',tx->>'id',true);
  PERFORM pg_temp.expect_error($q$UPDATE public.inventory_items SET opening_quantity=0 WHERE id='72000000-0000-4000-8000-000000000001'$q$,'INSUFFICIENT_INVENTORY');
  PERFORM pg_temp.expect_error($q$UPDATE public.inventory_items SET opening_quantity='NaN'::numeric WHERE id='72000000-0000-4000-8000-000000000001'$q$,'Invalid opening');
  PERFORM pg_temp.expect_error($q$INSERT INTO public.inventory_items(code,name,unit,category,opening_quantity) VALUES('TEST-INVALID','[TEST] invalid','個','設備維修',-1)$q$,'negative opening');
  PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','OUT',6))$q$,'INSUFFICIENT_INVENTORY');
  PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','ADJUST',-5)||'{"counted_quantity":0,"expected_balance":5}'::jsonb)$q$,'STALE_INVENTORY','PT409');
  tx:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000002','ADJUST',999)||'{"counted_quantity":0,"expected_balance":5}'::jsonb);
  PERFORM pg_temp.assert_true((tx->>'quantity')::numeric=-5,'ADJUST computed in DB, ignores client delta');
  tx:=public.write_inventory_transaction_atomic('EDIT',pg_temp.payload('72000000-0000-4000-8000-000000000002','ADJUST',999)||'{"counted_quantity":2,"expected_balance":0}'::jsonb,'[]', (tx->>'id')::uuid,'recount',(tx->>'updated_at')::timestamptz);
  PERFORM pg_temp.assert_true((tx->>'quantity')::numeric=-3,'ADJUST edit removes old contribution');
  PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','OUT',1)-'project_id')$q$,'Valid project');
  receipt:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','IN',2),'["TEST00001-AA","TEST00002-AA"]');
  PERFORM set_config('test.receipt_id',receipt->>'id',true);
  tx:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1),'["TEST00001-AA"]');
  PERFORM pg_temp.assert_true((SELECT status='已出庫' AND project_id::text=current_setting('test.project_id') FROM public.inventory_serials WHERE serial_number='TEST00001-AA'),'Serial OUT status/project');
  PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1),'["TEST00001-AA"]')$q$,'Serial is not available');
  -- Edit restores old serial inside its transaction, then a new invalid serial fails: rollback all.
  SELECT to_jsonb(s) INTO baseline_serial FROM public.inventory_serials s WHERE serial_number='TEST00001-AA';
  SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO baseline_links FROM public.inventory_transaction_serials l WHERE transaction_id=(tx->>'id')::uuid;
  PERFORM pg_temp.expect_error(format('SELECT public.write_inventory_transaction_atomic(''EDIT'',%L::jsonb,''["MISSING01-AA"]'',%L::uuid,''bad serial'')',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1),tx->>'id'),'Serial not found');
  PERFORM pg_temp.assert_true(baseline_serial=(SELECT to_jsonb(s) FROM public.inventory_serials s WHERE serial_number='TEST00001-AA') AND baseline_links=(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.inventory_transaction_serials l WHERE transaction_id=(tx->>'id')::uuid),'Edit failure rolls back restored status and links');
  edited:=public.write_inventory_transaction_atomic('EDIT',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1),'["TEST00002-AA"]',(tx->>'id')::uuid,'swap',(tx->>'updated_at')::timestamptz);
  PERFORM pg_temp.assert_true((SELECT status='在庫' FROM public.inventory_serials WHERE serial_number='TEST00001-AA'),'Edit releases old serial only at commit');
  PERFORM pg_temp.assert_true(EXISTS(SELECT 1 FROM public.activity_logs a WHERE a.target_id=edited->>'id' AND a.action_type='UPDATE_TRANSACTION'
    AND a.before_value::jsonb->'serials'->0->>'serial_no'='TEST00001-AA'
    AND a.after_value::jsonb->'serials'->0->>'serial_no'='TEST00002-AA'),'Serial swap audit preserves original and replacement identities');
  PERFORM pg_temp.expect_error(format('SELECT public.write_inventory_transaction_atomic(''EDIT'',%L::jsonb,''["TEST00001-AA"]'',%L::uuid,''stale'',%L::timestamptz)',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1),tx->>'id',tx->>'updated_at'),'STALE_INVENTORY');
  ret:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','RETURN',1),'["TEST00002-AA"]');
  PERFORM pg_temp.assert_true((SELECT status='在庫' AND project_id IS NULL FROM public.inventory_serials WHERE serial_number='TEST00002-AA'),'RETURN restores stock/project');
  tx:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1),'["TEST00002-AA"]');
  PERFORM pg_temp.expect_error(format('SELECT public.write_inventory_transaction_atomic(''VOID'',''{}'',''[]'',%L::uuid,''history'')',ret->>'id'),'SERIAL_HISTORY_CONFLICT');
  tx:=public.write_inventory_transaction_atomic('VOID','{}','[]',(tx->>'id')::uuid,'undo latest');
  ret:=public.write_inventory_transaction_atomic('VOID','{}','[]',(ret->>'id')::uuid,'undo return');
  PERFORM pg_temp.assert_true((SELECT status='已出庫' FROM public.inventory_serials WHERE serial_number='TEST00002-AA'),'Void RETURN restores outgoing state');
  PERFORM pg_temp.assert_true((SELECT b.source_transaction_id::text=current_setting('test.receipt_id') FROM public.inventory_serials s JOIN public.inventory_batches b ON b.id=s.batch_id WHERE s.serial_number='TEST00002-AA'),'Void RETURN restores original receipt batch');
  edited:=public.write_inventory_transaction_atomic('VOID','{}','[]',(edited->>'id')::uuid,'undo edited out');
  PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',2),'["TEST00001-AA","TEST00001-AA"]')$q$,'duplicate serial');
  PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('VOID','{}','[]',current_setting('test.receipt_id')::uuid,'editor not admin')$q$,'Only ADMIN');
  PERFORM pg_temp.expect_error($q$UPDATE public.inventory_serials SET status='在庫' WHERE serial_number='TEST00001-AA'$q$,'permission denied');
  PERFORM pg_temp.expect_error($q$DELETE FROM public.inventory_initializations WHERE false$q$,'permission denied');
  PERFORM pg_temp.expect_error($q$UPDATE public.inventory_initialization_items SET new_opening_quantity=0 WHERE false$q$,'permission denied');
  PERFORM pg_temp.expect_error($q$INSERT INTO public.inventory_transactions(item_id,transaction_type,transaction_date,quantity) VALUES('72000000-0000-4000-8000-000000000001','OUT','2099-01-15',1)$q$,'permission denied');
  receipt:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','IN',1));
  SELECT id INTO pending_link FROM public.inventory_transaction_serials WHERE transaction_id=(receipt->>'id')::uuid AND is_pending;
  registered:=public.register_inventory_serial_atomic('TEST00003-AA',pending_link);
  PERFORM pg_temp.assert_true(registered->'serial'->>'status'='在庫' AND (registered->'link'->>'is_pending')::boolean=false,'Pending receipt registration atomic');
  PERFORM pg_temp.expect_error(format('SELECT public.register_inventory_serial_atomic(''TEST00004-AA'',%L::uuid)',pending_link),'Pending slot no longer');
  PERFORM pg_temp.expect_error(format('SELECT public.delete_unlinked_inventory_serial_atomic(%L::uuid)',registered->'serial'->>'id'),'history must be preserved');
END $$;
RESET ROLE;
SELECT pg_temp.assert_true(app_private.inventory_effective_balance('72000000-0000-4000-8000-000000000001')=1,'OUT balance 5 - 4 = 1; failed requests unchanged');
SELECT pg_temp.assert_true(app_private.inventory_effective_balance('72000000-0000-4000-8000-000000000002')=2,'ADJUST edit balance');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor_email'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE credit jsonb; debit jsonb; BEGIN
 credit:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000002','ADJUST',999)||'{"counted_quantity":5,"expected_balance":2}');
 debit:=public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000002','OUT',4));
 PERFORM pg_temp.expect_error(format('SELECT public.write_inventory_transaction_atomic(''VOID'',''{}'',''[]'',%L::uuid,''consumed credit'')',credit->>'id'),'INSUFFICIENT_INVENTORY');
 PERFORM pg_temp.expect_error(format('SELECT public.write_inventory_transaction_atomic(''EDIT'',%L::jsonb,''[]'',%L::uuid,''too large'')',pg_temp.payload('72000000-0000-4000-8000-000000000002','OUT',6),debit->>'id'),'INSUFFICIENT_INVENTORY');
 PERFORM public.write_inventory_transaction_atomic('VOID','{}','[]',(debit->>'id')::uuid,'restore stock');
 PERFORM public.write_inventory_transaction_atomic('VOID','{}','[]',(credit->>'id')::uuid,'remove credit');
 PERFORM pg_temp.assert_true((credit->>'quantity')::numeric=3,'Positive ADJUST uses counted input');
END $$;
RESET ROLE;
-- Parity fixture deliberately uses signed, void and excluded values.
INSERT INTO public.inventory_initializations(id,baseline_date,initialized_by)
SELECT '72000000-0000-4000-8000-000000000099','2026-08-31'::date,'fixture'
WHERE NOT EXISTS(SELECT 1 FROM public.inventory_initializations);
INSERT INTO public.inventory_transactions(item_id,transaction_type,transaction_date,quantity,is_voided,excluded_by_initialization_id)
SELECT '72000000-0000-4000-8000-000000000004',kind,'2099-01-15',qty,voided,excluded FROM (VALUES
('IN',5,false,NULL::uuid),('OUT',3,false,NULL::uuid),('RETURN',2,false,NULL::uuid),('ADJUST',2,false,NULL::uuid),('ADJUST',-1,false,NULL::uuid),
('IN',100,true,NULL::uuid),('OUT',100,false,(SELECT id FROM public.inventory_initializations LIMIT 1)))v(kind,qty,voided,excluded);
SELECT pg_temp.assert_true(app_private.inventory_effective_balance('72000000-0000-4000-8000-000000000004')=15,'Balance parity: baseline + IN OUT RETURN +/-ADJUST; void/excluded ignored');
-- A sealed receipt may still have pending identities filled, without editing its ledger.
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor_email'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.sealed_receipt',public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','IN',1)||'{"transaction_date":"2099-02-15"}')->>'id',true);
RESET ROLE;
INSERT INTO public.inventory_monthly_closings(year,month,status,closed_at,closed_by) VALUES('2099','02','CLOSED',now(),'fixture');
SET LOCAL ROLE authenticated;
DO $$ DECLARE previous_tx jsonb; registered jsonb; BEGIN
 SELECT to_jsonb(t) INTO previous_tx FROM public.inventory_transactions t WHERE id=current_setting('test.sealed_receipt')::uuid;
 registered:=public.register_inventory_serial_atomic('TEST00005-AA',(SELECT id FROM public.inventory_transaction_serials WHERE transaction_id=current_setting('test.sealed_receipt')::uuid AND is_pending LIMIT 1));
 PERFORM pg_temp.assert_true(registered->'serial'->>'status'='在庫' AND previous_tx=(SELECT to_jsonb(t) FROM public.inventory_transactions t WHERE id=current_setting('test.sealed_receipt')::uuid),'Sealed receipt pending registration leaves ledger unchanged');
END $$;
RESET ROLE;
-- Fail at audit INSERT, after ledger, links and serial state were all written.
CREATE FUNCTION pg_temp.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.after_value::jsonb->>'notes'='force-audit-rollback' THEN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER inventory_test_audit_failure BEFORE INSERT ON public.activity_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_test_audit();
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor_email'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE before_rows bigint; before_serial jsonb; before_links jsonb; BEGIN
 SELECT count(*) INTO before_rows FROM public.inventory_transactions;
 SELECT to_jsonb(s) INTO before_serial FROM public.inventory_serials s WHERE serial_number='TEST00001-AA';
 SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO before_links FROM public.inventory_transaction_serials l WHERE serial_id=(before_serial->>'id')::uuid;
 PERFORM pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000003','OUT',1)||'{"notes":"force-audit-rollback"}','["TEST00001-AA"]')$q$,'TEST_AUDIT_FAILURE');
 PERFORM pg_temp.assert_true(before_rows=(SELECT count(*) FROM public.inventory_transactions) AND before_serial=(SELECT to_jsonb(s) FROM public.inventory_serials s WHERE serial_number='TEST00001-AA'),'Late audit error rolls back ledger/link/status');
 PERFORM pg_temp.assert_true(before_links=(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.inventory_transaction_serials l WHERE serial_id=(before_serial->>'id')::uuid),'Late audit error leaves every serial link unchanged');
END $$;
SELECT pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','IN',1)||'{"transaction_date":"2099-02-15"}')$q$,'已封存');
SELECT pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','IN',1)||'{"transaction_date":"2026-08-01"}')$q$,'baseline');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.viewer_email'),'role','authenticated')::text,true);
SELECT pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','OUT',1))$q$,'active editor');
SELECT pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('CREATE',pg_temp.payload('72000000-0000-4000-8000-000000000001','ADJUST',-1))$q$,'active editor');
SELECT pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('EDIT','{}','[]',current_setting('test.out_id')::uuid,'viewer')$q$,'active editor');
SELECT pg_temp.expect_error($q$SELECT public.write_inventory_transaction_atomic('VOID','{}','[]',current_setting('test.out_id')::uuid,'viewer')$q$,'active editor');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.admin_email'),'role','authenticated')::text,true);
SELECT pg_temp.expect_error($q$SELECT public.initialize_inventory('[]')$q$,'already been initialized');
SELECT public.write_inventory_transaction_atomic('VOID','{}','[]',current_setting('test.receipt_id')::uuid,'admin void receipt')->>'is_voided' AS admin_void_ok;
SELECT pg_temp.assert_true((SELECT status='作廢' FROM public.inventory_serials WHERE serial_number='TEST00001-AA'),'ADMIN IN void retains voided serial history');
RESET ROLE;
ROLLBACK;
