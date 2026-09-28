BEGIN;
SET LOCAL statement_timeout='45s';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM review_private.environment_guard WHERE project_ref='fssogssryeunkjkdgewx' AND purpose='CANDIDATE_REVIEW') THEN RAISE EXCEPTION 'CANDIDATE ONLY'; END IF; END $$;
CREATE FUNCTION pg_temp.ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; END $$;
CREATE FUNCTION pg_temp.reject(q text,pattern text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN IF SQLERRM !~ pattern THEN RAISE; END IF; RETURN; END; RAISE EXCEPTION 'Expected rejection: %',pattern; END $$;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial) VALUES
 ('88100000-0000-4000-8000-000000000001','[TEST V5A BOUNDARY] plain','[TEST V5A BOUNDARY] plain','個','一般',false),
 ('88100000-0000-4000-8000-000000000002','[TEST V5A BOUNDARY] serial','[TEST V5A BOUNDARY] serial','台','設備維修',true);
INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by)
 SELECT '88100000-0000-4000-8000-000000000004',p.id,'[TEST V5A BOUNDARY]',(app_private.inventory_actor()).id FROM public.projects p WHERE p.deleted_at IS NULL ORDER BY p.id LIMIT 1;
INSERT INTO public.project_materials(id,project_id,item_name,quantity,unit,created_by,inventory_item_id,delivery_destination,batch_id)
 SELECT '88100000-0000-4000-8000-000000000003',id,'[TEST V5A BOUNDARY]',3,'個',(app_private.inventory_actor()).id,'88100000-0000-4000-8000-000000000001','OFFICE','88100000-0000-4000-8000-000000000004'
 FROM public.projects p WHERE p.deleted_at IS NULL ORDER BY p.id LIMIT 1;
INSERT INTO public.inventory_monthly_closings(year,month,status,closed_by,closed_at,notes) VALUES('2099','04','CLOSED','[TEST V5A BOUNDARY]',now(),'[TEST V5A BOUNDARY]');
SELECT set_config('test.v5_bad_pending',(public.create_office_equipment_arrival('88100000-0000-4000-8000-000000000030','88100000-0000-4000-8000-000000000002',1,now(),NULL,'[TEST V5A BOUNDARY]','["V5AB0002-AA"]')->>'id'),true);
-- Deliberately stale synthetic pending metadata; rollback restores the entire fixture.
UPDATE public.receiving_serial_entries SET inventory_item_id='88100000-0000-4000-8000-000000000001' WHERE se_supply_record_id=current_setting('test.v5_bad_pending')::uuid;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated,anon;
SET LOCAL ROLE authenticated;
DO $$
DECLARE r jsonb; u jsonb; line_id uuid; before_tx bigint;
BEGIN
 r:=public.create_receiving_arrival('88100000-0000-4000-8000-000000000010','2000-01-01','[{"inventory_item_id":"88100000-0000-4000-8000-000000000001","quantity":3}]',NULL,'[TEST V5A BOUNDARY]','2099-03-15');
 line_id:=(r->'lines'->0->>'id')::uuid;
 PERFORM public.match_receiving_arrival_line('88100000-0000-4000-8000-000000000011',line_id,2,'88100000-0000-4000-8000-000000000003',NULL);
 PERFORM pg_temp.ok(public.get_receiving_pending_fulfilment('88100000-0000-4000-8000-000000000003',NULL)->>'remaining'='1','project material partial match');
 PERFORM pg_temp.reject('UPDATE public.project_materials SET quantity=1 WHERE id=''88100000-0000-4000-8000-000000000003''','MATCHED_PENDING');
 PERFORM pg_temp.reject('SELECT public.confirm_material_receipt(''PROJECT_MATERIAL'',''88100000-0000-4000-8000-000000000003'',1,now(),NULL)','庫存|收貨|V5_MATCHED|序號');
 u:=public.create_receiving_arrival('88100000-0000-4000-8000-000000000020','2099-04-01','[{"quantity":1,"raw_serials":["V5AB0001-AA"]}]',NULL,'[TEST V5A BOUNDARY]');
 line_id:=(u->'lines'->0->>'id')::uuid;
 before_tx:=(SELECT count(*) FROM public.inventory_transactions);
 PERFORM pg_temp.reject(format('SELECT public.complete_receiving_arrival_line(%L,%L,%L,%L)','88100000-0000-4000-8000-000000000021',line_id,'88100000-0000-4000-8000-000000000002','2099-04-15'),'封存|closed|CLOSED|結帳');
 PERFORM pg_temp.ok((SELECT resolution_state='UNRESOLVED' FROM public.receiving_arrival_lines WHERE id=line_id) AND (SELECT count(*)=before_tx FROM public.inventory_transactions),'closed-month completion rolls back only first-post attempt');
 PERFORM public.complete_receiving_arrival_line('88100000-0000-4000-8000-000000000022',line_id,'88100000-0000-4000-8000-000000000002','2099-05-15');
 PERFORM pg_temp.ok((SELECT posting_date='2099-05-15' FROM public.receiving_arrival_lines WHERE id=line_id) AND u->'arrival'->>'actual_received_at' LIKE '2099-04-01%','explicit open posting preserves historical arrival time');
 r:=public.create_receiving_arrival('88100000-0000-4000-8000-000000000031','2000-01-01','[{"inventory_item_id":"88100000-0000-4000-8000-000000000002","quantity":1,"raw_serials":["V5AB0002-AA"]}]',NULL,'[TEST V5A BOUNDARY]','2099-05-15');
 line_id:=(r->'lines'->0->>'id')::uuid;
 PERFORM pg_temp.reject(format('SELECT public.match_receiving_arrival_line(%L,%L,1,NULL,%L,ARRAY[%L]::uuid[])','88100000-0000-4000-8000-000000000032',line_id,current_setting('test.v5_bad_pending'),(SELECT id FROM public.receiving_serial_entries WHERE arrival_line_id=line_id)),'MATCH_PREDECLARED_ITEM_CONFLICT');
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.reject('SELECT * FROM public.receiving_arrivals','permission denied');
SELECT pg_temp.reject('SELECT public.create_receiving_arrival(gen_random_uuid(),now(),''[]'')','permission denied');
RESET ROLE;
ROLLBACK;
SELECT 'PASS project-pending, legacy boundary, month-close, anonymous security; rolled back' result;
