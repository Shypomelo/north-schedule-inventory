-- Provenance only. Inventory remains the stock ledger; all mutations use canonical RPCs.
CREATE TABLE public.receiving_inventory_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 office_receipt_id uuid NOT NULL REFERENCES public.material_receipts(id) ON DELETE RESTRICT,
 inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 inventory_serial_id uuid REFERENCES public.inventory_serials(id) ON DELETE RESTRICT,
 quantity numeric NOT NULL CHECK(quantity>0 AND quantity::text NOT IN ('NaN','Infinity','-Infinity')),
 route_type text NOT NULL CHECK(route_type IN ('SE','SITE')),
 se_supply_record_id uuid REFERENCES public.se_supply_records(id) ON DELETE RESTRICT,
 project_material_id uuid REFERENCES public.project_materials(id) ON DELETE RESTRICT,
 inventory_transaction_id uuid REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
 site_receipt_id uuid REFERENCES public.material_receipts(id) ON DELETE RESTRICT,
 cancelled_at timestamptz,
 created_by uuid NOT NULL REFERENCES public.team_members(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(inventory_serial_id IS NULL OR quantity=1),
 CHECK((route_type='SE' AND se_supply_record_id IS NOT NULL AND inventory_serial_id IS NOT NULL AND site_receipt_id IS NULL AND inventory_transaction_id IS NULL AND project_material_id IS NULL)
 OR (route_type='SITE' AND se_supply_record_id IS NULL AND site_receipt_id IS NOT NULL AND inventory_transaction_id IS NOT NULL AND project_material_id IS NOT NULL))
);
CREATE INDEX receiving_allocation_receipt ON public.receiving_inventory_allocations(office_receipt_id);
CREATE UNIQUE INDEX receiving_allocation_active_serial ON public.receiving_inventory_allocations(inventory_serial_id) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX receiving_allocation_se ON public.receiving_inventory_allocations(se_supply_record_id) WHERE se_supply_record_id IS NOT NULL;
ALTER TABLE public.receiving_inventory_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receiving_inventory_allocations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.receiving_inventory_allocations TO authenticated;
CREATE POLICY receiving_allocation_read ON public.receiving_inventory_allocations FOR SELECT TO authenticated USING(app_private.is_active_member());

-- Also covers mutations from the existing SE list, not just Receiving.
CREATE FUNCTION app_private.sync_receiving_se_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE alloc public.receiving_inventory_allocations;
BEGIN
 SELECT * INTO alloc FROM public.receiving_inventory_allocations WHERE se_supply_record_id=OLD.id AND cancelled_at IS NULL FOR UPDATE;
 IF alloc.id IS NULL THEN RETURN NEW; END IF;
 IF NEW.inventory_serial_id IS DISTINCT FROM OLD.inventory_serial_id THEN
  IF NOT EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE active_receipt_id=alloc.office_receipt_id AND inventory_serial_id=NEW.inventory_serial_id AND retired_at IS NULL) THEN RAISE EXCEPTION '只能改為同一筆北辦收貨的序號'; END IF;
  UPDATE public.receiving_inventory_allocations SET inventory_serial_id=NEW.inventory_serial_id WHERE id=alloc.id;
 END IF;
 IF NEW.cancelled_at IS NOT NULL THEN UPDATE public.receiving_inventory_allocations SET cancelled_at=NEW.cancelled_at WHERE id=alloc.id; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.sync_receiving_se_allocation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receiving_se_allocation_sync AFTER UPDATE ON public.se_supply_records FOR EACH ROW EXECUTE FUNCTION app_private.sync_receiving_se_allocation();

CREATE FUNCTION public.route_receiving_inventory(p_request_id uuid,p_receipt_id uuid,p_route_type text,p_quantity numeric,p_serial_ids uuid[],p_project_id uuid,p_material_id uuid,p_create_new boolean,p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); receipt public.material_receipts; source jsonb; item public.inventory_items;
 cached app_private.receiving_requests; payload jsonb:=jsonb_build_array('RECEIPT_ROUTE',p_receipt_id,p_route_type,p_quantity,p_serial_ids,p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
 effective numeric; allocated numeric; serial_id uuid; result jsonb; response jsonb:='[]'; source_item uuid;
BEGIN
 IF p_request_id IS NULL OR p_received_at IS NULL OR NOT isfinite(p_received_at) OR p_route_type NOT IN ('SE','SITE') OR p_route_type IS NULL THEN RAISE EXCEPTION 'Invalid route request'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF; RETURN cached.response; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=p_receipt_id;
 IF receipt.id IS NULL OR receipt.event_type<>'RECEIVE' OR receipt.receipt_location<>'OFFICE' OR NOT receipt.inventory_linked THEN RAISE EXCEPTION '請選擇已入庫的北辦收貨'; END IF;
 source:=app_private.receiving_source(receipt.source_type,COALESCE(receipt.project_material_id,receipt.se_supply_record_id));
 IF source->>'receiving_archived_at' IS NOT NULL THEN RAISE EXCEPTION '此到貨已取消或隱藏，請先確認來源'; END IF;
 SELECT * INTO receipt FROM public.material_receipts WHERE id=p_receipt_id FOR UPDATE;
 source_item:=(source->>'inventory_item_id')::uuid;
 SELECT * INTO item FROM public.inventory_items WHERE id=source_item FOR UPDATE;
 IF item.id IS NULL OR NOT item.is_active THEN RAISE EXCEPTION '找不到收貨品項'; END IF;
 IF p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid allocation quantity'; END IF;
 SELECT receipt.quantity_received-COALESCE(sum(quantity_received),0) INTO effective FROM public.material_receipts WHERE reversal_of_id=receipt.id AND event_type='REVERSAL';
 SELECT COALESCE(sum(quantity),0) INTO allocated FROM public.receiving_inventory_allocations WHERE office_receipt_id=receipt.id AND cancelled_at IS NULL;
 IF p_quantity>effective-allocated THEN RAISE EXCEPTION '超過本批可分配數量'; END IF;
 IF item.requires_serial THEN
  IF p_quantity<>trunc(p_quantity) OR cardinality(p_serial_ids) IS DISTINCT FROM p_quantity::integer OR (SELECT count(DISTINCT x) FROM unnest(p_serial_ids)x)<>p_quantity THEN RAISE EXCEPTION '請選擇本次分配的不同序號'; END IF;
  IF (SELECT count(*) FROM public.receiving_serial_entries WHERE active_receipt_id=receipt.id AND inventory_serial_id=ANY(p_serial_ids) AND retired_at IS NULL)<>p_quantity THEN RAISE EXCEPTION '序號不屬於這筆北辦收貨'; END IF;
  IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations WHERE inventory_serial_id=ANY(p_serial_ids) AND cancelled_at IS NULL) THEN RAISE EXCEPTION '序號已有後續用途'; END IF;
 ELSE
  IF COALESCE(cardinality(p_serial_ids),0)<>0 OR p_route_type='SE' THEN RAISE EXCEPTION '無序號物料不適用 SE 序號預留'; END IF;
 END IF;
 IF p_route_type='SE' THEN
  FOREACH serial_id IN ARRAY p_serial_ids LOOP
   result:=public.reserve_inventory_for_se(gen_random_uuid(),serial_id,p_project_id);
   INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,inventory_serial_id,quantity,route_type,se_supply_record_id,created_by)
    VALUES(receipt.id,item.id,serial_id,1,'SE',(result->>'id')::uuid,actor.id);
   response:=response||jsonb_build_array(result);
  END LOOP;
 ELSE
  result:=public.deliver_inventory_to_project(gen_random_uuid(),item.id,p_project_id,p_quantity,p_serial_ids,p_material_id,p_create_new,p_received_at,p_notes);
  IF item.requires_serial THEN
   FOREACH serial_id IN ARRAY p_serial_ids LOOP
    INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,inventory_serial_id,quantity,route_type,project_material_id,inventory_transaction_id,site_receipt_id,created_by)
    VALUES(receipt.id,item.id,serial_id,1,'SITE',(result->>'project_material_id')::uuid,(result->>'inventory_transaction_id')::uuid,(result->>'id')::uuid,actor.id);
   END LOOP;
  ELSE
   INSERT INTO public.receiving_inventory_allocations(office_receipt_id,inventory_item_id,quantity,route_type,project_material_id,inventory_transaction_id,site_receipt_id,created_by)
   VALUES(receipt.id,item.id,p_quantity,'SITE',(result->>'project_material_id')::uuid,(result->>'inventory_transaction_id')::uuid,(result->>'id')::uuid,actor.id);
  END IF;
  response:=jsonb_build_array(result);
 END IF;
 PERFORM app_private.inventory_audit('ROUTE_RECEIVING',to_jsonb(receipt),jsonb_build_object('id',receipt.id,'allocations',response),'北辦收貨來源分配');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,response,now());
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text) TO authenticated;

CREATE FUNCTION public.change_receiving_se_project(p_record_id uuid,p_project_id uuid,p_expected_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.se_supply_records; result jsonb; target_name text;
BEGIN
 PERFORM app_private.inventory_actor();
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO r FROM public.se_supply_records WHERE id=p_record_id FOR UPDATE;
 IF r.id IS NULL OR p_expected_updated_at IS NULL OR r.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION '資料已變更，請重新載入'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.receiving_inventory_allocations WHERE se_supply_record_id=r.id AND cancelled_at IS NULL) THEN RAISE EXCEPTION '找不到收貨預留關聯'; END IF;
 result:=public.change_se_inventory_reservation(r.id,r.inventory_serial_id,p_expected_updated_at);
 IF p_project_id IS NOT NULL THEN
  SELECT p.project_name INTO target_name FROM public.projects p WHERE p.id=p_project_id AND p.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION '請選擇有效案件'; END IF;
 END IF;
 UPDATE public.se_supply_records SET project_id=p_project_id,project_name=target_name,updated_at=clock_timestamp() WHERE id=r.id RETURNING to_jsonb(se_supply_records.*) INTO result;
 PERFORM app_private.inventory_audit('CHANGE_SE_PROJECT',to_jsonb(r),result,'修改未使用的 SE 預留案件');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.change_receiving_se_project(uuid,uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.change_receiving_se_project(uuid,uuid,timestamptz) TO authenticated;

CREATE FUNCTION public.cancel_receiving_arrival(p_request_id uuid,p_source_type text,p_source_id uuid,p_notes text,p_hide_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); source jsonb; receipt public.material_receipts; remaining numeric; ids uuid[];
 payload jsonb:=jsonb_build_array('CANCEL_ARRIVAL',p_source_type,p_source_id,p_notes,p_hide_only); cached app_private.receiving_requests; result jsonb; total numeric:=0;
BEGIN
 IF p_request_id IS NULL OR nullif(btrim(p_notes),'') IS NULL OR p_hide_only IS NULL THEN RAISE EXCEPTION '請填寫取消或隱藏原因'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'Request conflict'; END IF; RETURN cached.response; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 source:=app_private.receiving_source(p_source_type,p_source_id);
 IF NOT p_hide_only THEN
  IF EXISTS(SELECT 1 FROM public.receiving_inventory_allocations a JOIN public.material_receipts r ON r.id=a.office_receipt_id
   WHERE (r.project_material_id=p_source_id OR r.se_supply_record_id=p_source_id) AND a.cancelled_at IS NULL AND a.route_type='SITE') THEN RAISE EXCEPTION '此批物料已送至案場，無法直接撤銷收貨。'; END IF;
  IF EXISTS(SELECT 1 FROM public.receiving_serial_entries e JOIN public.se_supply_records s ON s.inventory_serial_id=e.inventory_serial_id
   WHERE (e.project_material_id=p_source_id OR e.se_supply_record_id=p_source_id) AND e.active_receipt_id IS NOT NULL AND s.cancelled_at IS NULL AND NOT s.receiving_only) THEN RAISE EXCEPTION '此設備已預留至 SE 供貨或已維修使用，請先依既有流程處理。'; END IF;
  IF EXISTS(SELECT 1 FROM public.receiving_serial_entries e JOIN public.inventory_serials s ON s.id=e.inventory_serial_id
   WHERE (e.project_material_id=p_source_id OR e.se_supply_record_id=p_source_id) AND e.active_receipt_id IS NOT NULL AND s.status<>'在庫') THEN RAISE EXCEPTION '此設備已有出庫或後續使用，無法直接撤銷收貨。'; END IF;
  FOR receipt IN SELECT * FROM public.material_receipts WHERE (project_material_id=p_source_id OR se_supply_record_id=p_source_id) AND event_type='RECEIVE' AND (receipt_location='OFFICE' OR receipt_location IS NULL) ORDER BY received_at DESC,id FOR UPDATE LOOP
   SELECT receipt.quantity_received-COALESCE(sum(quantity_received),0) INTO remaining FROM public.material_receipts WHERE reversal_of_id=receipt.id AND event_type='REVERSAL';
   IF remaining<=0 THEN CONTINUE; END IF;
   IF NOT receipt.inventory_linked OR receipt.receipt_location IS NULL THEN RAISE EXCEPTION '舊收貨尚無完整庫存關聯，無法自動撤銷；請先確認歷史。'; END IF;
   SELECT COALESCE(array_agg(id),'{}') INTO ids FROM public.receiving_serial_entries WHERE active_receipt_id=receipt.id;
   PERFORM public.correct_receiving_inventory(gen_random_uuid(),receipt.id,remaining,ids,clock_timestamp(),p_notes);
   total:=total+remaining;
  END LOOP;
  IF total=0 AND NOT EXISTS(SELECT 1 FROM public.material_receipts WHERE project_material_id=p_source_id OR se_supply_record_id=p_source_id)
   AND (source->>'procurement_status'='RECEIVED' OR source->>'received_at' IS NOT NULL OR source->>'receive_date' IS NOT NULL) THEN RAISE EXCEPTION '舊收貨缺少 receipt，無法自動撤銷。'; END IF;
  UPDATE public.receiving_serial_entries SET retired_at=COALESCE(retired_at,clock_timestamp()),updated_at=clock_timestamp()
   WHERE (project_material_id=p_source_id OR se_supply_record_id=p_source_id) AND active_receipt_id IS NULL;
 END IF;
 IF p_source_type='PROJECT_MATERIAL' THEN UPDATE public.project_materials SET receiving_archived_at=clock_timestamp() WHERE id=p_source_id;
 ELSE UPDATE public.se_supply_records SET receiving_archived_at=clock_timestamp() WHERE id=p_source_id; END IF;
 result:=jsonb_build_object('id',p_source_id,'source_id',p_source_id,'hidden',true,'reversed_quantity',total,'hide_only',p_hide_only);
 PERFORM app_private.inventory_audit(CASE WHEN p_hide_only THEN 'HIDE_RECEIVING' ELSE 'CANCEL_RECEIVING' END,source,result,p_notes);
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.cancel_receiving_arrival(uuid,text,uuid,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cancel_receiving_arrival(uuid,text,uuid,text,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';

-- Read projection joins existing receipts, identities and business records; no copied audit ledger.
CREATE FUNCTION public.get_receiving_source_details(p_source_type text,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT COALESCE(app_private.is_active_member(),false) THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF p_source_type NOT IN ('SE_SUPPLY','PROJECT_MATERIAL') OR p_source_type IS NULL THEN RAISE EXCEPTION 'Invalid source'; END IF;
 WITH receipts AS (SELECT * FROM public.material_receipts WHERE (p_source_type='PROJECT_MATERIAL' AND project_material_id=p_source_id) OR (p_source_type='SE_SUPPLY' AND se_supply_record_id=p_source_id)),
 entries AS (SELECT * FROM public.receiving_serial_entries WHERE (p_source_type='PROJECT_MATERIAL' AND project_material_id=p_source_id) OR (p_source_type='SE_SUPPLY' AND se_supply_record_id=p_source_id)),
 allocations AS (SELECT a.* FROM public.receiving_inventory_allocations a JOIN receipts r ON r.id=a.office_receipt_id)
 SELECT jsonb_build_object(
 'inventoryItem',(SELECT to_jsonb(i) FROM public.inventory_items i WHERE i.id=CASE WHEN p_source_type='SE_SUPPLY' THEN (SELECT inventory_item_id FROM public.se_supply_records WHERE id=p_source_id) ELSE (SELECT inventory_item_id FROM public.project_materials WHERE id=p_source_id) END),
 'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY received_at DESC) FROM receipts r),'[]'),
 'links',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.material_receipt_serials l JOIN receipts r ON r.id=l.receipt_id),'[]'),
 'entries',COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM entries e),'[]'),
 'allocations',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY created_at) FROM allocations a),'[]'),
 'serials',COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.inventory_serials s WHERE s.id IN(SELECT inventory_serial_id FROM entries)),'[]'),
 'seRecords',COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.se_supply_records s WHERE s.id IN(SELECT se_supply_record_id FROM allocations) OR (NOT s.receiving_only AND s.inventory_serial_id IN(SELECT inventory_serial_id FROM entries))),'[]'),
 'siteReceipts',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.material_receipts r WHERE r.id IN(SELECT site_receipt_id FROM allocations)),'[]'),
 'materials',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.project_materials m WHERE m.id IN(SELECT project_material_id FROM allocations)),'[]')
 ) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_receiving_source_details(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_receiving_source_details(text,uuid) TO authenticated;

-- An archived source cannot be received again by an already-open/stale client.
CREATE FUNCTION app_private.guard_archived_receiving_source() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE hidden timestamptz;
BEGIN
 IF TG_TABLE_NAME='material_receipts' AND to_jsonb(NEW)->>'event_type'<>'RECEIVE' THEN RETURN NEW; END IF;
 IF NEW.project_material_id IS NOT NULL THEN SELECT receiving_archived_at INTO hidden FROM public.project_materials WHERE id=NEW.project_material_id FOR UPDATE;
 ELSE SELECT receiving_archived_at INTO hidden FROM public.se_supply_records WHERE id=NEW.se_supply_record_id FOR UPDATE; END IF;
 IF hidden IS NOT NULL THEN RAISE EXCEPTION '此到貨已取消或隱藏，不能繼續收貨'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_archived_receiving_source() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receiving_archived_entry_guard BEFORE INSERT ON public.receiving_serial_entries FOR EACH ROW EXECUTE FUNCTION app_private.guard_archived_receiving_source();
CREATE TRIGGER receiving_archived_receipt_guard BEFORE INSERT ON public.material_receipts FOR EACH ROW EXECUTE FUNCTION app_private.guard_archived_receiving_source();
NOTIFY pgrst,'reload schema';
