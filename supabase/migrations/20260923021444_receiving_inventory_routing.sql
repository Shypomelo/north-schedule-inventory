-- Forward only. OFFICE receipts own stock effects; SITE receipts own delivery effects.
ALTER TABLE public.project_materials ADD COLUMN inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE RESTRICT;
ALTER TABLE public.se_supply_records
 ADD COLUMN inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 ADD COLUMN receiving_only boolean NOT NULL DEFAULT false,
 ADD COLUMN cancelled_at timestamptz, ADD COLUMN inventory_routed boolean NOT NULL DEFAULT false;
ALTER TABLE public.material_receipts
 ADD COLUMN receipt_location text CHECK(receipt_location IN ('OFFICE','SITE')),
 ADD COLUMN inventory_transaction_id uuid REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
 ADD COLUMN inventory_linked boolean NOT NULL DEFAULT false;
-- NULL location is deliberately retained for legacy events. No guessed backfill.
CREATE TABLE public.receiving_serial_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_material_id uuid REFERENCES public.project_materials(id) ON DELETE RESTRICT,
 se_supply_record_id uuid REFERENCES public.se_supply_records(id) ON DELETE RESTRICT,
 inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 raw_serial text NOT NULL,
 normalized_serial text GENERATED ALWAYS AS (public.normalize_inventory_serial(raw_serial)) STORED,
 inventory_serial_id uuid REFERENCES public.inventory_serials(id) ON DELETE RESTRICT,
 active_receipt_id uuid REFERENCES public.material_receipts(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES public.team_members(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(project_material_id,se_supply_record_id)=1), CHECK(btrim(raw_serial)<>''),
 CHECK(active_receipt_id IS NULL OR inventory_serial_id IS NOT NULL)
);
CREATE UNIQUE INDEX receiving_entry_project_key ON public.receiving_serial_entries(project_material_id,normalized_serial) WHERE project_material_id IS NOT NULL;
CREATE UNIQUE INDEX receiving_entry_se_key ON public.receiving_serial_entries(se_supply_record_id,normalized_serial) WHERE se_supply_record_id IS NOT NULL;
CREATE UNIQUE INDEX receiving_active_serial_key ON public.receiving_serial_entries(inventory_serial_id) WHERE active_receipt_id IS NOT NULL;
CREATE TABLE public.material_receipt_serials (
 receipt_id uuid NOT NULL REFERENCES public.material_receipts(id) ON DELETE RESTRICT,
 entry_id uuid NOT NULL REFERENCES public.receiving_serial_entries(id) ON DELETE RESTRICT,
 inventory_serial_id uuid NOT NULL REFERENCES public.inventory_serials(id) ON DELETE RESTRICT,
 linked_existing boolean NOT NULL,
 inventory_snapshot jsonb NOT NULL,
 PRIMARY KEY(receipt_id,entry_id), UNIQUE(receipt_id,inventory_serial_id)
);
CREATE TABLE app_private.receiving_requests (
 request_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.team_members(id),
 payload jsonb NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.receiving_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.receiving_requests FROM PUBLIC,anon,authenticated;
ALTER TABLE public.receiving_serial_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_receipt_serials ENABLE ROW LEVEL SECURITY;
CREATE POLICY receiving_entries_read ON public.receiving_serial_entries FOR SELECT TO authenticated USING(app_private.is_active_member());
CREATE POLICY receipt_serials_read ON public.material_receipt_serials FOR SELECT TO authenticated USING(app_private.is_active_member());
REVOKE ALL ON public.receiving_serial_entries,public.material_receipt_serials FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.receiving_serial_entries,public.material_receipt_serials TO authenticated;

-- 8+2 is an exact-only identity. Do not change the 9+2 full/short alias rules.
CREATE OR REPLACE FUNCTION public.classify_inventory_serial_format(p_serial text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path='' AS $$
 SELECT CASE
 WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z0-9]{8}-[A-Z0-9]{2}$' THEN 'exact'
 WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'short'
 WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'full'
 ELSE 'unknown' END
$$;

CREATE FUNCTION app_private.receiving_source(p_type text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r jsonb;
BEGIN
 IF p_type='PROJECT_MATERIAL' THEN
  SELECT to_jsonb(m) INTO r FROM public.project_materials m WHERE id=p_id FOR UPDATE;
  IF r->>'delivery_destination'<>'OFFICE' THEN RAISE EXCEPTION '只能接收北辦到貨'; END IF;
 ELSIF p_type='SE_SUPPLY' THEN
  SELECT to_jsonb(s) INTO r FROM public.se_supply_records s WHERE id=p_id FOR UPDATE;
  IF (r->>'cancelled_at') IS NOT NULL THEN RAISE EXCEPTION '到貨已取消'; END IF;
 ELSE RAISE EXCEPTION 'Invalid receiving source'; END IF;
 IF r IS NULL THEN RAISE EXCEPTION '找不到到貨來源'; END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app_private.receiving_source(text,uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.register_receiving_serial(p_source_type text,p_source_id uuid,p_inventory_item_id uuid,p_raw_serial text)
RETURNS public.receiving_serial_entries LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.team_members:=app_private.inventory_actor(); source jsonb; item public.inventory_items;
 entry public.receiving_serial_entries; name text:=public.normalize_inventory_serial(p_raw_serial);
BEGIN
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 source:=app_private.receiving_source(p_source_type,p_source_id);
 SELECT * INTO item FROM public.inventory_items WHERE id=p_inventory_item_id FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active OR NOT item.requires_serial OR item.unit IS DISTINCT FROM source->>'unit'
 THEN RAISE EXCEPTION '請選擇單位一致的有效序號品項'; END IF;
 IF source->>'inventory_item_id' IS NOT NULL AND (source->>'inventory_item_id')::uuid<>item.id THEN RAISE EXCEPTION '品項已變更'; END IF;
 IF name IS NULL OR public.classify_inventory_serial_format(name)='unknown' THEN RAISE EXCEPTION '序號格式無法辨識'; END IF;
 SELECT * INTO entry FROM public.receiving_serial_entries WHERE normalized_serial=name
 AND (project_material_id=p_source_id OR se_supply_record_id=p_source_id);
 IF FOUND THEN RETURN entry; END IF;
 IF EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE normalized_serial=name AND (active_receipt_id IS NOT NULL OR project_material_id IS DISTINCT FROM p_source_id AND se_supply_record_id IS DISTINCT FROM p_source_id))
 THEN RAISE EXCEPTION '需要確認：序號已登錄於另一筆到貨'; END IF;
 IF (SELECT count(*) FROM public.receiving_serial_entries WHERE project_material_id=p_source_id OR se_supply_record_id=p_source_id)>=(source->>'quantity')::numeric
 THEN RAISE EXCEPTION '序號數量超過需求'; END IF;
 IF p_source_type='PROJECT_MATERIAL' THEN UPDATE public.project_materials SET inventory_item_id=item.id WHERE id=p_source_id;
 ELSE UPDATE public.se_supply_records SET inventory_item_id=item.id WHERE id=p_source_id; END IF;
 INSERT INTO public.receiving_serial_entries(project_material_id,se_supply_record_id,inventory_item_id,raw_serial,created_by)
 VALUES(CASE WHEN p_source_type='PROJECT_MATERIAL' THEN p_source_id END,CASE WHEN p_source_type='SE_SUPPLY' THEN p_source_id END,item.id,p_raw_serial,a.id) RETURNING * INTO entry;
 RETURN entry;
END $$;
REVOKE ALL ON FUNCTION public.register_receiving_serial(text,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_receiving_serial(text,uuid,uuid,text) TO authenticated;

CREATE FUNCTION public.create_office_equipment_arrival(p_request_id uuid,p_item_id uuid,p_quantity numeric,p_expected_at timestamptz,p_project_id uuid DEFAULT NULL,p_notes text DEFAULT NULL,p_serials jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.team_members:=app_private.inventory_actor(); item public.inventory_items; r public.se_supply_records;
 payload jsonb:=jsonb_build_array('ARRIVAL',p_item_id,p_quantity,p_expected_at,p_project_id,p_notes,p_serials);
 cached app_private.receiving_requests; raw text;
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>a.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF;
  RETURN cached.response;
 END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO item FROM public.inventory_items WHERE id=p_item_id FOR UPDATE;
 IF jsonb_typeof(p_serials) IS DISTINCT FROM 'array' OR (SELECT count(DISTINCT public.normalize_inventory_serial(value)) FROM jsonb_array_elements_text(p_serials))<>jsonb_array_length(p_serials) THEN RAISE EXCEPTION '序號重複或格式錯誤'; END IF;
 IF item.id IS NULL OR NOT item.is_active OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity') OR (item.requires_serial AND p_quantity<>trunc(p_quantity))
 THEN RAISE EXCEPTION '請確認品項與數量'; END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION '案件不存在'; END IF;
 INSERT INTO public.se_supply_records(project_id,project_name,new_model,quantity,unit,expected_delivery_at,requested_by,notes,receive_method,inventory_item_id,receiving_only)
 VALUES(p_project_id,(SELECT project_name FROM public.projects WHERE id=p_project_id),item.code,p_quantity,item.unit,p_expected_at,a.id,p_notes,'SE 寄件到北辦',item.id,true) RETURNING * INTO r;
 FOR raw IN SELECT jsonb_array_elements_text(p_serials) LOOP
  PERFORM public.register_receiving_serial('SE_SUPPLY',r.id,item.id,raw);
 END LOOP;
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,a.id,payload,to_jsonb(r),now());
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.create_office_equipment_arrival(uuid,uuid,numeric,timestamptz,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_office_equipment_arrival(uuid,uuid,numeric,timestamptz,uuid,text,jsonb) TO authenticated;

-- Private composition helpers; old public receipt mutations cannot bypass Inventory.
ALTER FUNCTION public.confirm_material_receipt(text,uuid,numeric,timestamptz,text) SET SCHEMA app_private;
ALTER FUNCTION app_private.confirm_material_receipt(text,uuid,numeric,timestamptz,text) RENAME TO append_receiving_event;
REVOKE ALL ON FUNCTION app_private.append_receiving_event(text,uuid,numeric,timestamptz,text) FROM PUBLIC,anon,authenticated;
ALTER FUNCTION public.reverse_material_receipt(uuid,numeric,timestamptz,text) SET SCHEMA app_private;
ALTER FUNCTION app_private.reverse_material_receipt(uuid,numeric,timestamptz,text) RENAME TO append_receiving_reversal;
REVOKE ALL ON FUNCTION app_private.append_receiving_reversal(uuid,numeric,timestamptz,text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.confirm_material_receipt(p_source_type text,p_source_id uuid,p_quantity_received numeric,p_received_at timestamptz DEFAULT now(),p_notes text DEFAULT NULL)
RETURNS SETOF public.material_receipts LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION '請從物料到貨確認品項與序號後收貨；案場物料請使用送至案場'; END $$;
REVOKE ALL ON FUNCTION public.confirm_material_receipt(text,uuid,numeric,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.confirm_material_receipt(text,uuid,numeric,timestamptz,text) TO authenticated;
CREATE FUNCTION public.reverse_material_receipt(p_receipt_id uuid,p_quantity_reversed numeric,p_reversed_at timestamptz DEFAULT now(),p_notes text DEFAULT NULL)
RETURNS SETOF public.material_receipts LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.material_receipts WHERE id=p_receipt_id AND inventory_linked)
 THEN RAISE EXCEPTION '請從庫存關聯收貨更正，並選擇更正序號'; END IF;
 RETURN QUERY SELECT * FROM app_private.append_receiving_reversal(p_receipt_id,p_quantity_reversed,p_reversed_at,p_notes);
END $$;
REVOKE ALL ON FUNCTION public.reverse_material_receipt(uuid,numeric,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reverse_material_receipt(uuid,numeric,timestamptz,text) TO authenticated;

CREATE FUNCTION public.confirm_receiving_into_inventory(p_request_id uuid,p_source_type text,p_source_id uuid,p_item_id uuid,p_quantity numeric,p_entry_ids uuid[],p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.team_members:=app_private.inventory_actor(); source jsonb; item public.inventory_items;
 entry public.receiving_serial_entries; s public.inventory_serials; receipt public.material_receipts;
 payload jsonb:=jsonb_build_array('RECEIVE',p_source_type,p_source_id,p_item_id,p_quantity,p_entry_ids,p_received_at,p_notes);
 cached app_private.receiving_requests; new_serials jsonb:='[]'; tx jsonb; count_entries integer:=0;
 lookup record; before_serials jsonb:='{}'; effective numeric;
BEGIN
 IF p_request_id IS NULL OR p_received_at IS NULL OR NOT isfinite(p_received_at) THEN RAISE EXCEPTION 'Request/time required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>a.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF;
  RETURN cached.response;
 END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 source:=app_private.receiving_source(p_source_type,p_source_id);
 SELECT * INTO item FROM public.inventory_items WHERE id=p_item_id FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active OR item.unit IS DISTINCT FROM source->>'unit' THEN RAISE EXCEPTION '請選擇單位一致的有效庫存品項'; END IF;
 IF source->>'inventory_item_id' IS NOT NULL AND (source->>'inventory_item_id')::uuid<>item.id THEN RAISE EXCEPTION '需要確認：來源品項不符'; END IF;
 IF p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
 SELECT COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0) INTO effective
 FROM public.material_receipts WHERE (project_material_id=p_source_id OR se_supply_record_id=p_source_id) AND (receipt_location IS NULL OR receipt_location='OFFICE');
 IF effective+p_quantity>(source->>'quantity')::numeric OR (effective=0 AND source->>'procurement_status'='RECEIVED') THEN RAISE EXCEPTION '收到數量超過待收數量'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer OR (SELECT count(DISTINCT x) FROM unnest(p_entry_ids)x)<>p_quantity THEN RAISE EXCEPTION '每台實收設備必須選擇一個不同序號'; END IF;
  FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) ORDER BY id FOR UPDATE LOOP
   count_entries:=count_entries+1;
   IF entry.inventory_item_id<>item.id OR entry.active_receipt_id IS NOT NULL OR NOT COALESCE(entry.project_material_id=p_source_id OR entry.se_supply_record_id=p_source_id,false) THEN RAISE EXCEPTION '序號來源已變更或已收貨'; END IF;
   SELECT * INTO lookup FROM public.lookup_inventory_serial(entry.raw_serial,NULL,NULL);
   IF lookup.result_type NOT IN ('no_match','unique_match') THEN RAISE EXCEPTION '需要確認：序號身份衝突'; END IF;
   SELECT * INTO s FROM public.inventory_serials WHERE normalized_full=entry.normalized_serial FOR UPDATE;
   IF s.id IS NULL AND lookup.result_type<>'no_match' THEN RAISE EXCEPTION '需要確認：只能使用完整 exact identity'; END IF;
   IF s.id IS NOT NULL THEN
    IF app_private.inventory_effective_balance(item.id)<(SELECT count(*) FROM public.inventory_serials WHERE item_id=item.id AND status='在庫') THEN RAISE EXCEPTION '需要確認：在庫序號與庫存數量不一致'; END IF;
    IF s.item_id<>item.id OR s.status<>'在庫' THEN RAISE EXCEPTION '需要確認：序號屬於其他品項或目前狀態為 %',s.status; END IF;
    IF EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE inventory_serial_id=s.id AND active_receipt_id IS NOT NULL) THEN RAISE EXCEPTION '序號已由另一筆收貨認領'; END IF;
    IF EXISTS(SELECT 1 FROM public.se_supply_records WHERE inventory_serial_id=s.id AND replace_date IS NULL AND cancelled_at IS NULL AND NOT receiving_only) THEN RAISE EXCEPTION '需要確認：序號已被 SE 預留'; END IF;
    before_serials:=before_serials||jsonb_build_object(entry.id::text,to_jsonb(s));
   ELSE new_serials:=new_serials||jsonb_build_array(entry.normalized_serial); END IF;
  END LOOP;
  IF count_entries<>p_quantity THEN RAISE EXCEPTION '缺少序號'; END IF;
 ELSE
  IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION '一般料不得帶入序號'; END IF;
 END IF;
 IF NOT item.requires_serial OR jsonb_array_length(new_serials)>0 THEN
  tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',item.id,'transaction_type','IN',
   'quantity',CASE WHEN item.requires_serial THEN jsonb_array_length(new_serials) ELSE p_quantity END,
   'transaction_date',(p_received_at AT TIME ZONE 'Asia/Taipei')::date,'unit',item.unit,'source','北辦收貨','notes',p_notes),new_serials);
 END IF;
 SELECT * INTO receipt FROM app_private.append_receiving_event(p_source_type,p_source_id,p_quantity,p_received_at,p_notes);
 UPDATE public.material_receipts SET receipt_location='OFFICE',inventory_transaction_id=(tx->>'id')::uuid,inventory_linked=true WHERE id=receipt.id RETURNING * INTO receipt;
 FOR entry IN SELECT * FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) LOOP
  SELECT * INTO STRICT s FROM public.inventory_serials WHERE normalized_full=entry.normalized_serial;
  INSERT INTO public.material_receipt_serials VALUES(receipt.id,entry.id,s.id,before_serials ? entry.id::text,to_jsonb(s));
  UPDATE public.receiving_serial_entries SET inventory_serial_id=s.id,active_receipt_id=receipt.id,updated_at=clock_timestamp() WHERE id=entry.id;
 END LOOP;
 IF p_source_type='PROJECT_MATERIAL' THEN UPDATE public.project_materials SET inventory_item_id=item.id WHERE id=p_source_id;
 ELSE UPDATE public.se_supply_records SET inventory_item_id=item.id WHERE id=p_source_id; END IF;
 PERFORM app_private.rederive_material_receipt_source(p_source_type,p_source_id);
 PERFORM app_private.inventory_audit('RECEIVING_INVENTORY',before_serials,to_jsonb(receipt)||jsonb_build_object('inventory_transaction',tx),
 CASE WHEN before_serials<>'{}'::jsonb THEN 'Receiving linked existing inventory serial' ELSE '北辦確認收到並入庫' END);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,a.id,payload,to_jsonb(receipt),now());
 RETURN to_jsonb(receipt);
END $$;
REVOKE ALL ON FUNCTION public.confirm_receiving_into_inventory(uuid,text,uuid,uuid,numeric,uuid[],timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.confirm_receiving_into_inventory(uuid,text,uuid,uuid,numeric,uuid[],timestamptz,text) TO authenticated;

-- Capability rows are private, transaction-scoped, and never client-settable GUCs.
CREATE TABLE app_private.inventory_routing_context (
 backend integer NOT NULL, transaction_id bigint NOT NULL, receipt_id uuid, se_ids uuid[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(backend,transaction_id)
);
ALTER TABLE app_private.inventory_routing_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.inventory_routing_context FROM PUBLIC,anon,authenticated;
CREATE UNIQUE INDEX se_active_inventory_reservation ON public.se_supply_records(inventory_serial_id)
 WHERE inventory_serial_id IS NOT NULL AND replace_date IS NULL AND cancelled_at IS NULL AND NOT receiving_only;
CREATE FUNCTION app_private.guard_se_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.inventory_serials; item public.inventory_items;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.inventory_serial_id IS NOT NULL THEN RAISE EXCEPTION '請取消預留，保留供貨追蹤紀錄'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.replace_date IS NOT NULL AND row(NEW.inventory_serial_id,NEW.cancelled_at,NEW.receiving_only) IS DISTINCT FROM row(OLD.inventory_serial_id,OLD.cancelled_at,OLD.receiving_only)
 THEN RAISE EXCEPTION '已更換設備請從設備維修更正'; END IF;
 IF NEW.receiving_only AND NEW.inventory_serial_id IS NOT NULL THEN RAISE EXCEPTION '到貨群組不能直接預留單台設備'; END IF;
 IF NEW.inventory_serial_id IS NOT NULL THEN
  SELECT * INTO item FROM public.inventory_items WHERE id=(SELECT item_id FROM public.inventory_serials WHERE id=NEW.inventory_serial_id) FOR UPDATE;
  SELECT * INTO s FROM public.inventory_serials WHERE id=NEW.inventory_serial_id FOR UPDATE;
  IF NEW.quantity<>1 OR NOT item.requires_serial OR NOT item.is_active OR NOT item.is_se_maintenance_equipment
    OR public.normalize_inventory_serial(NEW.new_serial) IS DISTINCT FROM s.normalized_full
    OR NEW.new_model IS DISTINCT FROM item.code THEN RAISE EXCEPTION '需要確認：供貨追蹤與庫存身份不一致'; END IF;
  IF NEW.replace_date IS NULL AND NEW.cancelled_at IS NULL AND s.status<>'在庫' THEN RAISE EXCEPTION '只有在庫設備可預留'; END IF;
  NEW.inventory_item_id:=item.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_se_reservation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receiving_se_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.se_supply_records FOR EACH ROW EXECUTE FUNCTION app_private.guard_se_reservation();
CREATE FUNCTION app_private.guard_reserved_serial() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status='在庫' AND EXISTS(
  SELECT 1 FROM public.se_supply_records r WHERE r.inventory_serial_id=OLD.id AND r.replace_date IS NULL AND r.cancelled_at IS NULL AND NOT r.receiving_only
  AND NOT EXISTS(SELECT 1 FROM app_private.inventory_routing_context c WHERE c.backend=pg_backend_pid() AND c.transaction_id=txid_current() AND r.id=ANY(c.se_ids)))
 THEN RAISE EXCEPTION '此序號已由 SE 供貨預留，請由對應設備維修使用'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_reserved_serial() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receiving_reserved_serial_guard BEFORE UPDATE ON public.inventory_serials FOR EACH ROW EXECUTE FUNCTION app_private.guard_reserved_serial();

-- Preserve the released writer as the only ledger implementation.
ALTER FUNCTION public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) SET SCHEMA app_private;
ALTER FUNCTION app_private.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) RENAME TO write_inventory_transaction_before_routing;
REVOKE ALL ON FUNCTION app_private.write_inventory_transaction_before_routing(text,jsonb,jsonb,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.write_inventory_transaction_atomic(p_action text,p_data jsonb DEFAULT '{}',p_serials jsonb DEFAULT '[]',p_transaction_id uuid DEFAULT NULL,p_reason text DEFAULT NULL,p_expected_updated_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 IF p_action<>'CREATE' AND EXISTS(SELECT 1 FROM public.material_receipts r WHERE r.inventory_transaction_id=p_transaction_id
  AND NOT EXISTS(SELECT 1 FROM app_private.inventory_routing_context c WHERE c.backend=pg_backend_pid() AND c.transaction_id=txid_current() AND c.receipt_id=COALESCE(r.reversal_of_id,r.id)))
 THEN RAISE EXCEPTION '此庫存異動已關聯收貨，請從收貨更正'; END IF;
 RETURN app_private.write_inventory_transaction_before_routing(p_action,p_data,p_serials,p_transaction_id,p_reason,p_expected_updated_at);
END $$;
REVOKE ALL ON FUNCTION public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz) TO authenticated;

-- Maintenance retains its identity/version/project checks and its canonical OUT.
ALTER FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) SET SCHEMA app_private;
ALTER FUNCTION app_private.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) RENAME TO register_equipment_before_routing;
REVOKE ALL ON FUNCTION app_private.register_equipment_before_routing(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.register_maintenance_equipment_replacement(p_request_id uuid,p_schedule_task_id uuid,p_inventory_serial_id uuid,p_se_supply_record_id uuid,p_replaced_at timestamptz,p_notes text DEFAULT NULL,p_version text DEFAULT NULL,p_confirm_cross_project boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.inventory_actor();
 INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),NULL,ARRAY[p_se_supply_record_id]);
 result:=app_private.register_equipment_before_routing(p_request_id,p_schedule_task_id,p_inventory_serial_id,p_se_supply_record_id,p_replaced_at,p_notes,p_version,p_confirm_cross_project);
 DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) TO authenticated;

CREATE FUNCTION public.reserve_inventory_for_se(p_request_id uuid,p_serial_id uuid,p_project_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.team_members:=app_private.inventory_actor(); s public.inventory_serials; i public.inventory_items; r public.se_supply_records;
 payload jsonb:=jsonb_build_array('RESERVE',p_serial_id,p_project_id); cached app_private.receiving_requests;
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>a.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF; RETURN cached.response; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO i FROM public.inventory_items WHERE id=(SELECT item_id FROM public.inventory_serials WHERE id=p_serial_id) FOR UPDATE;
 SELECT * INTO s FROM public.inventory_serials WHERE id=p_serial_id FOR UPDATE;
 IF s.id IS NULL OR s.status<>'在庫' OR NOT i.is_se_maintenance_equipment THEN RAISE EXCEPTION '請選擇在庫 SE 設備'; END IF;
 IF p_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION '案件不存在'; END IF;
 IF EXISTS(SELECT 1 FROM public.se_supply_records other WHERE NOT other.receiving_only AND other.cancelled_at IS NULL AND other.replace_date IS NULL AND public.normalize_inventory_serial(other.new_serial)=s.normalized_full) THEN RAISE EXCEPTION '需要確認：已有相同序號供貨追蹤'; END IF;
 INSERT INTO public.se_supply_records(project_id,project_name,new_model,new_serial,inventory_serial_id,inventory_item_id,quantity,unit,receive_method,procurement_status,receive_date,received_at,inventory_routed)
 VALUES(p_project_id,(SELECT project_name FROM public.projects WHERE id=p_project_id),i.code,s.serial_number,s.id,i.id,1,i.unit,'北辦倉庫','RECEIVED',current_date,now(),true) RETURNING * INTO r;
 PERFORM app_private.inventory_audit('RESERVE_INVENTORY_FOR_SE',NULL,to_jsonb(r),'加入 SE 供貨追蹤，庫存不變');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,a.id,payload,to_jsonb(r),now());
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.reserve_inventory_for_se(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reserve_inventory_for_se(uuid,uuid,uuid) TO authenticated;

CREATE FUNCTION public.correct_receiving_inventory(p_request_id uuid,p_receipt_id uuid,p_quantity numeric,p_entry_ids uuid[],p_reversed_at timestamptz,p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.team_members:=app_private.inventory_actor(); receipt public.material_receipts; reversal public.material_receipts;
 tx public.inventory_transactions; detail record; s public.inventory_serials; qty_new integer:=0; serials jsonb;
 payload jsonb:=jsonb_build_array('CORRECT',p_receipt_id,p_quantity,p_entry_ids,p_reversed_at,p_notes); cached app_private.receiving_requests; result jsonb;
BEGIN
 IF p_request_id IS NULL OR nullif(btrim(p_notes),'') IS NULL THEN RAISE EXCEPTION '請填寫更正原因'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>a.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF; RETURN cached.response; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=p_receipt_id;
 IF receipt.id IS NULL OR receipt.event_type<>'RECEIVE' OR NOT receipt.inventory_linked OR receipt.receipt_location<>'OFFICE' THEN RAISE EXCEPTION '請選擇北辦庫存關聯收貨'; END IF;
 PERFORM app_private.receiving_source(receipt.source_type,COALESCE(receipt.project_material_id,receipt.se_supply_record_id));
 PERFORM 1 FROM public.inventory_items WHERE id IN (SELECT inventory_item_id FROM public.receiving_serial_entries WHERE active_receipt_id=receipt.id UNION SELECT item_id FROM public.inventory_transactions WHERE id=receipt.inventory_transaction_id) ORDER BY id FOR UPDATE;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=p_receipt_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.material_receipt_serials WHERE receipt_id=receipt.id) THEN
  IF cardinality(p_entry_ids) IS DISTINCT FROM p_quantity::integer OR p_quantity<>trunc(p_quantity) OR (SELECT count(DISTINCT x) FROM unnest(p_entry_ids)x)<>p_quantity THEN RAISE EXCEPTION '請選擇精確更正序號'; END IF;
  IF (SELECT count(*) FROM public.receiving_serial_entries WHERE id=ANY(p_entry_ids) AND active_receipt_id=receipt.id)<>p_quantity THEN RAISE EXCEPTION '序號已更正或不屬於本次收貨'; END IF;
  FOR detail IN SELECT * FROM public.material_receipt_serials WHERE receipt_id=receipt.id AND entry_id=ANY(p_entry_ids) LOOP
   SELECT * INTO s FROM public.inventory_serials WHERE id=detail.inventory_serial_id FOR UPDATE;
   IF s.status<>'在庫' OR (detail.linked_existing AND s.updated_at IS DISTINCT FROM (detail.inventory_snapshot->>'updated_at')::timestamptz)
    OR EXISTS(SELECT 1 FROM public.se_supply_records WHERE inventory_serial_id=s.id AND replace_date IS NULL AND cancelled_at IS NULL AND NOT receiving_only)
   THEN RAISE EXCEPTION '設備已有後續使用或預留，不可更正'; END IF;
   IF NOT detail.linked_existing THEN qty_new:=qty_new+1; END IF;
  END LOOP;
 ELSE
  IF COALESCE(cardinality(p_entry_ids),0)<>0 THEN RAISE EXCEPTION '一般料不得選序號'; END IF;
 END IF;
 INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),receipt.id,'{}');
 IF receipt.inventory_transaction_id IS NOT NULL THEN
  SELECT * INTO tx FROM public.inventory_transactions WHERE id=receipt.inventory_transaction_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.material_receipt_serials WHERE receipt_id=receipt.id) THEN
   -- A quantity receipt has no serial chronology; conservatively reject later stock debits.
   IF EXISTS(SELECT 1 FROM public.inventory_transactions t WHERE t.item_id=tx.item_id AND t.id<>tx.id AND t.created_at>=tx.created_at AND NOT t.is_voided AND t.excluded_by_initialization_id IS NULL AND (t.transaction_type='OUT' OR t.transaction_type='ADJUST' AND t.quantity<0)) THEN RAISE EXCEPTION '已有後續出庫，不可更正'; END IF;
  END IF;
  IF qty_new>0 OR NOT EXISTS(SELECT 1 FROM public.material_receipt_serials WHERE receipt_id=receipt.id) THEN
   IF tx.quantity=(CASE WHEN EXISTS(SELECT 1 FROM public.material_receipt_serials WHERE receipt_id=receipt.id) THEN qty_new ELSE p_quantity END) THEN
    result:=public.write_inventory_transaction_atomic('VOID','{}','[]',tx.id,p_notes,tx.updated_at);
   ELSE
    SELECT COALESCE(jsonb_agg(l.serial_no ORDER BY l.id),'[]') INTO serials FROM public.inventory_transaction_serials l WHERE l.transaction_id=tx.id AND l.serial_id NOT IN(SELECT inventory_serial_id FROM public.material_receipt_serials WHERE receipt_id=receipt.id AND entry_id=ANY(p_entry_ids));
    result:=public.write_inventory_transaction_atomic('EDIT',to_jsonb(tx)||jsonb_build_object('quantity',tx.quantity-CASE WHEN EXISTS(SELECT 1 FROM public.material_receipt_serials WHERE receipt_id=receipt.id) THEN qty_new ELSE p_quantity END),serials,tx.id,p_notes,tx.updated_at);
   END IF;
  END IF;
 END IF;
 SELECT * INTO reversal FROM app_private.append_receiving_reversal(receipt.id,p_quantity,p_reversed_at,p_notes);
 UPDATE public.material_receipts SET receipt_location='OFFICE',inventory_transaction_id=receipt.inventory_transaction_id,inventory_linked=true WHERE id=reversal.id RETURNING * INTO reversal;
 INSERT INTO public.material_receipt_serials SELECT reversal.id,entry_id,inventory_serial_id,linked_existing,inventory_snapshot FROM public.material_receipt_serials WHERE receipt_id=receipt.id AND entry_id=ANY(p_entry_ids);
 UPDATE public.receiving_serial_entries SET active_receipt_id=NULL,updated_at=clock_timestamp() WHERE id=ANY(p_entry_ids);
 DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 PERFORM app_private.inventory_audit('CORRECT_RECEIVING',to_jsonb(receipt),to_jsonb(reversal)||jsonb_build_object('inventory_correction',result),p_notes);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,a.id,payload,to_jsonb(reversal),now());
 RETURN to_jsonb(reversal);
END $$;
REVOKE ALL ON FUNCTION public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.correct_receiving_inventory(uuid,uuid,numeric,uuid[],timestamptz,text) TO authenticated;


CREATE FUNCTION public.deliver_inventory_to_project(p_request_id uuid,p_item_id uuid,p_project_id uuid,p_quantity numeric,p_serial_ids uuid[],p_material_id uuid,p_create_new boolean,p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.team_members:=app_private.inventory_actor(); item public.inventory_items; m public.project_materials;
 batch_id uuid; receipt public.material_receipts; tx jsonb; serials jsonb; remaining numeric;
 payload jsonb:=jsonb_build_array('DELIVER',p_item_id,p_project_id,p_quantity,p_serial_ids,p_material_id,p_create_new,p_received_at,p_notes);
 cached app_private.receiving_requests;
BEGIN
 IF p_request_id IS NULL OR p_received_at IS NULL OR NOT isfinite(p_received_at) THEN RAISE EXCEPTION 'Request/time required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>a.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF; RETURN cached.response; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION '請選擇有效案場'; END IF;
 IF p_material_id IS NOT NULL THEN SELECT * INTO m FROM public.project_materials WHERE id=p_material_id FOR UPDATE; END IF;
 SELECT * INTO item FROM public.inventory_items WHERE id=p_item_id FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active THEN RAISE EXCEPTION '品項不存在'; END IF;
 IF p_material_id IS NOT NULL THEN
  IF m.id IS NULL OR m.project_id<>p_project_id OR (m.inventory_item_id IS NOT NULL AND m.inventory_item_id<>item.id) OR m.unit<>item.unit OR m.delivery_destination<>'SITE' THEN RAISE EXCEPTION '需求品項、案場或送達位置不一致，請先確認關聯'; END IF;
 IF m.inventory_item_id IS NULL THEN UPDATE public.project_materials SET inventory_item_id=item.id WHERE id=m.id; END IF;
 ELSIF p_create_new IS TRUE THEN
  INSERT INTO public.project_material_batches(project_id,batch_name,created_by,ordered_at,planned_receipt_at)
  VALUES(p_project_id,'北辦庫存送達',a.id,p_received_at,p_received_at) RETURNING id INTO batch_id;
  INSERT INTO public.project_materials(project_id,batch_id,item_name,specification,quantity,unit,procurement_status,created_by,delivery_destination,inventory_item_id,include_in_purchase_request)
  VALUES(p_project_id,batch_id,item.name,item.code,p_quantity,item.unit,'ORDERED',a.id,'SITE',item.id,false) RETURNING * INTO m;
 ELSE RAISE EXCEPTION '請選擇需求，或明確選擇建立新的案場物料'; END IF;
 SELECT m.quantity-COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0) INTO remaining FROM public.material_receipts WHERE project_material_id=m.id AND (receipt_location='SITE' OR receipt_location IS NULL);
 IF p_quantity IS NULL OR p_quantity<=0 OR p_quantity>remaining OR m.procurement_status='RECEIVED' THEN RAISE EXCEPTION '數量超過待收需求'; END IF;
 IF item.requires_serial THEN
  IF cardinality(p_serial_ids) IS DISTINCT FROM p_quantity::integer OR p_quantity<>trunc(p_quantity) OR (SELECT count(DISTINCT x) FROM unnest(p_serial_ids)x)<>p_quantity THEN RAISE EXCEPTION '請選擇每台設備序號'; END IF;
  SELECT jsonb_agg(serial_number ORDER BY id) INTO serials FROM public.inventory_serials WHERE id=ANY(p_serial_ids) AND item_id=item.id AND status='在庫';
  IF jsonb_array_length(serials) IS DISTINCT FROM p_quantity::integer THEN RAISE EXCEPTION '序號狀態已變更'; END IF;
 ELSE
  IF COALESCE(cardinality(p_serial_ids),0)<>0 THEN RAISE EXCEPTION '一般料不得選序號'; END IF;
  serials:='[]';
 END IF;
 tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object('item_id',item.id,'transaction_type','OUT','quantity',p_quantity,'unit',item.unit,'project_id',p_project_id,'transaction_date',(p_received_at AT TIME ZONE 'Asia/Taipei')::date,'source','北辦送至案場','notes',p_notes),serials);
 SELECT * INTO receipt FROM app_private.append_receiving_event('PROJECT_MATERIAL',m.id,p_quantity,p_received_at,p_notes);
 UPDATE public.material_receipts SET receipt_location='SITE',inventory_transaction_id=(tx->>'id')::uuid,inventory_linked=true WHERE id=receipt.id RETURNING * INTO receipt;
 PERFORM app_private.rederive_material_receipt_source('PROJECT_MATERIAL',m.id);
 PERFORM app_private.inventory_audit('DELIVER_INVENTORY_TO_PROJECT',NULL,to_jsonb(receipt)||jsonb_build_object('project_id',p_project_id,'inventory_transaction',tx),'北辦出庫並送達案場');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,a.id,payload,to_jsonb(receipt),now());
 RETURN to_jsonb(receipt);
END $$;
REVOKE ALL ON FUNCTION public.deliver_inventory_to_project(uuid,uuid,uuid,numeric,uuid[],uuid,boolean,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.deliver_inventory_to_project(uuid,uuid,uuid,numeric,uuid[],uuid,boolean,timestamptz,text) TO authenticated;

-- Preserve destination semantics after events exist; do not reinterpret legacy history.
CREATE FUNCTION app_private.guard_receiving_source_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='project_materials' THEN
  IF EXISTS(SELECT 1 FROM public.material_receipts WHERE project_material_id=OLD.id) AND row(NEW.inventory_item_id,NEW.delivery_destination,NEW.project_id,NEW.unit) IS DISTINCT FROM row(OLD.inventory_item_id,OLD.delivery_destination,OLD.project_id,OLD.unit) AND NOT(OLD.inventory_item_id IS NULL AND NEW.delivery_destination=OLD.delivery_destination AND NEW.project_id=OLD.project_id AND NEW.unit=OLD.unit)
  THEN RAISE EXCEPTION '已有收貨歷史，不能改變品項或送達位置'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE se_supply_record_id=OLD.id) AND row(NEW.inventory_item_id,NEW.unit,NEW.receiving_only) IS DISTINCT FROM row(OLD.inventory_item_id,OLD.unit,OLD.receiving_only)
  THEN RAISE EXCEPTION '已有序號 association，不能改變來源品項'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_receiving_source_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receiving_project_source_guard BEFORE UPDATE ON public.project_materials FOR EACH ROW EXECUTE FUNCTION app_private.guard_receiving_source_identity();
CREATE TRIGGER receiving_se_source_guard BEFORE UPDATE ON public.se_supply_records FOR EACH ROW EXECUTE FUNCTION app_private.guard_receiving_source_identity();

CREATE OR REPLACE FUNCTION app_private.maintenance_equipment_candidates(p_project_id uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 WITH inv AS (
  SELECT s.*,i.code,i.name,i.is_active,i.requires_serial,i.is_se_maintenance_equipment,
   upper(btrim(s.serial_number)) AS identity_key
  FROM public.inventory_serials s JOIN public.inventory_items i ON i.id=s.item_id
 ), supply AS (
  SELECT r.*,upper(btrim(r.new_serial)) AS identity_key FROM public.se_supply_records r
  WHERE NOT r.receiving_only AND r.cancelled_at IS NULL AND nullif(btrim(r.new_serial),'') IS NOT NULL
 ), pairs AS (
  SELECT i.id AS iid,r.id AS rid FROM inv i LEFT JOIN supply r ON r.inventory_serial_id=i.id OR r.identity_key=i.identity_key
  UNION ALL
  SELECT NULL::uuid,r.id FROM supply r WHERE NOT EXISTS(SELECT 1 FROM inv i WHERE r.inventory_serial_id=i.id OR r.identity_key=i.identity_key)
 ), joined AS (
  SELECT i.id AS iid,i.item_id,i.serial_number,i.status,i.code,i.name,i.is_active,i.requires_serial,
   i.is_se_maintenance_equipment,r.id AS rid,r.new_serial,r.new_model,r.replace_date,r.quantity,
   r.project_id,r.project_name,r.inventory_serial_id,
   COALESCE('inventory:'||i.id::text,'se:'||r.identity_key) AS identity_key,
   CASE
    WHEN r.id IS NOT NULL AND r.inventory_serial_id IS NOT NULL AND EXISTS(SELECT 1 FROM inv other WHERE other.identity_key=r.identity_key AND other.id<>r.inventory_serial_id) THEN 'SE FK 與另一筆庫存序號衝突'
    WHEN r.id IS NOT NULL AND (SELECT count(*) FROM supply other WHERE other.identity_key=r.identity_key)>1 THEN '同序號對應多筆 SE 來源，需確認'
    WHEN i.id IS NOT NULL AND (NOT i.is_se_maintenance_equipment OR NOT i.is_active OR NOT i.requires_serial) THEN '庫存品項尚未確認為可用 SE 設備'
    WHEN i.id IS NOT NULL AND (i.status<>'在庫' OR public.classify_inventory_serial_format(i.serial_number)='unknown') THEN '庫存序號不可出庫，不可改以 SE 供貨登錄'
    WHEN r.id IS NOT NULL AND r.quantity<>1 THEN '供貨數量不是單台，需確認'
    WHEN r.id IS NOT NULL AND r.replace_date IS NOT NULL THEN 'SE 供貨已有更換紀錄'
    WHEN i.id IS NOT NULL AND r.id IS NOT NULL AND r.inventory_serial_id IS NOT NULL AND r.inventory_serial_id<>i.id THEN 'SE 序號 FK 與序號文字衝突'
    WHEN i.id IS NOT NULL AND r.id IS NOT NULL AND nullif(btrim(r.new_model),'') IS NOT NULL
      AND upper(btrim(r.new_model)) NOT IN (upper(btrim(i.code)),upper(btrim(i.name))) THEN '兩個來源型號不一致，需確認'
    WHEN r.id IS NOT NULL AND EXISTS(SELECT 1 FROM inv other WHERE other.id IS DISTINCT FROM i.id
       AND other.short_key=r.identity_key) THEN '僅短碼相符，設備身份需確認'
    WHEN i.id IS NOT NULL AND EXISTS(SELECT 1 FROM supply other WHERE other.id IS DISTINCT FROM r.id
       AND other.identity_key=i.short_key AND other.identity_key<>i.identity_key) THEN '另有 SE 短碼可能指向同一設備，需確認'
    WHEN r.id IS NOT NULL AND (r.new_serial ~ '[,;，；\n\r]' OR btrim(r.new_serial) ~ '\s') THEN '供貨序號無法明確認定為單台'
    ELSE NULL END AS conflict
  FROM pairs x LEFT JOIN inv i ON i.id=x.iid LEFT JOIN supply r ON r.id=x.rid
 ), grouped AS (
  SELECT identity_key,min(iid::text)::uuid AS iid,min(item_id::text)::uuid AS item_id,
   min(rid::text)::uuid AS rid, count(DISTINCT iid) AS inventory_count,count(DISTINCT rid) AS supply_count,
   COALESCE(min(serial_number),min(new_serial)) AS serial,
   COALESCE(min(code),nullif(min(new_model),''),'型號未填') AS model,
   min(name) AS item_name, min(project_name) AS project_name,
   string_agg(DISTINCT conflict,'；') AS conflict,
   bool_or(is_se_maintenance_equipment AND status='在庫') OR bool_or(rid IS NOT NULL AND replace_date IS NULL) AS visible,
   md5(string_agg(row(iid,item_id,serial_number,code,name,requires_serial,status,rid,new_serial,new_model,replace_date,quantity,project_id,project_name,inventory_serial_id,is_se_maintenance_equipment,is_active)::text,'|' ORDER BY iid,rid)) AS version
  FROM joined GROUP BY identity_key
 ) SELECT app_private.maintenance_cross_project(rid,p_project_id)||jsonb_build_object('key',identity_key,'inventory_serial_id',iid,'inventory_item_id',item_id,
  'se_supply_record_id',rid,'source_type',CASE WHEN iid IS NULL THEN 'SE_SUPPLY' WHEN rid IS NULL THEN 'INVENTORY' ELSE 'BOTH' END,
  'serial',serial,'model',model,'item_name',item_name,'project_name',project_name,'version',md5(version||p_project_id::text||COALESCE((SELECT p.project_name FROM public.projects p WHERE p.id=p_project_id),'')),
  'conflict',CASE WHEN inventory_count>1 OR supply_count>1 THEN '同序號對應多筆來源，需確認' ELSE conflict END,
  'eligible',inventory_count<=1 AND supply_count<=1 AND conflict IS NULL)
 FROM grouped WHERE visible
$$;



ALTER FUNCTION public.correct_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) SET SCHEMA app_private;
ALTER FUNCTION app_private.correct_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) RENAME TO correct_equipment_before_routing;
REVOKE ALL ON FUNCTION app_private.correct_equipment_before_routing(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.correct_maintenance_equipment_replacement(p_request_id uuid,p_record_id uuid,p_inventory_serial_id uuid,p_se_supply_record_id uuid,p_replaced_at timestamptz,p_notes text,p_version text,p_expected_revision bigint,p_confirm_cross_project boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.inventory_actor();
 INSERT INTO app_private.inventory_routing_context VALUES(pg_backend_pid(),txid_current(),NULL,ARRAY[p_se_supply_record_id,(SELECT se_supply_record_id FROM public.maintenance_equipment_records WHERE id=p_record_id)]);
 result:=app_private.correct_equipment_before_routing(p_request_id,p_record_id,p_inventory_serial_id,p_se_supply_record_id,p_replaced_at,p_notes,p_version,p_expected_revision,p_confirm_cross_project);
 DELETE FROM app_private.inventory_routing_context WHERE backend=pg_backend_pid() AND transaction_id=txid_current();
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.correct_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.correct_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.rederive_material_receipt_source(
    p_source_type text,
    p_source_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_effective numeric;
    v_completed_at timestamptz;
    v_completed_by uuid;
    v_batch_id uuid;
BEGIN
    SELECT COALESCE(sum(
        CASE WHEN receipt.event_type = 'REVERSAL'
            THEN -receipt.quantity_received
            ELSE receipt.quantity_received
        END
    ), 0)
    INTO v_effective
    FROM public.material_receipts AS receipt
    WHERE (p_source_type = 'PROJECT_MATERIAL' AND receipt.project_material_id = p_source_id AND (receipt.receipt_location IS NULL OR receipt.receipt_location=(SELECT delivery_destination FROM public.project_materials WHERE id=p_source_id)))
       OR (p_source_type = 'SE_SUPPLY' AND receipt.se_supply_record_id = p_source_id AND (receipt.receipt_location IS NULL OR receipt.receipt_location='OFFICE'));

    SELECT receipt.received_at, receipt.received_by
    INTO v_completed_at, v_completed_by
    FROM public.material_receipts AS receipt
    WHERE receipt.event_type = 'RECEIVE'
      AND (
        (p_source_type = 'PROJECT_MATERIAL' AND receipt.project_material_id = p_source_id AND (receipt.receipt_location IS NULL OR receipt.receipt_location=(SELECT delivery_destination FROM public.project_materials WHERE id=p_source_id)))
        OR (p_source_type = 'SE_SUPPLY' AND receipt.se_supply_record_id = p_source_id AND (receipt.receipt_location IS NULL OR receipt.receipt_location='OFFICE'))
      )
    ORDER BY receipt.received_at DESC, receipt.id DESC
    LIMIT 1;

    IF p_source_type = 'PROJECT_MATERIAL' THEN
        SELECT material.batch_id INTO v_batch_id
        FROM public.project_materials AS material
        WHERE material.id = p_source_id;

        UPDATE public.project_materials AS material
        SET procurement_status = CASE
                WHEN v_effective <= 0 THEN CASE
                    WHEN batch.ordered_at IS NULL THEN 'NOT_ORDERED'
                    ELSE 'ORDERED'
                END
                WHEN v_effective < material.quantity THEN 'PARTIAL_RECEIVED'
                ELSE 'RECEIVED'
            END,
            received_at = CASE WHEN v_effective >= material.quantity THEN v_completed_at ELSE NULL END,
            received_on = CASE WHEN v_effective >= material.quantity
                THEN (v_completed_at AT TIME ZONE 'Asia/Taipei')::date
                ELSE NULL
            END,
            updated_at = now()
        FROM public.project_material_batches AS batch
        WHERE material.id = p_source_id
          AND batch.id = material.batch_id;

        UPDATE public.project_material_batches AS batch
        SET received_at = CASE
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM public.project_materials AS material
                    WHERE material.batch_id = batch.id
                      AND (material.procurement_status <> 'RECEIVED' OR material.received_at IS NULL)
                ) THEN (
                    SELECT max(material.received_at)
                    FROM public.project_materials AS material
                    WHERE material.batch_id = batch.id
                )
                ELSE NULL
            END,
            updated_at = now()
        WHERE batch.id = v_batch_id;
    ELSIF p_source_type = 'SE_SUPPLY' THEN
        UPDATE public.se_supply_records AS record
        SET procurement_status = CASE
                WHEN v_effective <= 0 THEN 'ORDERED'
                WHEN v_effective < record.quantity THEN 'PARTIAL_RECEIVED'
                ELSE 'RECEIVED'
            END,
            received_at = CASE WHEN v_effective >= record.quantity THEN v_completed_at ELSE NULL END,
            received_by = CASE WHEN v_effective >= record.quantity THEN v_completed_by ELSE NULL END,
            receive_date = CASE WHEN v_effective >= record.quantity
                THEN (v_completed_at AT TIME ZONE 'Asia/Taipei')::date
                ELSE NULL
            END,
            updated_at = now()
        WHERE record.id = p_source_id;
    ELSE
        RAISE EXCEPTION 'Unsupported material receipt source' USING ERRCODE = '23514';
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.rederive_material_receipt_source(text, uuid)
FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cancel_se_inventory_reservation(p_record_id uuid,p_expected_updated_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.se_supply_records;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN RAISE EXCEPTION 'Only active editors can cancel a reservation' USING ERRCODE='42501'; END IF;
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO r FROM public.se_supply_records WHERE id=p_record_id FOR UPDATE;
 IF r.id IS NULL OR r.inventory_serial_id IS NULL OR r.receiving_only OR r.replace_date IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE se_supply_record_id=r.id)
 THEN RAISE EXCEPTION '只能取消尚未使用的 SE 庫存預留'; END IF;
 IF r.cancelled_at IS NOT NULL THEN RETURN; END IF;
 IF p_expected_updated_at IS NULL OR r.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION '資料已變更，請重新載入'; END IF;
 UPDATE public.se_supply_records SET cancelled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=r.id;
 PERFORM app_private.inventory_audit('CANCEL_SE_RESERVATION',to_jsonb(r),to_jsonb(r)||jsonb_build_object('cancelled_at',clock_timestamp()),'取消尚未使用的 SE 庫存預留');
END $$;
REVOKE ALL ON FUNCTION public.cancel_se_inventory_reservation(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cancel_se_inventory_reservation(uuid,timestamptz) TO authenticated;


CREATE OR REPLACE FUNCTION app_private.assert_maintenance_equipment_links(e public.maintenance_equipment_records)
RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF e.inventory_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.inventory_items i
  WHERE i.id=e.inventory_item_id AND i.is_active AND i.requires_serial AND i.is_se_maintenance_equipment AND i.code=e.model_snapshot)
 THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 原設備品項已變更' USING ERRCODE='PT409'; END IF;
 IF EXISTS(SELECT 1 FROM public.se_supply_records r WHERE NOT r.receiving_only AND r.cancelled_at IS NULL AND r.id IS DISTINCT FROM e.se_supply_record_id
  AND (r.inventory_serial_id=e.inventory_serial_id OR upper(btrim(r.new_serial))=upper(btrim(e.serial_snapshot))
   OR upper(btrim(r.new_serial))=(SELECT upper(btrim(x.new_serial)) FROM public.se_supply_records x WHERE x.id=e.se_supply_record_id)))
 THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 原設備出現重複 SE 來源' USING ERRCODE='PT409'; END IF;
 IF EXISTS(SELECT 1 FROM public.se_supply_records r JOIN public.inventory_serials s
  ON s.id=r.inventory_serial_id OR upper(btrim(s.serial_number))=upper(btrim(r.new_serial))
  WHERE r.id=e.se_supply_record_id AND s.id IS DISTINCT FROM e.inventory_serial_id)
 THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 原 SE 設備庫存身份已變更' USING ERRCODE='PT409'; END IF;
 IF e.inventory_transaction_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.inventory_transactions t JOIN public.inventory_transaction_serials l ON l.transaction_id=t.id
  JOIN public.inventory_serials s ON s.id=l.serial_id
  WHERE t.id=e.inventory_transaction_id AND t.is_voided IS NOT TRUE AND t.excluded_by_initialization_id IS NULL
   AND t.transaction_type='OUT' AND t.quantity=1 AND t.item_id=e.inventory_item_id
   AND t.project_id=e.project_id AND t.schedule_task_id=e.schedule_task_id
   AND s.id=e.inventory_serial_id AND s.item_id=e.inventory_item_id AND s.status='已出庫' AND s.project_id=e.project_id
   AND s.serial_number=e.serial_snapshot
   AND (SELECT count(*) FROM public.inventory_transaction_serials x WHERE x.transaction_id=t.id)=1
 ) THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 原庫存紀錄已異動，無法安全修改' USING ERRCODE='PT409'; END IF;
 IF e.se_supply_record_id IS NOT NULL AND (NOT e.se_replace_owned OR NOT EXISTS (
  SELECT 1 FROM public.se_supply_records r WHERE r.id=e.se_supply_record_id
  AND r.replace_date=(e.replaced_at AT TIME ZONE 'Asia/Taipei')::date AND r.quantity=1
 )) THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: SE 日期非本事件持有，無法安全修改' USING ERRCODE='PT409'; END IF;
END $$;
REVOKE ALL ON FUNCTION app_private.assert_maintenance_equipment_links(public.maintenance_equipment_records) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.change_se_inventory_reservation(p_record_id uuid,p_serial_id uuid,p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.se_supply_records; s public.inventory_serials; item public.inventory_items;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN RAISE EXCEPTION 'Only active editors can change a reservation' USING ERRCODE='42501'; END IF;
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO r FROM public.se_supply_records WHERE id=p_record_id FOR UPDATE;
 IF r.id IS NULL OR r.inventory_serial_id IS NULL OR r.receiving_only OR r.replace_date IS NOT NULL OR r.cancelled_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE se_supply_record_id=r.id)
 THEN RAISE EXCEPTION '只能修改尚未使用的 SE 庫存預留'; END IF;
 IF r.inventory_serial_id=p_serial_id THEN RETURN to_jsonb(r); END IF;
 IF p_expected_updated_at IS NULL OR r.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION '資料已變更，請重新載入'; END IF;
 PERFORM 1 FROM public.inventory_items WHERE id IN(r.inventory_item_id,(SELECT item_id FROM public.inventory_serials WHERE id=p_serial_id)) ORDER BY id FOR UPDATE;
 SELECT * INTO s FROM public.inventory_serials WHERE id=p_serial_id FOR UPDATE;
 SELECT * INTO item FROM public.inventory_items WHERE id=s.item_id;
 IF s.id IS NULL OR s.status<>'在庫' OR NOT item.is_active OR NOT item.is_se_maintenance_equipment THEN RAISE EXCEPTION '請選擇在庫 SE 設備'; END IF;
 IF EXISTS(SELECT 1 FROM public.se_supply_records other WHERE other.id<>r.id AND NOT other.receiving_only AND other.cancelled_at IS NULL AND other.replace_date IS NULL AND public.normalize_inventory_serial(other.new_serial)=s.normalized_full) THEN RAISE EXCEPTION '需要確認：已有相同序號供貨追蹤'; END IF;
 UPDATE public.se_supply_records SET inventory_serial_id=s.id,inventory_item_id=item.id,new_model=item.code,new_serial=s.serial_number,unit=item.unit,updated_at=clock_timestamp() WHERE id=r.id;
 PERFORM app_private.inventory_audit('CHANGE_SE_RESERVATION',to_jsonb(r),(SELECT to_jsonb(x) FROM public.se_supply_records x WHERE id=r.id),'換台預留，解除原序號預留，庫存不變');
 RETURN (SELECT to_jsonb(x) FROM public.se_supply_records x WHERE id=r.id);
END $$;
REVOKE ALL ON FUNCTION public.change_se_inventory_reservation(uuid,uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.change_se_inventory_reservation(uuid,uuid,timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_material_receipt_schedule(p_schedule_task_id uuid,p_completed_at timestamptz DEFAULT now())
RETURNS SETOF public.schedule_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task public.schedule_tasks; m public.project_materials; remaining numeric; ids uuid[];
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN RAISE EXCEPTION 'Only active editors can receive' USING ERRCODE='42501'; END IF;
 SELECT * INTO task FROM public.schedule_tasks WHERE id=p_schedule_task_id FOR UPDATE;
 IF task.id IS NULL OR task.deleted_at IS NOT NULL OR task.status='取消' OR task.source_material_batch_id IS NULL OR task.source_material_receipt_at IS NULL OR btrim(task.task_type)<>'收料' THEN RAISE EXCEPTION '收料排程不存在'; END IF;
 IF task.status='完成' THEN RETURN NEXT task; RETURN; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 FOR m IN SELECT * FROM public.project_materials WHERE batch_id=task.source_material_batch_id AND COALESCE(expected_delivery_at,(SELECT planned_receipt_at FROM public.project_material_batches WHERE id=task.source_material_batch_id))=task.source_material_receipt_at ORDER BY id FOR UPDATE LOOP
  SELECT m.quantity-COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0) INTO remaining FROM public.material_receipts WHERE project_material_id=m.id AND (receipt_location IS NULL OR receipt_location=m.delivery_destination);
  IF remaining>0 AND m.procurement_status<>'RECEIVED' THEN
   IF m.delivery_destination<>'OFFICE' THEN RAISE EXCEPTION '案場收貨請由庫存「送至案場」確認實際交付'; END IF;
   IF m.inventory_item_id IS NULL THEN RAISE EXCEPTION '請先在物料到貨確認庫存品項與序號'; END IF;
   SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO ids FROM public.receiving_serial_entries WHERE project_material_id=m.id AND active_receipt_id IS NULL;
   PERFORM public.confirm_receiving_into_inventory(gen_random_uuid(),'PROJECT_MATERIAL',m.id,m.inventory_item_id,remaining,ids,p_completed_at,'由收料排程完成');
  END IF;
 END LOOP;
 UPDATE public.schedule_tasks SET status='完成',updated_at=p_completed_at WHERE id=task.id RETURNING * INTO task;
 RETURN NEXT task;
END $$;

CREATE OR REPLACE FUNCTION app_private.append_receiving_event(
    p_source_type text,
    p_source_id uuid,
    p_quantity_received numeric,
    p_received_at timestamptz DEFAULT now(),
    p_notes text DEFAULT NULL
)
RETURNS SETOF public.material_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_member_id uuid;
    v_receipt public.material_receipts%ROWTYPE;
    v_material public.project_materials%ROWTYPE;
    v_se public.se_supply_records%ROWTYPE;
    v_received numeric;
    v_receipt_count integer;
BEGIN
    IF NOT app_private.is_editor_member() THEN
        RAISE EXCEPTION 'Only active editor members can confirm receipts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_member_id := app_private.current_member_id();
    IF v_member_id IS NULL THEN
        RAISE EXCEPTION 'Current active member not found'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_source_type NOT IN ('PROJECT_MATERIAL', 'SE_SUPPLY') THEN
        RAISE EXCEPTION 'Unsupported material receipt source' USING ERRCODE = '23514';
    END IF;
    IF p_quantity_received IS NULL OR p_quantity_received <= 0 THEN
        RAISE EXCEPTION 'Received quantity must be positive' USING ERRCODE = '23514';
    END IF;
    IF p_received_at IS NULL THEN
        RAISE EXCEPTION 'Received time is required' USING ERRCODE = '23502';
    END IF;

    IF p_source_type = 'PROJECT_MATERIAL' THEN
        SELECT * INTO v_material
        FROM public.project_materials WHERE id = p_source_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Project material not found' USING ERRCODE = 'P0002'; END IF;

        SELECT COALESCE(sum(CASE WHEN receipt.event_type = 'REVERSAL'
                    THEN -receipt.quantity_received ELSE receipt.quantity_received END), 0),
               count(*)
        INTO v_received, v_receipt_count
        FROM public.material_receipts AS receipt
        WHERE receipt.project_material_id = v_material.id AND (receipt.receipt_location IS NULL OR receipt.receipt_location=v_material.delivery_destination);

        IF (v_receipt_count = 0 AND (v_material.procurement_status = 'RECEIVED' OR v_material.received_at IS NOT NULL))
           OR v_received >= v_material.quantity THEN
            RAISE EXCEPTION 'Project material is already fully received' USING ERRCODE = '23514';
        END IF;
        IF p_quantity_received > v_material.quantity - v_received THEN
            RAISE EXCEPTION 'Received quantity exceeds the remaining project material quantity' USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.material_receipts (
            source_type, project_material_id, event_type, quantity_received,
            received_by, received_at, notes
        ) VALUES (
            'PROJECT_MATERIAL', v_material.id, 'RECEIVE', p_quantity_received,
            v_member_id, p_received_at, NULLIF(btrim(COALESCE(p_notes, '')), '')
        ) RETURNING * INTO v_receipt;
    ELSE
        SELECT * INTO v_se
        FROM public.se_supply_records WHERE id = p_source_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'SE supply record not found' USING ERRCODE = 'P0002'; END IF;

        SELECT COALESCE(sum(CASE WHEN receipt.event_type = 'REVERSAL'
                    THEN -receipt.quantity_received ELSE receipt.quantity_received END), 0),
               count(*)
        INTO v_received, v_receipt_count
        FROM public.material_receipts AS receipt
        WHERE receipt.se_supply_record_id = v_se.id AND (receipt.receipt_location IS NULL OR receipt.receipt_location='OFFICE');

        IF (v_receipt_count = 0 AND (v_se.procurement_status = 'RECEIVED' OR v_se.received_at IS NOT NULL))
           OR v_received >= v_se.quantity THEN
            RAISE EXCEPTION 'SE supply is already fully received' USING ERRCODE = '23514';
        END IF;
        IF p_quantity_received > v_se.quantity - v_received THEN
            RAISE EXCEPTION 'Received quantity exceeds the remaining SE supply quantity' USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.material_receipts (
            source_type, se_supply_record_id, event_type, quantity_received,
            received_by, received_at, notes
        ) VALUES (
            'SE_SUPPLY', v_se.id, 'RECEIVE', p_quantity_received,
            v_member_id, p_received_at, NULLIF(btrim(COALESCE(p_notes, '')), '')
        ) RETURNING * INTO v_receipt;
    END IF;

    PERFORM app_private.rederive_material_receipt_source(p_source_type, p_source_id);
    RETURN NEXT v_receipt;
END;
$function$;
