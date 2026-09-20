-- Candidate/disposable local only. Tests effective privileges and real RLS paths.
BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.denied(statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE statement;
 EXCEPTION WHEN insufficient_privilege THEN RETURN;
 END;
 RAISE EXCEPTION 'Expected permission denial: %',statement;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $$ DECLARE obj text; priv text; BEGIN
 FOREACH obj IN ARRAY ARRAY['activity_logs','inventory_batches','inventory_initialization_items','inventory_initialization_serials','inventory_initializations','inventory_items','inventory_monthly_closing_items','inventory_monthly_closings','inventory_serials','inventory_transaction_serials','inventory_transactions'] LOOP
  FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
   PERFORM pg_temp.assert_true(NOT has_table_privilege('anon','public.'||obj,priv),'anon denied '||obj||' '||priv);
  END LOOP;
  FOREACH priv IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
   PERFORM pg_temp.assert_true(NOT has_table_privilege('authenticated','public.'||obj,priv),'authenticated denied '||obj||' '||priv);
  END LOOP;
  PERFORM pg_temp.assert_true(has_table_privilege('authenticated','public.'||obj,'SELECT'),'signed-in read '||obj);
 END LOOP;
 FOREACH obj IN ARRAY ARRAY['inventory_batches','inventory_initialization_items','inventory_initialization_serials','inventory_initializations','inventory_serials','inventory_transaction_serials','inventory_transactions'] LOOP
  FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   PERFORM pg_temp.assert_true(NOT has_table_privilege('authenticated','public.'||obj,priv),'RPC-only mutation '||obj||' '||priv);
  END LOOP;
 END LOOP;
 FOREACH obj IN ARRAY ARRAY['inventory_items','inventory_monthly_closings','inventory_monthly_closing_items'] LOOP
  FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   PERFORM pg_temp.assert_true(has_table_privilege('authenticated','public.'||obj,priv),'RLS-controlled direct write '||obj||' '||priv);
  END LOOP;
 END LOOP;
 PERFORM pg_temp.assert_true(has_table_privilege('authenticated','public.activity_logs','INSERT') AND NOT has_table_privilege('authenticated','public.activity_logs','UPDATE') AND NOT has_table_privilege('authenticated','public.activity_logs','DELETE'),'audit insert/read only');
 FOREACH obj IN ARRAY ARRAY[
 'public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz)',
 'public.register_inventory_serial_atomic(text,uuid,uuid)',
 'public.delete_unlinked_inventory_serial_atomic(uuid)',
 'public.initialize_inventory(jsonb)'] LOOP
  PERFORM pg_temp.assert_true(has_function_privilege('authenticated',obj,'EXECUTE') AND has_function_privilege('service_role',obj,'EXECUTE') AND NOT has_function_privilege('anon',obj,'EXECUTE'),'restricted canonical entry '||obj);
 END LOOP;
END $$;
SELECT set_config('test.editor_email',(SELECT email FROM public.team_members WHERE is_active AND deleted_at IS NULL AND lower(role)='engineer' ORDER BY id LIMIT 1),true);
SELECT set_config('test.admin_email',(SELECT email FROM public.team_members WHERE is_active AND deleted_at IS NULL AND lower(role)='admin' ORDER BY id LIMIT 1),true);
SELECT set_config('test.viewer_email',(SELECT email FROM public.team_members WHERE is_active AND deleted_at IS NULL AND lower(role)='viewer' ORDER BY id LIMIT 1),true);
SELECT pg_temp.assert_true(current_setting('test.editor_email')<>'' AND current_setting('test.admin_email')<>'' AND current_setting('test.viewer_email')<>'','all test role fixtures exist');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.editor_email'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
-- Same direct paths as item creation and monthly close/re-close, all rolled back.
INSERT INTO public.inventory_items(id,code,name,unit,category,opening_quantity,requires_serial)
VALUES('78000000-0000-4000-8000-000000000001','TEST-GRANT','[TEST grant convergence]','個','設備維修',2,false);
INSERT INTO public.inventory_monthly_closings(id,year,month,status,closed_at,closed_by,notes)
VALUES('78000000-0000-4000-8000-000000000002','2098','12','OPEN',now(),'Fixture','[TEST grant convergence]');
INSERT INTO public.inventory_monthly_closing_items(closing_id,inventory_item_id,item_name,item_type,unit,source,status,stock_category,closing_quantity)
VALUES('78000000-0000-4000-8000-000000000002','78000000-0000-4000-8000-000000000001','[TEST grant convergence]','物料','個','自購','正常','設備維修',2);
UPDATE public.inventory_monthly_closings SET status='CLOSED' WHERE id='78000000-0000-4000-8000-000000000002';
SELECT pg_temp.assert_true((SELECT status='CLOSED' FROM public.inventory_monthly_closings WHERE id='78000000-0000-4000-8000-000000000002'),'editor monthly closing finalize/read');
INSERT INTO public.activity_logs(action,target_type,target_id,description) VALUES('CREATE','inventory','78000000-0000-4000-8000-000000000001','[TEST grant convergence]');
SELECT pg_temp.denied($q$UPDATE public.inventory_transactions SET notes='unsafe' WHERE false$q$);
SELECT pg_temp.denied($q$DELETE FROM public.inventory_serials WHERE false$q$);
SELECT pg_temp.denied($q$UPDATE public.activity_logs SET description='unsafe' WHERE false$q$);
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.admin_email'),'role','authenticated')::text,true);
SELECT public.unseal_inventory_month('2098','12');
DELETE FROM public.inventory_monthly_closing_items WHERE closing_id='78000000-0000-4000-8000-000000000002';
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.inventory_monthly_closing_items WHERE closing_id='78000000-0000-4000-8000-000000000002'),'admin re-close clears old snapshots');
-- Initialization preview/reads retain their existing grants and admin check.
SELECT public.preview_inventory_initialization('[{"id":"78000000-0000-4000-8000-000000000001","new_opening_quantity":2}]');
SELECT count(*) FROM public.inventory_initializations;
SELECT count(*) FROM public.inventory_initialization_items;
SELECT count(*) FROM public.inventory_initialization_serials;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.viewer_email'),'role','authenticated')::text,true);
SELECT pg_temp.assert_true(EXISTS(SELECT 1 FROM public.inventory_items WHERE id='78000000-0000-4000-8000-000000000001'),'viewer still reads');
SELECT pg_temp.denied($q$INSERT INTO public.inventory_items(code,name,unit,category) VALUES('TEST-GRANT-VIEWER','[TEST viewer denied]','個','設備維修')$q$);
SELECT pg_temp.denied($q$INSERT INTO public.inventory_monthly_closings(year,month,status,closed_at,closed_by) VALUES('2098','11','OPEN',now(),'viewer')$q$);
SELECT pg_temp.denied($q$INSERT INTO public.activity_logs(action,target_type,target_id) VALUES('CREATE','inventory','viewer-denied')$q$);
SELECT pg_temp.denied($q$SELECT public.register_inventory_serial_atomic('TESTDENY-AA',NULL,NULL)$q$);
SELECT pg_temp.denied($q$SELECT public.delete_unlinked_inventory_serial_atomic('78000000-0000-4000-8000-000000000003')$q$);
WITH changed AS (UPDATE public.inventory_items SET name='viewer forbidden' WHERE id='78000000-0000-4000-8000-000000000001' RETURNING id)
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM changed),'viewer update affects zero rows');
WITH removed AS (DELETE FROM public.inventory_monthly_closings WHERE id='78000000-0000-4000-8000-000000000002' RETURNING id)
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM removed),'viewer delete affects zero rows');
RESET ROLE;
ROLLBACK;
