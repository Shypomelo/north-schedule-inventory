-- Forward-only UX V2. Canonical inventory writer and immutable audit history are reused.
ALTER TABLE public.maintenance_equipment_records
 ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN updated_by uuid REFERENCES public.team_members(id),
 ADD COLUMN se_replace_owned boolean NOT NULL DEFAULT false;
-- Legacy ownership must be proven by the original atomic event audit, never guessed.
UPDATE public.maintenance_equipment_records e SET se_replace_owned=true
WHERE e.se_supply_record_id IS NOT NULL AND EXISTS (
 SELECT 1 FROM public.activity_logs a JOIN public.se_supply_records r ON r.id=e.se_supply_record_id
 WHERE a.target_id=e.id::text AND a.action='REGISTER_MAINTENANCE_EQUIPMENT'
 AND a.changes->'before'->>'id'=r.id::text AND a.changes->'before'->>'replace_date' IS NULL
 AND a.changes->'after'->>'se_supply_record_id'=r.id::text
 AND r.replace_date=(e.replaced_at AT TIME ZONE 'Asia/Taipei')::date);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE se_supply_record_id IS NOT NULL AND NOT se_replace_owned)
 THEN RAISE EXCEPTION 'STOP: SE event ownership cannot be proven'; END IF;
END $$;
CREATE TABLE app_private.maintenance_equipment_requests (
 request_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.team_members(id),
 payload jsonb NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.maintenance_equipment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.maintenance_equipment_requests FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.maintenance_cross_project(p_se_id uuid,p_project_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('cross_project',CASE WHEN r.id IS NULL THEN false
  WHEN r.project_id IS NOT NULL THEN r.project_id<>p.id
  ELSE nullif(btrim(r.project_name),'') IS NULL OR upper(btrim(r.project_name))<>upper(btrim(p.project_name))
   OR (SELECT count(*) FROM public.projects x WHERE x.deleted_at IS NULL AND upper(btrim(x.project_name))=upper(btrim(r.project_name)))<>1 END,
  'original_project_name',COALESCE(nullif(btrim(r.project_name),''),sp.project_name,'未指定'),
  'original_project_id',r.project_id,'maintenance_project_name',p.project_name)
 FROM public.projects p LEFT JOIN public.se_supply_records r ON r.id=p_se_id
 LEFT JOIN public.projects sp ON sp.id=r.project_id WHERE p.id=p_project_id
$$;
REVOKE ALL ON FUNCTION app_private.maintenance_cross_project(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION app_private.maintenance_equipment_candidates(p_project_id uuid)
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

DROP FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text);
CREATE FUNCTION public.register_maintenance_equipment_replacement(
 p_request_id uuid,p_schedule_task_id uuid,p_inventory_serial_id uuid,p_se_supply_record_id uuid,
 p_replaced_at timestamptz,p_notes text DEFAULT NULL,p_version text DEFAULT NULL,p_confirm_cross_project boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members := app_private.inventory_actor(); t public.schedule_tasks;
 project public.projects; candidate jsonb; existing public.maintenance_equipment_records;
 event public.maintenance_equipment_records; tx jsonb; se_before jsonb;
 payload jsonb; cached app_private.maintenance_equipment_requests;
BEGIN
 IF p_request_id IS NULL OR p_replaced_at IS NULL OR NOT isfinite(p_replaced_at) THEN RAISE EXCEPTION '有效請求與實際更換時間必填'; END IF;
 -- Global request mutex also handles retries originating from different schedule dialogs.
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-request:'||p_request_id::text,0));
 payload:=jsonb_build_array('REGISTER',p_schedule_task_id,p_inventory_serial_id,p_se_supply_record_id,p_replaced_at,nullif(btrim(p_notes),''),COALESCE(p_confirm_cross_project,false));
 SELECT * INTO cached FROM app_private.maintenance_equipment_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: request_id 已用於不同資料' USING ERRCODE='PT409'; END IF;
  RETURN cached.response||jsonb_build_object('already_registered',true);
 END IF;
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
 -- Acquire the canonical item mutex before reading marker/identity/version.
 IF p_inventory_serial_id IS NOT NULL THEN
  PERFORM 1 FROM public.inventory_items i WHERE i.id=(SELECT item_id FROM public.inventory_serials WHERE id=p_inventory_serial_id) FOR UPDATE;
 END IF;
 SELECT c INTO candidate FROM app_private.maintenance_equipment_candidates(project.id)c
 WHERE (c->>'inventory_serial_id')::uuid IS NOT DISTINCT FROM p_inventory_serial_id
   AND (c->>'se_supply_record_id')::uuid IS NOT DISTINCT FROM p_se_supply_record_id;
 IF candidate IS NULL OR NOT (candidate->>'eligible')::boolean THEN
  RAISE EXCEPTION 'EQUIPMENT_CONFLICT: %',COALESCE(candidate->>'conflict','來源已變更或已登錄，請重新搜尋') USING ERRCODE='PT409';
 END IF;
 IF p_version IS NULL OR candidate->>'version'<>p_version THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 來源已更新，請重新搜尋' USING ERRCODE='PT409'; END IF;
 IF (candidate->>'cross_project')::boolean AND NOT COALESCE(p_confirm_cross_project,false) THEN RAISE EXCEPTION 'CROSS_PROJECT_CONFIRMATION_REQUIRED: 請確認跨案場使用' USING ERRCODE='PT409'; END IF;
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
   updated_at=clock_timestamp()
   WHERE id=p_se_supply_record_id AND replace_date IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: SE 已更換' USING ERRCODE='PT409'; END IF;
 END IF;
 INSERT INTO public.maintenance_equipment_records(request_id,project_id,schedule_task_id,source_type,
  inventory_item_id,inventory_serial_id,inventory_transaction_id,se_supply_record_id,model_snapshot,serial_snapshot,replaced_at,notes,created_by,se_replace_owned)
 VALUES(p_request_id,project.id,t.id,candidate->>'source_type',(candidate->>'inventory_item_id')::uuid,
  p_inventory_serial_id,(tx->>'id')::uuid,p_se_supply_record_id,candidate->>'model',candidate->>'serial',p_replaced_at,nullif(btrim(p_notes),''),actor.id,p_se_supply_record_id IS NOT NULL)
 RETURNING * INTO event;
 INSERT INTO public.activity_logs(action,target_type,target_id,description,changes,user_id,user_name,
  actor_user_id,actor_name,action_type,target_label,project_id,project_name,before_value,after_value,message)
 VALUES('REGISTER_MAINTENANCE_EQUIPMENT','MaintenanceEquipmentRecord',event.id::text,'登錄設備維修',
  jsonb_build_object('before',se_before,'after',to_jsonb(event),'inventory_transaction',tx,'cross_project',app_private.maintenance_cross_project(p_se_supply_record_id,project.id),'cross_project_confirmed',COALESCE(p_confirm_cross_project,false)),actor.id::text,actor.name,
  actor.id::text,actor.name,'REGISTER_MAINTENANCE_EQUIPMENT',event.serial_snapshot,project.id::text,project.project_name,
  se_before::text,to_jsonb(event)::text,'登錄設備維修');
 INSERT INTO app_private.maintenance_equipment_requests(request_id,actor_id,payload,response) VALUES(p_request_id,actor.id,payload,to_jsonb(event));
 RETURN to_jsonb(event)||jsonb_build_object('already_registered',false);
END $$;

REVOKE ALL ON FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,boolean) TO authenticated;

CREATE FUNCTION app_private.assert_maintenance_equipment_links(e public.maintenance_equipment_records)
RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF e.inventory_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.inventory_items i
  WHERE i.id=e.inventory_item_id AND i.is_active AND i.requires_serial AND i.is_se_maintenance_equipment AND i.code=e.model_snapshot)
 THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 原設備品項已變更' USING ERRCODE='PT409'; END IF;
 IF EXISTS(SELECT 1 FROM public.se_supply_records r WHERE r.id IS DISTINCT FROM e.se_supply_record_id
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

CREATE FUNCTION app_private.maintenance_current_candidate(e public.maintenance_equipment_records)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT app_private.maintenance_cross_project(e.se_supply_record_id,e.project_id)||jsonb_build_object(
  'key',COALESCE('inventory:'||e.inventory_serial_id::text,'se:'||upper(btrim(e.serial_snapshot))),
  'inventory_serial_id',e.inventory_serial_id,'inventory_item_id',e.inventory_item_id,
  'se_supply_record_id',e.se_supply_record_id,'source_type',e.source_type,
  'serial',e.serial_snapshot,'model',e.model_snapshot,'item_name',NULL,
  'project_name',(SELECT project_name FROM public.se_supply_records WHERE id=e.se_supply_record_id),
  'eligible',true,'conflict',NULL,'current_record',true,'version',md5(to_jsonb(e)::text))
$$;
REVOKE ALL ON FUNCTION app_private.maintenance_current_candidate(public.maintenance_equipment_records) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.search_maintenance_equipment_for_edit(p_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.maintenance_equipment_records; result jsonb; current_candidate jsonb;
BEGIN
 IF NOT app_private.is_active_member() THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM public.maintenance_equipment_records WHERE id=p_record_id;
 IF e.id IS NULL THEN RAISE EXCEPTION '設備維修紀錄不存在'; END IF;
 PERFORM app_private.assert_maintenance_equipment_links(e);
 current_candidate:=app_private.maintenance_current_candidate(e);
 SELECT COALESCE(jsonb_agg(c ORDER BY c->>'model',c->>'serial'),'[]') INTO result
 FROM app_private.maintenance_equipment_candidates(e.project_id)c WHERE c->>'key'<>current_candidate->>'key';
 RETURN jsonb_build_array(current_candidate)||result;
END $$;
REVOKE ALL ON FUNCTION public.search_maintenance_equipment_for_edit(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_maintenance_equipment_for_edit(uuid) TO authenticated;

-- Only the date held by the event may move with an atomic correction. Identity stays protected.
CREATE OR REPLACE FUNCTION app_private.guard_maintenance_se_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.maintenance_equipment_records;
BEGIN
 SELECT * INTO e FROM public.maintenance_equipment_records WHERE se_supply_record_id=OLD.id;
 IF FOUND AND (row(NEW.new_serial,NEW.new_model,NEW.inventory_serial_id,NEW.project_id,NEW.project_name,NEW.quantity)
  IS DISTINCT FROM row(OLD.new_serial,OLD.new_model,OLD.inventory_serial_id,OLD.project_id,OLD.project_name,OLD.quantity)
  OR NEW.replace_date IS DISTINCT FROM (e.replaced_at AT TIME ZONE 'Asia/Taipei')::date)
 THEN RAISE EXCEPTION '此供貨已關聯設備維修紀錄，請從設備維修修改' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.correct_maintenance_equipment_replacement(
 p_request_id uuid,p_record_id uuid,p_inventory_serial_id uuid,p_se_supply_record_id uuid,
 p_replaced_at timestamptz,p_notes text,p_version text,p_expected_revision bigint,p_confirm_cross_project boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); e public.maintenance_equipment_records;
 event public.maintenance_equipment_records; t public.schedule_tasks; project public.projects;
 old_tx public.inventory_transactions; tx jsonb; candidate jsonb; payload jsonb;
 cached app_private.maintenance_equipment_requests; old_se jsonb; new_se jsonb;
 old_item uuid; new_item uuid; same_source boolean; reason text:='修改設備維修';
BEGIN
 IF p_request_id IS NULL OR p_replaced_at IS NULL OR NOT isfinite(p_replaced_at) THEN RAISE EXCEPTION '有效請求與實際更換時間必填'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-request:'||p_request_id::text,0));
 payload:=jsonb_build_array('CORRECT',p_record_id,p_inventory_serial_id,p_se_supply_record_id,p_replaced_at,
  nullif(btrim(p_notes),''),p_expected_revision,COALESCE(p_confirm_cross_project,false));
 SELECT * INTO cached FROM app_private.maintenance_equipment_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: request_id 已用於不同資料' USING ERRCODE='PT409'; END IF;
  RETURN cached.response||jsonb_build_object('already_corrected',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.maintenance_equipment_records WHERE request_id=p_request_id) THEN
  RAISE EXCEPTION 'EQUIPMENT_CONFLICT: request_id 已使用' USING ERRCODE='PT409';
 END IF;
 -- Match registration lock order: schedule, SE, items, transaction, serials. Event is locked after schedule.
 SELECT * INTO e FROM public.maintenance_equipment_records WHERE id=p_record_id;
 IF e.id IS NULL THEN RAISE EXCEPTION '設備維修紀錄不存在'; END IF;
 SELECT * INTO t FROM public.schedule_tasks WHERE id=e.schedule_task_id FOR UPDATE;
 SELECT * INTO e FROM public.maintenance_equipment_records WHERE id=p_record_id FOR UPDATE;
 IF e.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 紀錄已更新，請重新開啟' USING ERRCODE='PT409'; END IF;
 IF t.deleted_at IS NOT NULL OR t.project_id IS DISTINCT FROM e.project_id::text
  OR btrim(replace(t.task_type,chr(12288),' ')) IS DISTINCT FROM '維修' THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 排程案場或類型已變更' USING ERRCODE='PT409'; END IF;
 SELECT * INTO project FROM public.projects WHERE id=e.project_id AND deleted_at IS NULL;
 IF project.id IS NULL THEN RAISE EXCEPTION '維修案場不存在'; END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM 1 FROM public.se_supply_records WHERE id IN(e.se_supply_record_id,p_se_supply_record_id) ORDER BY id FOR UPDATE;
 SELECT to_jsonb(r) INTO old_se FROM public.se_supply_records r WHERE id=e.se_supply_record_id;
 SELECT to_jsonb(r) INTO new_se FROM public.se_supply_records r WHERE id=p_se_supply_record_id;
 old_item:=e.inventory_item_id;
 SELECT item_id INTO new_item FROM public.inventory_serials WHERE id=p_inventory_serial_id;
 PERFORM 1 FROM public.inventory_items WHERE id IN(old_item,new_item) ORDER BY id FOR UPDATE;
 SELECT * INTO old_tx FROM public.inventory_transactions WHERE id=e.inventory_transaction_id FOR UPDATE;
 PERFORM 1 FROM public.inventory_serials WHERE id IN(e.inventory_serial_id,p_inventory_serial_id) ORDER BY id FOR UPDATE;
 PERFORM app_private.assert_maintenance_equipment_links(e);
 same_source:=e.inventory_serial_id IS NOT DISTINCT FROM p_inventory_serial_id
  AND e.se_supply_record_id IS NOT DISTINCT FROM p_se_supply_record_id;
 IF same_source THEN candidate:=app_private.maintenance_current_candidate(e);
 ELSE
  SELECT c INTO candidate FROM app_private.maintenance_equipment_candidates(e.project_id)c
  WHERE (c->>'inventory_serial_id')::uuid IS NOT DISTINCT FROM p_inventory_serial_id
   AND (c->>'se_supply_record_id')::uuid IS NOT DISTINCT FROM p_se_supply_record_id;
 END IF;
 IF candidate IS NULL OR NOT (candidate->>'eligible')::boolean THEN
  RAISE EXCEPTION 'EQUIPMENT_CONFLICT: %',COALESCE(candidate->>'conflict','來源已變更，請重新搜尋') USING ERRCODE='PT409';
 END IF;
 IF p_version IS NULL OR candidate->>'version'<>p_version THEN RAISE EXCEPTION 'EQUIPMENT_CONFLICT: 來源已更新，請重新搜尋' USING ERRCODE='PT409'; END IF;
 IF (candidate->>'cross_project')::boolean AND NOT COALESCE(p_confirm_cross_project,false) THEN
  RAISE EXCEPTION 'CROSS_PROJECT_CONFIRMATION_REQUIRED: 請確認跨案場使用' USING ERRCODE='PT409';
 END IF;
 IF e.inventory_transaction_id IS NOT NULL AND p_inventory_serial_id IS NULL THEN
  tx:=public.write_inventory_transaction_atomic('VOID','{}','[]',old_tx.id,reason,old_tx.updated_at);
 ELSIF p_inventory_serial_id IS NOT NULL THEN
  tx:=public.write_inventory_transaction_atomic(CASE WHEN old_tx.id IS NULL THEN 'CREATE' ELSE 'EDIT' END,
   jsonb_build_object('item_id',candidate->>'inventory_item_id','transaction_type','OUT','quantity',1,
    'transaction_date',COALESCE(old_tx.transaction_date,(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date),
    'project_id',e.project_id,'source',COALESCE(old_tx.source,'設備維修更換'),
    'handler',old_tx.handler,'unit',old_tx.unit,'notes',COALESCE(nullif(btrim(p_notes),''),'維修設備更換')),
   jsonb_build_array(candidate->>'serial'),old_tx.id,reason,old_tx.updated_at);
  IF old_tx.id IS NULL THEN
   UPDATE public.inventory_transactions SET schedule_task_id=e.schedule_task_id WHERE id=(tx->>'id')::uuid RETURNING to_jsonb(inventory_transactions.*) INTO tx;
  END IF;
 END IF;
 -- Relink first inside this transaction; the source guard then permits only the new owned date.
 UPDATE public.maintenance_equipment_records SET source_type=candidate->>'source_type',
  inventory_item_id=(candidate->>'inventory_item_id')::uuid,inventory_serial_id=p_inventory_serial_id,
  inventory_transaction_id=CASE WHEN p_inventory_serial_id IS NULL THEN NULL ELSE (tx->>'id')::uuid END,
  se_supply_record_id=p_se_supply_record_id,se_replace_owned=p_se_supply_record_id IS NOT NULL,
  model_snapshot=candidate->>'model',serial_snapshot=candidate->>'serial',replaced_at=p_replaced_at,
  notes=nullif(btrim(p_notes),''),revision=revision+1,updated_at=clock_timestamp(),updated_by=actor.id
 WHERE id=e.id RETURNING * INTO event;
 IF e.se_supply_record_id IS NOT NULL AND e.se_supply_record_id IS DISTINCT FROM p_se_supply_record_id THEN
  UPDATE public.se_supply_records SET replace_date=NULL,updated_at=clock_timestamp() WHERE id=e.se_supply_record_id;
 END IF;
 IF p_se_supply_record_id IS NOT NULL THEN
  UPDATE public.se_supply_records SET replace_date=(p_replaced_at AT TIME ZONE 'Asia/Taipei')::date,
   updated_at=clock_timestamp() WHERE id=p_se_supply_record_id;
 END IF;
 INSERT INTO public.activity_logs(action,target_type,target_id,description,changes,user_id,user_name,
  actor_user_id,actor_name,action_type,target_label,project_id,project_name,before_value,after_value,message)
 VALUES('CORRECT_MAINTENANCE_EQUIPMENT','MaintenanceEquipmentRecord',e.id::text,reason,
  jsonb_build_object('request_id',p_request_id,'before',to_jsonb(e),'after',to_jsonb(event),
   'old_se_before',old_se,'new_se_before',new_se,'inventory_transaction',tx,
   'cross_project',app_private.maintenance_cross_project(p_se_supply_record_id,e.project_id),
   'cross_project_confirmed',COALESCE(p_confirm_cross_project,false)),actor.id::text,actor.name,
  actor.id::text,actor.name,'CORRECT_MAINTENANCE_EQUIPMENT',event.serial_snapshot,e.project_id::text,project.project_name,
  to_jsonb(e)::text,to_jsonb(event)::text,reason);
 INSERT INTO app_private.maintenance_equipment_requests(request_id,actor_id,payload,response) VALUES(p_request_id,actor.id,payload,to_jsonb(event));
 RETURN to_jsonb(event)||jsonb_build_object('already_corrected',false);
END $$;
REVOKE ALL ON FUNCTION public.correct_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correct_maintenance_equipment_replacement(uuid,uuid,uuid,uuid,timestamptz,text,text,bigint,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
