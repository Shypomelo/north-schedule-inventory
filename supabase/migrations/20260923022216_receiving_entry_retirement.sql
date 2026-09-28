ALTER TABLE public.receiving_serial_entries ADD COLUMN retired_at timestamptz;
ALTER TABLE public.receiving_serial_entries ADD CONSTRAINT receiving_retired_inactive CHECK(retired_at IS NULL OR active_receipt_id IS NULL);
DROP INDEX public.receiving_entry_project_key;
DROP INDEX public.receiving_entry_se_key;
CREATE UNIQUE INDEX receiving_entry_project_key ON public.receiving_serial_entries(project_material_id,normalized_serial) WHERE project_material_id IS NOT NULL AND retired_at IS NULL;
CREATE UNIQUE INDEX receiving_entry_se_key ON public.receiving_serial_entries(se_supply_record_id,normalized_serial) WHERE se_supply_record_id IS NOT NULL AND retired_at IS NULL;
CREATE FUNCTION app_private.retire_corrected_receiving_entry() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF OLD.active_receipt_id IS NOT NULL AND NEW.active_receipt_id IS NULL AND EXISTS(SELECT 1 FROM public.inventory_serials WHERE id=NEW.inventory_serial_id AND status='作廢') THEN NEW.retired_at:=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.retire_corrected_receiving_entry() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER retire_corrected_receiving_entry BEFORE UPDATE ON public.receiving_serial_entries FOR EACH ROW EXECUTE FUNCTION app_private.retire_corrected_receiving_entry();
CREATE FUNCTION public.retire_pending_receiving_serial(p_entry_id uuid,p_expected_updated_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE entry public.receiving_serial_entries;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN RAISE EXCEPTION 'Only active editors can correct a pending serial' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO entry FROM public.receiving_serial_entries WHERE id=p_entry_id;
 IF entry.id IS NULL THEN RAISE EXCEPTION '找不到待收序號'; END IF;
 PERFORM app_private.receiving_source(CASE WHEN entry.project_material_id IS NOT NULL THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END,COALESCE(entry.project_material_id,entry.se_supply_record_id));
 SELECT * INTO entry FROM public.receiving_serial_entries WHERE id=p_entry_id FOR UPDATE;
 IF entry.active_receipt_id IS NOT NULL THEN RAISE EXCEPTION '已收貨序號請使用收货更正'; END IF;
 IF entry.retired_at IS NOT NULL THEN RETURN; END IF;
 IF p_expected_updated_at IS NULL OR entry.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION '序號已變更，請重新載入'; END IF;
 UPDATE public.receiving_serial_entries SET retired_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=entry.id;
 PERFORM app_private.inventory_audit('RETIRE_PENDING_RECEIVING_SERIAL',to_jsonb(entry),to_jsonb(entry)||jsonb_build_object('retired_at',clock_timestamp()),'移除待收序號，保留歷史 association');
END $$;
REVOKE ALL ON FUNCTION public.retire_pending_receiving_serial(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.retire_pending_receiving_serial(uuid,timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_receiving_serial(p_source_type text,p_source_id uuid,p_inventory_item_id uuid,p_raw_serial text)
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
 SELECT * INTO entry FROM public.receiving_serial_entries WHERE retired_at IS NULL AND normalized_serial=name
 AND (project_material_id=p_source_id OR se_supply_record_id=p_source_id);
 IF FOUND THEN RETURN entry; END IF;
 IF EXISTS(SELECT 1 FROM public.receiving_serial_entries WHERE normalized_serial=name AND (active_receipt_id IS NOT NULL OR project_material_id IS DISTINCT FROM p_source_id AND se_supply_record_id IS DISTINCT FROM p_source_id))
 THEN RAISE EXCEPTION '需要確認：序號已登錄於另一筆到貨'; END IF;
 IF (SELECT count(*) FROM public.receiving_serial_entries WHERE retired_at IS NULL AND (project_material_id=p_source_id OR se_supply_record_id=p_source_id))>=(source->>'quantity')::numeric
 THEN RAISE EXCEPTION '序號數量超過需求'; END IF;
 IF p_source_type='PROJECT_MATERIAL' THEN UPDATE public.project_materials SET inventory_item_id=item.id WHERE id=p_source_id;
 ELSE UPDATE public.se_supply_records SET inventory_item_id=item.id WHERE id=p_source_id; END IF;
 INSERT INTO public.receiving_serial_entries(project_material_id,se_supply_record_id,inventory_item_id,raw_serial,created_by)
 VALUES(CASE WHEN p_source_type='PROJECT_MATERIAL' THEN p_source_id END,CASE WHEN p_source_type='SE_SUPPLY' THEN p_source_id END,item.id,p_raw_serial,a.id) RETURNING * INTO entry;
 RETURN entry;
END $$;
CREATE OR REPLACE FUNCTION public.confirm_receiving_into_inventory(p_request_id uuid,p_source_type text,p_source_id uuid,p_item_id uuid,p_quantity numeric,p_entry_ids uuid[],p_received_at timestamptz,p_notes text DEFAULT NULL)
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
   IF entry.retired_at IS NOT NULL OR entry.inventory_item_id<>item.id OR entry.active_receipt_id IS NOT NULL OR NOT COALESCE(entry.project_material_id=p_source_id OR entry.se_supply_record_id=p_source_id,false) THEN RAISE EXCEPTION '序號來源已變更或已收貨'; END IF;
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
