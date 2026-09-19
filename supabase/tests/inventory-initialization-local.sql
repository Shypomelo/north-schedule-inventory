-- Disposable, empty local database only; never run against an initialized DB.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM inventory_items) OR EXISTS(SELECT 1 FROM inventory_initializations) THEN
   RAISE EXCEPTION 'Requires empty local inventory'; END IF;
END $$;
INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial) VALUES
('75000000-0000-4000-8000-000000000001','INIT-TEST','[TEST] initialize','個','設備維修',2,false);
INSERT INTO inventory_transactions(item_id,transaction_type,transaction_date,quantity)
VALUES('75000000-0000-4000-8000-000000000001','IN','2026-08-15',3);
SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM team_members WHERE lower(role)='admin' LIMIT 1),'sub','75000000-0000-4000-8000-000000000099','role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
SELECT public.initialize_inventory('[{"id":"75000000-0000-4000-8000-000000000001","new_opening_quantity":4}]');
RESET ROLE;
DO $$ BEGIN
 IF app_private.inventory_effective_balance('75000000-0000-4000-8000-000000000001')<>4
 OR NOT EXISTS(SELECT 1 FROM inventory_transactions WHERE item_id='75000000-0000-4000-8000-000000000001' AND excluded_by_initialization_id IS NOT NULL) THEN
 RAISE EXCEPTION 'Initialization baseline/exclusion regression'; END IF;
 RAISE NOTICE 'PASS actual initialization retains ledger, excludes historical effect, sets baseline';
END $$;
ROLLBACK;
