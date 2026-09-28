BEGIN;
DO $$ BEGIN IF inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR current_database()<>'receiving_v5a_concurrency_20260924' THEN RAISE EXCEPTION 'LOCAL TEST DB ONLY'; END IF; END $$;
SELECT set_config('request.jwt.claims',jsonb_build_object('email',(SELECT email FROM public.team_members WHERE role='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1),'role','authenticated')::text,true);
INSERT INTO public.inventory_items(id,code,name,unit,category,requires_serial,is_se_maintenance_equipment) VALUES
('88000000-0000-4000-8000-000000000901','[TEST V5A RACE] plain','[TEST V5A RACE] plain','個','一般',false,false),
('88000000-0000-4000-8000-000000000902','[TEST V5A RACE] serial','[TEST V5A RACE] serial','台','設備維修',true,true);
SELECT public.create_office_equipment_arrival('88000000-0000-4000-8000-000000000910','88000000-0000-4000-8000-000000000901',5,now(),NULL,'[TEST V5A RACE]');
SELECT public.create_receiving_arrival('88000000-0000-4000-8000-000000000911','2000-01-01','[{"inventory_item_id":"88000000-0000-4000-8000-000000000901","quantity":4}]',NULL,'[TEST V5A RACE] A','2099-03-15');
SELECT public.create_receiving_arrival('88000000-0000-4000-8000-000000000912','2000-01-01','[{"inventory_item_id":"88000000-0000-4000-8000-000000000901","quantity":4}]',NULL,'[TEST V5A RACE] B','2099-03-15');
SELECT public.create_receiving_arrival('88000000-0000-4000-8000-000000000913','2000-01-01','[{"quantity":1,"raw_serials":["V5AR0001-AA"]}]',NULL,'[TEST V5A RACE] UNKNOWN','2099-03-15');
COMMIT;
SELECT jsonb_build_object(
'source',(SELECT id FROM public.se_supply_records WHERE inventory_item_id='88000000-0000-4000-8000-000000000901'),
'line_a',(SELECT l.id FROM public.receiving_arrival_lines l JOIN public.receiving_arrivals a ON a.id=l.arrival_id WHERE a.notes='[TEST V5A RACE] A'),
'line_b',(SELECT l.id FROM public.receiving_arrival_lines l JOIN public.receiving_arrivals a ON a.id=l.arrival_id WHERE a.notes='[TEST V5A RACE] B'),
'unknown_line',(SELECT l.id FROM public.receiving_arrival_lines l JOIN public.receiving_arrivals a ON a.id=l.arrival_id WHERE a.notes='[TEST V5A RACE] UNKNOWN')
) fixture;