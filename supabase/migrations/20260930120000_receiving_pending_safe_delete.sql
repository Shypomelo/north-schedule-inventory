-- Candidate first. A mistaken pending source is retired only before any business use.
-- The existing source lock order is shared by registration, matching and cancellation.
ALTER TABLE public.project_materials ADD COLUMN receiving_deleted_at timestamptz;
ALTER TABLE public.se_supply_records ADD COLUMN receiving_deleted_at timestamptz;
ALTER TABLE public.project_materials ADD CONSTRAINT project_pending_delete_archived
 CHECK (receiving_deleted_at IS NULL OR receiving_archived_at IS NOT NULL);
ALTER TABLE public.se_supply_records ADD CONSTRAINT se_pending_delete_archived
 CHECK (receiving_deleted_at IS NULL OR receiving_archived_at IS NOT NULL);
COMMENT ON COLUMN public.project_materials.receiving_deleted_at IS 'Mistaken office pending source retired before any downstream use; canonical row and audit remain.';
COMMENT ON COLUMN public.se_supply_records.receiving_deleted_at IS 'Mistaken receiving-only pending source retired before any downstream use; canonical row and audit remain.';
CREATE FUNCTION public.delete_receiving_pending_source(
 p_request_id uuid, p_source_type text, p_source_id uuid, p_expected_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 actor public.team_members := app_private.inventory_actor();
 cached app_private.receiving_requests;
 source jsonb; entry public.receiving_serial_entries;
 payload jsonb := jsonb_build_array('DELETE_PENDING_V1',p_source_type,p_source_id,p_expected_updated_at);
 result jsonb; retired_ids uuid[] := '{}'; at_time timestamptz;
BEGIN
 IF NOT COALESCE(app_private.is_editor_member(),false) THEN
  RAISE EXCEPTION 'PENDING_DELETE_EDITOR_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF p_request_id IS NULL OR p_source_id IS NULL OR p_expected_updated_at IS NULL
  OR p_source_type IS NULL OR p_source_type NOT IN ('PROJECT_MATERIAL','SE_SUPPLY') THEN
  RAISE EXCEPTION 'PENDING_DELETE_ARGUMENT_REQUIRED' USING ERRCODE='PT409';
 END IF;
 LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 SELECT * INTO cached FROM app_private.receiving_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF cached.actor_id<>actor.id OR cached.payload<>payload THEN
   RAISE EXCEPTION 'PENDING_DELETE_REQUEST_CONFLICT' USING ERRCODE='PT409';
  END IF;
  RETURN cached.response;
 END IF;

 -- receiving_source takes the canonical row FOR UPDATE; all matching and receipt
 -- paths use that same lock, so a later operation observes the archive marker.
 source := app_private.receiving_source(p_source_type,p_source_id);
 IF (source->>'updated_at')::timestamptz IS DISTINCT FROM p_expected_updated_at THEN
  RAISE EXCEPTION 'PENDING_DELETE_VERSION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 IF source->>'receiving_archived_at' IS NOT NULL OR source->>'receiving_deleted_at' IS NOT NULL OR source->>'cancelled_at' IS NOT NULL
  OR source->>'procurement_status'='RECEIVED'
  OR (p_source_type='SE_SUPPLY' AND (source->>'receiving_only')::boolean IS DISTINCT FROM true) THEN
  RAISE EXCEPTION 'PENDING_DELETE_INACTIVE' USING ERRCODE='PT409';
 END IF;

 -- Check append-only history, including cancelled matches and reversals. A
 -- current fulfilled quantity of zero is never evidence of zero downstream.
 IF EXISTS (SELECT 1 FROM public.receiving_arrival_matches m
            WHERE (p_source_type='PROJECT_MATERIAL' AND m.project_material_id=p_source_id)
               OR (p_source_type='SE_SUPPLY' AND m.se_supply_record_id=p_source_id))
  OR EXISTS (SELECT 1 FROM public.material_receipts r
             WHERE (p_source_type='PROJECT_MATERIAL' AND r.project_material_id=p_source_id)
                OR (p_source_type='SE_SUPPLY' AND r.se_supply_record_id=p_source_id))
  OR EXISTS (SELECT 1 FROM public.receiving_inventory_allocations a
             WHERE (p_source_type='PROJECT_MATERIAL' AND a.project_material_id=p_source_id)
                OR (p_source_type='SE_SUPPLY' AND a.se_supply_record_id=p_source_id))
  OR EXISTS (SELECT 1 FROM public.receiving_serial_entries e
             WHERE ((p_source_type='PROJECT_MATERIAL' AND e.project_material_id=p_source_id)
                 OR (p_source_type='SE_SUPPLY' AND e.se_supply_record_id=p_source_id))
               AND (e.active_receipt_id IS NOT NULL OR e.inventory_serial_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM public.material_receipt_serials l WHERE l.entry_id=e.id)
                 OR EXISTS (SELECT 1 FROM public.receiving_arrival_match_serials l WHERE l.pending_entry_id=e.id)))
  OR (source->>'received_at') IS NOT NULL OR (source->>'received_on') IS NOT NULL
  OR (source->>'inventory_serial_id') IS NOT NULL
  OR COALESCE((source->>'inventory_routed')::boolean,false) THEN
  RAISE EXCEPTION 'PENDING_DELETE_DOWNSTREAM_EXISTS' USING ERRCODE='PT409';
 END IF;

 at_time := clock_timestamp();
 FOR entry IN SELECT * FROM public.receiving_serial_entries e
  WHERE (p_source_type='PROJECT_MATERIAL' AND e.project_material_id=p_source_id)
     OR (p_source_type='SE_SUPPLY' AND e.se_supply_record_id=p_source_id)
  ORDER BY e.id FOR UPDATE LOOP
  IF entry.retired_at IS NULL THEN
   UPDATE public.receiving_serial_entries SET retired_at=at_time,updated_at=at_time WHERE id=entry.id;
   retired_ids := array_append(retired_ids,entry.id);
  END IF;
 END LOOP;
 INSERT INTO app_private.receiving_contract_context VALUES(txid_current(),pg_backend_pid(),p_source_type,p_source_id);
 IF p_source_type='PROJECT_MATERIAL' THEN
  UPDATE public.project_materials SET receiving_archived_at=at_time,receiving_deleted_at=at_time,updated_at=at_time WHERE id=p_source_id;
 ELSE
  UPDATE public.se_supply_records SET receiving_archived_at=at_time,receiving_deleted_at=at_time,updated_at=at_time WHERE id=p_source_id;
 END IF;
 DELETE FROM app_private.receiving_contract_context WHERE transaction_id=txid_current()
  AND backend_pid=pg_backend_pid() AND source_type=p_source_type AND source_id=p_source_id;
 result := jsonb_build_object('outcome','DELETED','id',p_source_id,'source_type',p_source_type,
  'archived_at',at_time,'retired_entry_ids',to_jsonb(retired_ids),'inventory_effect',0,'actor_id',actor.id);
 PERFORM app_private.inventory_audit('DELETE_RECEIVING_PENDING',source,result,
  'Mistaken pending source retired before downstream use');
 INSERT INTO app_private.receiving_requests VALUES(p_request_id,actor.id,payload,result,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.delete_receiving_pending_source(uuid,text,uuid,timestamptz) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.delete_receiving_pending_source(uuid,text,uuid,timestamptz) TO authenticated;

-- Keep the archived canonical row and its audit immutable even to older clients
-- with direct planning-table update privileges.
CREATE FUNCTION app_private.guard_deleted_receiving_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE kind text := CASE WHEN TG_TABLE_NAME='project_materials' THEN 'PROJECT_MATERIAL' ELSE 'SE_SUPPLY' END;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.receiving_deleted_at IS DISTINCT FROM OLD.receiving_deleted_at
   AND (OLD.receiving_deleted_at IS NOT NULL OR NEW.receiving_deleted_at IS NULL
    OR NEW.receiving_archived_at IS DISTINCT FROM NEW.receiving_deleted_at
    OR NOT EXISTS (SELECT 1 FROM app_private.receiving_contract_context c
     WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid()
      AND c.source_type=kind AND c.source_id=OLD.id)) THEN
   RAISE EXCEPTION 'PENDING_DELETE_RPC_REQUIRED' USING ERRCODE='PT409';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM public.activity_logs l
  WHERE l.action='DELETE_RECEIVING_PENDING' AND l.target_id=OLD.id::text
   AND l.changes->'after'->>'source_type'=kind) THEN
  RAISE EXCEPTION 'PENDING_DELETE_IMMUTABLE' USING ERRCODE='PT409';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_deleted_receiving_pending() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER deleted_receiving_project_guard BEFORE UPDATE OR DELETE ON public.project_materials
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_deleted_receiving_pending();
CREATE TRIGGER deleted_receiving_se_guard BEFORE UPDATE OR DELETE ON public.se_supply_records
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_deleted_receiving_pending();
NOTIFY pgrst,'reload schema';
