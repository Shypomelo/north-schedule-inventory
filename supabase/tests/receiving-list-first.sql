-- Candidate or isolated local DB only; every fixture is rolled back.
BEGIN;
SET LOCAL statement_timeout='45s';
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.reject(q text,label text,pattern text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$ BEGIN BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN IF pattern IS NOT NULL AND SQLERRM !~ pattern THEN RAISE EXCEPTION 'FAIL %: unexpected error %',label,SQLERRM; END IF; RAISE NOTICE 'PASS: % rejected (%)',label,SQLERRM; RETURN; END; RAISE EXCEPTION 'FAIL: % did not reject',label; END $$;
CREATE FUNCTION pg_temp.id(n integer) RETURNS uuid LANGUAGE sql AS $$ SELECT ('84000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
SELECT set_config('test.admin',(SELECT email FROM team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.viewer',(SELECT email FROM team_members WHERE role='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),true);
SELECT set_config('test.project',(SELECT id::text FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1),true);
INSERT INTO inventory_items(id,code,name,unit,category,opening_quantity,requires_serial,is_se_maintenance_equipment)
VALUES(pg_temp.id(1),'[TEST V4] serial','[TEST V4] serial','台','設備維修',0,true,true),(pg_temp.id(2),'[TEST V4] plain','[TEST V4] plain','個','一般',0,false,false),(pg_temp.id(3),'[TEST V4] cancel','[TEST V4] cancel','個','一般',0,false,false);
CREATE FUNCTION pg_temp.arrival(n integer,item integer,qty numeric,serials jsonb DEFAULT '[]') RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE r jsonb; BEGIN r:=public.create_office_equipment_arrival(pg_temp.id(n),pg_temp.id(item),qty,now(),NULL,'[TEST V4]',serials); RETURN (r->>'id')::uuid; END $$;
CREATE FUNCTION pg_temp.receive(n integer,source uuid,item integer,qty numeric,names text[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$ SELECT public.confirm_receiving_into_inventory(pg_temp.id(n),'SE_SUPPLY',source,pg_temp.id(item),qty,COALESCE((SELECT array_agg(id ORDER BY normalized_serial) FROM receiving_serial_entries WHERE se_supply_record_id=source AND normalized_serial=ANY(names)),'{}'),'2099-01-15','[TEST V4]') $$;
CREATE FUNCTION pg_temp.route(n integer,receipt uuid,kind text,qty numeric,serials uuid[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$ SELECT public.route_receiving_inventory(pg_temp.id(n),receipt,kind,qty,serials,current_setting('test.project')::uuid,NULL,true,'2099-01-15','[TEST V4]') $$;
CREATE FUNCTION pg_temp.cancel(n integer,source uuid,hide boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.cancel_receiving_arrival(pg_temp.id(n),'SE_SUPPLY',source,'[TEST V4] cancellation',hide) $$;
CREATE FUNCTION pg_temp.balance(item integer) RETURNS numeric LANGUAGE sql AS $$ SELECT opening_quantity+COALESCE((SELECT sum(CASE transaction_type WHEN 'OUT' THEN -quantity ELSE quantity END) FROM inventory_transactions WHERE item_id=i.id AND NOT is_voided AND excluded_by_initialization_id IS NULL),0) FROM inventory_items i WHERE id=pg_temp.id(item) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.admin'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE source uuid; source_b uuid; pending uuid; r jsonb; rb jsonb; result jsonb; se jsonb; serials uuid[]; balance_before numeric; receipt_id uuid; before_count integer; cnt integer;
BEGIN
 source:=pg_temp.arrival(10,1,3,'["V4000001-AA","V4000002-AA","V4000003-AA"]');
 r:=pg_temp.receive(11,source,1,3,ARRAY['V4000001-AA','V4000002-AA','V4000003-AA']); receipt_id:=(r->>'id')::uuid;
 source_b:=pg_temp.arrival(12,1,1,'["V4000004-AA"]'); rb:=pg_temp.receive(13,source_b,1,1,ARRAY['V4000004-AA']);
 SELECT array_agg(id ORDER BY serial_number) INTO serials FROM inventory_serials WHERE serial_number IN ('V4000001-AA','V4000002-AA','V4000003-AA','V4000004-AA');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(20,%L,''SE'',1,ARRAY[%L]::uuid[])',receipt_id,serials[4]),'ROUTE-2 foreign receipt serial','不屬於');
 result:=pg_temp.route(21,receipt_id,'SE',1,ARRAY[serials[1]]);se:=result->0;
 PERFORM pg_temp.ok(pg_temp.balance(1)=4 AND (SELECT status='在庫' FROM inventory_serials WHERE id=serials[1]),'ROUTE-1 SE remains in stock');
 PERFORM pg_temp.ok((SELECT receiving_archived_at IS NULL AND NOT inventory_routed FROM se_supply_records WHERE id=source),'ROUTE-3 original arrival remains visible');
 PERFORM pg_temp.ok(pg_temp.route(21,receipt_id,'SE',1,ARRAY[serials[1]])=result,'same route request idempotent');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(21,%L,''SE'',1,ARRAY[%L]::uuid[])',receipt_id,serials[2]),'idempotency payload conflict','Request conflict');
 PERFORM pg_temp.reject(format('SELECT pg_temp.cancel(22,%L)',source),'DELETE-3 reserved cancellation','SE 供貨');
 PERFORM pg_temp.reject(format('SELECT public.change_se_inventory_reservation(%L,%L,%L)',se->>'id',serials[4],se->>'updated_at'),'cross receipt SE change rejected','同一筆');
 se:=public.change_receiving_se_project((se->>'id')::uuid,NULL,(se->>'updated_at')::timestamptz);
 PERFORM pg_temp.ok(se->>'project_id' IS NULL,'SE project change preserves canonical reservation');
 PERFORM public.cancel_se_inventory_reservation((se->>'id')::uuid,(se->>'updated_at')::timestamptz);
 PERFORM pg_temp.ok((SELECT cancelled_at IS NOT NULL FROM receiving_inventory_allocations WHERE se_supply_record_id=(se->>'id')::uuid) AND pg_temp.balance(1)=4,'ROUTE-4 cancel returns allocation to stock');
 result:=pg_temp.route(23,receipt_id,'SITE',1,ARRAY[serials[2]]);
 PERFORM pg_temp.ok((SELECT receipt_location='SITE' FROM material_receipts WHERE id=(result->0->>'id')::uuid) AND pg_temp.balance(1)=3,'ROUTE-5 OUT and SITE receipt atomic');
 PERFORM pg_temp.ok((SELECT receiving_archived_at IS NULL FROM se_supply_records WHERE id=source),'Project routing preserves OFFICE arrival');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM receiving_inventory_allocations WHERE office_receipt_id=receipt_id AND inventory_serial_id=serials[2] AND site_receipt_id=(result->0->>'id')::uuid),'SERIAL-1 exact allocation provenance');
 PERFORM pg_temp.reject(format('SELECT pg_temp.cancel(24,%L)',source),'DELETE-4 delivered cancellation','送至案場');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(25,%L,''SITE'',1,ARRAY[%L]::uuid[])',receipt_id,serials[2]),'serial cannot route twice','已有後續用途');
 -- Pending cancellation retires entries and prevents stale clients receiving later.
 pending:=pg_temp.arrival(30,1,1,'["V4000005-AA"]');balance_before:=pg_temp.balance(1);
 result:=pg_temp.cancel(31,pending);
 PERFORM pg_temp.ok((SELECT bool_and(retired_at IS NOT NULL) FROM receiving_serial_entries WHERE se_supply_record_id=pending) AND pg_temp.balance(1)=balance_before,'DELETE-1 pending cancellation without stock effect');
 PERFORM pg_temp.reject(format('SELECT register_receiving_serial(''SE_SUPPLY'',%L,%L,''V4000006-AA'')',pending,pg_temp.id(1)),'stale client cannot register cancelled arrival','取消或隱藏');
 -- Full cancellation reuses correction/VOID and remains idempotent.
 balance_before:=pg_temp.balance(1);result:=pg_temp.cancel(32,source_b);
 PERFORM pg_temp.ok(pg_temp.balance(1)=balance_before-1 AND (SELECT status='作廢' FROM inventory_serials WHERE id=serials[4]),'DELETE-2 canonical balance and serial restored');
 PERFORM pg_temp.ok((SELECT count(*)=1 FROM material_receipts WHERE reversal_of_id=(rb->>'id')::uuid) AND (SELECT receiving_archived_at IS NOT NULL FROM se_supply_records WHERE id=source_b),'DELETE-2 REVERSAL and archive together');
 PERFORM pg_temp.ok(pg_temp.cancel(32,source_b)=result,'cancel retry idempotent');
 -- Quantity allocation: only this receipt capacity, separate from item balance.
 source_b:=pg_temp.arrival(40,2,20);rb:=pg_temp.receive(41,source_b,2,20);
 result:=pg_temp.route(42,(rb->>'id')::uuid,'SITE',5);
 PERFORM pg_temp.ok((SELECT sum(quantity)=5 FROM receiving_inventory_allocations WHERE office_receipt_id=(rb->>'id')::uuid) AND pg_temp.balance(2)=15,'NON-SERIAL-1 20 minus 5 remains traceable 15');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(43,%L,''SITE'',16)',rb->>'id'),'quantity over-allocation','本批');
 PERFORM pg_temp.reject(format('SELECT pg_temp.cancel(44,%L)',source_b),'nonserial delivered cancellation','送至案場');
 balance_before:=pg_temp.balance(2);PERFORM pg_temp.cancel(45,source_b,true);
 PERFORM pg_temp.ok(pg_temp.balance(2)=balance_before AND (SELECT count(*)=0 FROM material_receipts WHERE reversal_of_id=(rb->>'id')::uuid),'DELETE-5 hide does not correct stock');
 -- Two receipts: correction loop must account for both, not just latest.
 source_b:=pg_temp.arrival(50,3,4);r:=pg_temp.receive(51,source_b,3,2);rb:=pg_temp.receive(52,source_b,3,2);balance_before:=pg_temp.balance(3);
 PERFORM pg_temp.cancel(53,source_b);
 PERFORM pg_temp.ok(pg_temp.balance(3)=balance_before-4 AND (SELECT count(*)=2 FROM material_receipts WHERE se_supply_record_id=source_b AND event_type='REVERSAL'),'multi-receipt cancellation');
 PERFORM pg_temp.ok(jsonb_array_length(public.get_receiving_source_details('SE_SUPPLY',source)->'receipts')>=1,'source projection preserves receipt history');
 PERFORM pg_temp.reject('DELETE FROM public.receiving_inventory_allocations','RLS no direct client delete','permission denied');
 PERFORM pg_temp.reject('INSERT INTO public.receiving_inventory_allocations DEFAULT VALUES','RLS no direct client insert','permission denied');
END $$;
RESET ROLE;
-- Inject a late archive failure: even earlier IN corrections and reversals must roll back.
CREATE FUNCTION pg_temp.fail_v4_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.notes='[TEST V4 rollback]' AND NEW.receiving_archived_at IS NOT NULL THEN RAISE EXCEPTION 'INJECTED ARCHIVE FAILURE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER test_v4_archive BEFORE UPDATE ON public.se_supply_records FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_v4_archive();
SET LOCAL ROLE authenticated;
DO $$ DECLARE source uuid;r jsonb;b numeric; BEGIN
 source:=pg_temp.arrival(70,3,2);UPDATE se_supply_records SET notes='[TEST V4 rollback]' WHERE id=source;r:=pg_temp.receive(71,source,3,2);b:=pg_temp.balance(3);
 PERFORM pg_temp.reject(format('SELECT pg_temp.cancel(72,%L)',source),'atomic cancel rollback','INJECTED ARCHIVE');
 PERFORM pg_temp.ok(pg_temp.balance(3)=b AND (SELECT count(*)=0 FROM material_receipts WHERE reversal_of_id=(r->>'id')::uuid) AND (SELECT receiving_archived_at IS NULL FROM se_supply_records WHERE id=source),'all cancellation effects rollback on late failure');
END $$;

RESET ROLE;
CREATE FUNCTION pg_temp.fail_v4_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED ALLOCATION FAILURE'; END $$;
CREATE TRIGGER test_v4_allocation BEFORE INSERT ON public.receiving_inventory_allocations FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_v4_allocation();
SET LOCAL ROLE authenticated;
DO $$ DECLARE source uuid;r jsonb;serial uuid;b numeric;before_se integer;before_site integer; BEGIN
 source:=pg_temp.arrival(74,1,1,'["V4000007-AA"]');r:=pg_temp.receive(75,source,1,1,ARRAY['V4000007-AA']);SELECT id INTO serial FROM inventory_serials WHERE serial_number='V4000007-AA';b:=pg_temp.balance(1);
 SELECT count(*) INTO before_se FROM se_supply_records;SELECT count(*) INTO before_site FROM material_receipts WHERE receipt_location='SITE';
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(76,%L,''SE'',1,ARRAY[%L]::uuid[])',r->>'id',serial),'SE relation failure rolls back reservation','INJECTED ALLOCATION');
 PERFORM pg_temp.ok((SELECT count(*)=before_se FROM se_supply_records),'no orphan SE on allocation failure');
 PERFORM pg_temp.reject(format('SELECT pg_temp.route(77,%L,''SITE'',1,ARRAY[%L]::uuid[])',r->>'id',serial),'SITE relation failure rolls back delivery','INJECTED ALLOCATION');
 PERFORM pg_temp.ok(pg_temp.balance(1)=b AND (SELECT status='在庫' FROM inventory_serials WHERE id=serial) AND (SELECT count(*)=before_site FROM material_receipts WHERE receipt_location='SITE'),'no OUT/serial/SITE effect on allocation failure');
 PERFORM set_config('test.closed_source',source::text,true);
END $$;
RESET ROLE;
INSERT INTO public.inventory_monthly_closings(year,month,status,closed_by,closed_at,notes) VALUES('2099','01','CLOSED','[TEST V4]',now(),'[TEST V4]');
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject(format('SELECT pg_temp.cancel(78,%L)',current_setting('test.closed_source')),'closed month cancellation blocked','已封存');
SELECT pg_temp.ok((SELECT receiving_archived_at IS NULL FROM se_supply_records WHERE id=current_setting('test.closed_source')::uuid),'closed month rejection preserves arrival');
SELECT set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.viewer'),'role','authenticated')::text,true);
SELECT pg_temp.reject('SELECT pg_temp.cancel(90,pg_temp.id(99))','viewer cannot cancel','editor|Editor|permission|active');
SELECT pg_temp.reject('SELECT pg_temp.route(92,pg_temp.id(99),''SITE'',1)','viewer cannot route','editor|Editor|permission|active');
SELECT pg_temp.reject('SELECT change_receiving_se_project(pg_temp.id(99),NULL,now())','viewer cannot change SE','editor|Editor|permission|active');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.reject('SELECT public.get_receiving_source_details(''SE_SUPPLY'',pg_temp.id(99))','anon no projection','permission denied');
SELECT pg_temp.reject('SELECT pg_temp.cancel(91,pg_temp.id(99))','anon no cancel','permission denied');
RESET ROLE;
ROLLBACK;
