-- Forward-only conversion of Phase B. Existing ledger and serial writers remain canonical.
DROP INDEX public.inventory_transactions_schedule_item_out_key;
ALTER TABLE public.inventory_items ADD COLUMN is_se_maintenance_equipment boolean NOT NULL DEFAULT false;
-- Exact codes from imports/庫存批次匯入_品項主檔.xlsx, serialized inverter/optimizer rows.
-- Router, monitoring accessories, and the ambiguous R800-NORTH row are deliberately not seeded.
UPDATE public.inventory_items SET is_se_maintenance_equipment=true
WHERE requires_serial AND code IN (
 'SE3000H-RW000BEN4','SE3000H-TW000BEN4','SE5000H-RW000BEN4','SE5000H-TW000BEN4',
 'SESUK-RW00INNN4','SESUK-RW00INNN4-SUB','SE82.8K-RW0P0BNY4','S440-1GM4MRM-NA02',
 'P401-5RM4MRM','P500-5RM4MRM','P701-4RMLMRL','P801-4RMLMRY','P850-4RMLMRY',
 'S1000','SE4000H','R800','S650','S1200');
-- Optional explicit, reviewed identity link; no serial copy and no automatic short-code mapping.
ALTER TABLE public.se_supply_records ADD COLUMN inventory_serial_id uuid
 REFERENCES public.inventory_serials(id) ON DELETE RESTRICT;
CREATE INDEX se_supply_inventory_serial_idx ON public.se_supply_records(inventory_serial_id)
 WHERE inventory_serial_id IS NOT NULL;

CREATE TABLE public.maintenance_equipment_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 schedule_task_id uuid NOT NULL REFERENCES public.schedule_tasks(id) ON DELETE RESTRICT,
 source_type text NOT NULL CHECK (source_type IN ('INVENTORY','SE_SUPPLY','BOTH')),
 inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 inventory_serial_id uuid REFERENCES public.inventory_serials(id) ON DELETE RESTRICT,
 inventory_transaction_id uuid UNIQUE REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
 se_supply_record_id uuid UNIQUE REFERENCES public.se_supply_records(id) ON DELETE RESTRICT,
 model_snapshot text NOT NULL,
 serial_snapshot text NOT NULL CHECK (btrim(serial_snapshot)<>''),
 replaced_at timestamptz NOT NULL CHECK (isfinite(replaced_at)),
 notes text,
 created_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (
  (source_type='INVENTORY' AND inventory_item_id IS NOT NULL AND inventory_serial_id IS NOT NULL AND inventory_transaction_id IS NOT NULL AND se_supply_record_id IS NULL)
  OR (source_type='SE_SUPPLY' AND inventory_item_id IS NULL AND inventory_serial_id IS NULL AND inventory_transaction_id IS NULL AND se_supply_record_id IS NOT NULL)
  OR (source_type='BOTH' AND inventory_item_id IS NOT NULL AND inventory_serial_id IS NOT NULL AND inventory_transaction_id IS NOT NULL AND se_supply_record_id IS NOT NULL)
 )
);
CREATE INDEX maintenance_equipment_schedule_idx ON public.maintenance_equipment_records(schedule_task_id,replaced_at DESC,id);
CREATE INDEX maintenance_equipment_project_idx ON public.maintenance_equipment_records(project_id,replaced_at DESC);
ALTER TABLE public.maintenance_equipment_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Active members read equipment events" ON public.maintenance_equipment_records
 FOR SELECT TO authenticated USING ((SELECT app_private.is_active_member()));
REVOKE ALL ON public.maintenance_equipment_records FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.maintenance_equipment_records TO authenticated;
GRANT ALL ON public.maintenance_equipment_records TO service_role;

-- One resolver for search and mutation. Eligibility is evaluated AFTER identity joins.
-- Exact whole-string trim/case matching only; short-key similarities are conflicts, never merges.
CREATE FUNCTION app_private.maintenance_equipment_candidates(p_project_id uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 WITH inv AS (
  SELECT s.*,i.code,i.name,i.is_active,i.requires_serial,i.is_se_maintenance_equipment,
   upper(btrim(s.serial_number)) AS identity_key
  FROM public.inventory_serials s JOIN public.inventory_items i ON i.id=s.item_id
 ), supply AS (
  SELECT r.*,upper(btrim(r.new_serial)) AS identity_key FROM public.se_supply_records r
  WHERE nullif(btrim(r.new_serial),'') IS NOT NULL
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
    WHEN i.id IS NOT NULL AND (NOT i.is_se_maintenance_equipment OR NOT i.is_active OR NOT i.requires_serial) THEN '庫存品項尚未確認為可用 SE 設備'
    WHEN i.id IS NOT NULL AND (i.status<>'在庫' OR public.classify_inventory_serial_format(i.serial_number)='unknown') THEN '庫存序號不可出庫，不可改以 SE 供貨登錄'
    WHEN r.id IS NOT NULL AND r.quantity<>1 THEN '供貨數量不是單台，需確認'
    WHEN r.id IS NOT NULL AND r.replace_date IS NOT NULL THEN 'SE 供貨已有更換紀錄'
    WHEN r.project_id IS NOT NULL AND r.project_id<>p_project_id THEN 'SE 供貨屬於不同案場'
    WHEN nullif(btrim(r.project_name),'') IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=p_project_id AND upper(btrim(p.project_name))=upper(btrim(r.project_name)))
      OR (r.project_id IS NULL AND (SELECT count(*) FROM public.projects p WHERE p.deleted_at IS NULL AND upper(btrim(p.project_name))=upper(btrim(r.project_name)))<>1)
    ) THEN 'SE 案場名稱需確認'
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
   md5(string_agg(row(iid,item_id,status,rid,new_serial,new_model,replace_date,quantity,project_id,project_name,inventory_serial_id,is_se_maintenance_equipment,is_active)::text,'|' ORDER BY iid,rid)) AS version
  FROM joined GROUP BY identity_key
 ) SELECT jsonb_build_object('key',identity_key,'inventory_serial_id',iid,'inventory_item_id',item_id,
  'se_supply_record_id',rid,'source_type',CASE WHEN iid IS NULL THEN 'SE_SUPPLY' WHEN rid IS NULL THEN 'INVENTORY' ELSE 'BOTH' END,
  'serial',serial,'model',model,'item_name',item_name,'project_name',project_name,'version',version,
  'conflict',CASE WHEN inventory_count>1 OR supply_count>1 THEN '同序號對應多筆來源，需確認' ELSE conflict END,
  'eligible',inventory_count<=1 AND supply_count<=1 AND conflict IS NULL)
 FROM grouped WHERE visible
$$;
REVOKE ALL ON FUNCTION app_private.maintenance_equipment_candidates(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.search_maintenance_equipment(p_schedule_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.schedule_tasks; pid uuid; result jsonb;
BEGIN
 IF NOT app_private.is_active_member() THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM public.schedule_tasks WHERE id=p_schedule_task_id AND deleted_at IS NULL;
 IF t.id IS NULL OR btrim(replace(t.task_type,chr(12288),' ')) IS DISTINCT FROM '維修' THEN RAISE EXCEPTION '維修排程不存在'; END IF;
 SELECT id INTO pid FROM public.projects WHERE id::text=t.project_id AND deleted_at IS NULL;
 IF pid IS NULL THEN RAISE EXCEPTION '請先儲存維修排程的有效案場'; END IF;
 SELECT COALESCE(jsonb_agg(c ORDER BY c->>'model',c->>'serial'),'[]') INTO result FROM app_private.maintenance_equipment_candidates(pid)c;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.search_maintenance_equipment(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_maintenance_equipment(uuid) TO authenticated;

CREATE FUNCTION public.register_maintenance_equipment_replacement(
 p_request_id uuid,p_schedule_task_id uuid,p_inventory_serial_id uuid,p_se_supply_record_id uuid,
 p_replaced_at timestamptz,p_notes text DEFAULT NULL,p_version text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members := app_private.inventory_actor(); t public.schedule_tasks;
 project public.projects; candidate jsonb; existing public.maintenance_equipment_records;
 event public.maintenance_equipment_records; tx jsonb; se_before jsonb;
BEGIN
 IF p_request_id IS NULL OR p_replaced_at IS NULL OR NOT isfinite(p_replaced_at) THEN RAISE EXCEPTION '有效請求與實際更換時間必填'; END IF;
 -- Global request mutex also handles retries originating from different schedule dialogs.
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-request:'||p_request_id::text,0));
 SELECT * INTO existing FROM public.maintenance_equipment_records WHERE request_id=p_request_id;
 IF FOUND THEN
  IF existing.schedule_task_id IS DISTINCT FROM p_schedule_task_id OR existing.inventory_serial_id IS DISTINCT FROM p_inventory_serial_id
   OR existing.se_supply_record_id IS DISTINCT FROM p_se_supply_record_id OR existing.replaced_at IS DISTINCT FROM p_replaced_at
   OR existing.notes IS DISTINCT FROM nullif(btrim(p_notes),'') OR existing.created_by<>actor.id THEN
   RAISE EXCEPTION 'EQUIPMENT_CONFLICT: request_id 已用於不同資料' USING ERRCODE='PT409';
  END IF;
  RETURN to_jsonb(existing)||jsonb_build_object('already_registered',true);
 END IF;
 SELECT * INTO t FROM public.schedule_tasks WHERE id=p_schedule_task_id FOR UPDATE;
 IF t.id IS NULL OR t.deleted_at IS NOT NULL OR btrim(replace(t.task_type,chr(12288),' ')) IS DISTINCT FROM '維修' THEN RAISE EXCEPTION '維修排程不存在'; END IF;
 SELECT * INTO project FROM public.projects WHERE id::text=t.project_id AND deleted_at IS NULL;
 IF project.id IS NULL THEN RAISE EXCEPTION '請先儲存維修排程的有效案場'; END IF;
 -- SE insert/edit uses ordinary DML: this lock prevents identity phantoms during resolution.
 -- Taken before any inventory item/serial lock; no inventory algorithm is duplicated.
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 IF p_se_supply_record_id IS NOT NULL THEN
  SELECT to_jsonb(r) INTO se_before FROM public.se_supply_records r WHERE id=p_se_supply_record_id FOR UPDATE;
 END IF;
 SELECT c INTO candidate FROM app_private.maintenance_equipment_candidates(project.id)c
 WHERE (c->>'inventory_serial_id')::uuid IS NOT DISTINCT FROM p_inventory_serial_id
   AND (c->>'se_supply_record_id')::uuid IS NOT DISTINCT FROM p_se_supply_record_id;
 IF candidate IS NULL OR NOT (candidate->>'eligible')::boolean THEN
  RAISE EXCEPTION 'EQUIPMENT_CONFLICT: %',COALESCE(candidate->>'conflict','來源已變更或已登錄，請重新搜尋') USING ERRCODE='PT409';
 END IF;
 IF p_version IS NULL OR candidate->>'version'<>p_version THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 來源已更新，請重新搜尋' USING ERRCODE='PT409'; END IF;
 IF p_inventory_serial_id IS NOT NULL THEN
  tx:=public.write_inventory_transaction_atomic('CREATE',jsonb_build_object(
   'item_id',candidate->>'inventory_item_id','transaction_type','OUT','quantity',1,
   -- Posting today is independent of the historical event time. All existing cutoff/month guards apply.
   'transaction_date',(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date,
   'project_id',project.id,'source','設備維修更換','notes',COALESCE(nullif(btrim(p_notes),''),'維修設備更換')
  ),jsonb_build_array(candidate->>'serial'));
  UPDATE public.inventory_transactions SET schedule_task_id=t.id WHERE id=(tx->>'id')::uuid RETURNING to_jsonb(inventory_transactions.*) INTO tx;
 END IF;
 IF p_se_supply_record_id IS NOT NULL THEN
  UPDATE public.se_supply_records SET replace_date=(p_replaced_at AT TIME ZONE 'Asia/Taipei')::date,
   project_id=COALESCE(project_id,project.id),updated_at=clock_timestamp()
   WHERE id=p_se_supply_record_id AND replace_date IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: SE 已更換' USING ERRCODE='PT409'; END IF;
 END IF;
 INSERT INTO public.maintenance_equipment_records(request_id,project_id,schedule_task_id,source_type,
  inventory_item_id,inventory_serial_id,inventory_transaction_id,se_supply_record_id,model_snapshot,serial_snapshot,replaced_at,notes,created_by)
 VALUES(p_request_id,project.id,t.id,candidate->>'source_type',(candidate->>'inventory_item_id')::uuid,
  p_inventory_serial_id,(tx->>'id')::uuid,p_se_supply_record_id,candidate->>'model',candidate->>'serial',p_replaced_at,nullif(btrim(p_notes),''),actor.id)
 RETURNING * INTO event;
 INSERT INTO public.activity_logs(action,target_type,target_id,description,changes,user_id,user_name,
  actor_user_id,actor_name,action_type,target_label,project_id,project_name,before_value,after_value,message)
 VALUES('REGISTER_MAINTENANCE_EQUIPMENT','MaintenanceEquipmentRecord',event.id::text,'登錄設備維修',
  jsonb_build_object('before',se_before,'after',to_jsonb(event),'inventory_transaction',tx),actor.id::text,actor.name,
  actor.id::text,actor.name,'REGISTER_MAINTENANCE_EQUIPMENT',event.serial_snapshot,project.id::text,project.project_name,
  se_before::text,to_jsonb(event)::text,'登錄設備維修');
 RETURN to_jsonb(event)||jsonb_build_object('already_registered',false);
END $$;
REVOKE ALL ON FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_maintenance_with_inventory_usage(uuid,jsonb) FROM PUBLIC,anon,authenticated;

-- Add/view only: referenced SE identity cannot be edited out from under its event.
CREATE FUNCTION app_private.guard_maintenance_se_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE se_supply_record_id=OLD.id)
 AND row(NEW.new_serial,NEW.new_model,NEW.inventory_serial_id,NEW.project_id,NEW.project_name,NEW.replace_date,NEW.quantity)
  IS DISTINCT FROM row(OLD.new_serial,OLD.new_model,OLD.inventory_serial_id,OLD.project_id,OLD.project_name,OLD.replace_date,OLD.quantity)
 THEN RAISE EXCEPTION '此供貨已關聯設備維修紀錄，本輪不支援更正來源' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_maintenance_se_source() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER maintenance_se_source_guard BEFORE UPDATE ON public.se_supply_records
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_se_source();
NOTIFY pgrst,'reload schema';
