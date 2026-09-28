-- V6-B: explicit identity for new items; all existing rows remain NULL.
ALTER TABLE public.inventory_items ADD COLUMN canonical_identity_key text;

CREATE FUNCTION app_private.normalize_inventory_item_identity(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path='' AS $$
 SELECT lower(btrim(regexp_replace(value,'[[:space:]]+',' ','g')))
$$;
REVOKE ALL ON FUNCTION app_private.normalize_inventory_item_identity(text) FROM PUBLIC,anon,authenticated;

CREATE UNIQUE INDEX inventory_items_canonical_identity_key_unique
 ON public.inventory_items (app_private.normalize_inventory_item_identity(canonical_identity_key))
 WHERE canonical_identity_key IS NOT NULL;

CREATE FUNCTION app_private.guard_inventory_item_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.canonical_identity_key IS DISTINCT FROM OLD.canonical_identity_key THEN
   RAISE EXCEPTION 'INVENTORY_ITEM_IDENTITY_IMMUTABLE' USING ERRCODE='PT409';
  END IF;
 ELSIF NEW.canonical_identity_key IS NULL OR app_private.normalize_inventory_item_identity(NEW.canonical_identity_key)='' THEN
  RAISE EXCEPTION 'INVENTORY_ITEM_IDENTITY_REQUIRED' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_inventory_item_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inventory_item_identity_guard BEFORE INSERT OR UPDATE OF canonical_identity_key
 ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION app_private.guard_inventory_item_identity();

CREATE FUNCTION public.get_or_create_inventory_item(
 p_identity_key text,p_unit text,p_requires_serial boolean,p_definition jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); item public.inventory_items;
 identity text:=app_private.normalize_inventory_item_identity(p_identity_key);
 unit_name text:=btrim(regexp_replace(p_unit,'[[:space:]]+',' ','g')); candidates bigint;
 display_name text:=COALESCE(nullif(btrim(p_definition->>'name'),''),btrim(regexp_replace(p_identity_key,'[[:space:]]+',' ','g')));
BEGIN
 IF identity IS NULL OR identity='' OR length(identity)>200 OR unit_name IS NULL OR unit_name='' OR length(unit_name)>40 OR p_requires_serial IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_ITEM_DEFINITION_INVALID' USING ERRCODE='22023';
 END IF;
 -- Serialize check + insert, including competing legacy INSERT/UPDATE writers.
 -- No client-side check-then-insert; the partial unique index is the final guard.
 LOCK TABLE public.inventory_items IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO item FROM public.inventory_items
  WHERE canonical_identity_key IS NOT NULL AND app_private.normalize_inventory_item_identity(canonical_identity_key)=identity FOR UPDATE;
 IF item.id IS NULL THEN
  SELECT count(*) INTO candidates FROM public.inventory_items WHERE app_private.normalize_inventory_item_identity(code)=identity;
  IF candidates>1 THEN RAISE EXCEPTION 'AMBIGUOUS_EXISTING_ITEMS' USING ERRCODE='PT409'; END IF;
  SELECT * INTO item FROM public.inventory_items WHERE app_private.normalize_inventory_item_identity(code)=identity FOR UPDATE;
 END IF;
 IF item.id IS NOT NULL THEN
  IF NOT item.is_active OR app_private.normalize_inventory_item_identity(item.unit)<>app_private.normalize_inventory_item_identity(unit_name)
   OR item.requires_serial IS DISTINCT FROM p_requires_serial THEN
   RAISE EXCEPTION 'INVENTORY_ITEM_DEFINITION_CONFLICT' USING ERRCODE='PT409';
  END IF;
  RETURN jsonb_build_object('item',to_jsonb(item),'created',false);
 END IF;
 SELECT count(*) INTO candidates FROM public.inventory_items WHERE app_private.normalize_inventory_item_identity(name) IN(identity,app_private.normalize_inventory_item_identity(display_name));
 IF candidates>1 THEN RAISE EXCEPTION 'AMBIGUOUS_EXISTING_ITEMS' USING ERRCODE='PT409'; END IF;
 BEGIN
  INSERT INTO public.inventory_items(code,name,unit,requires_serial,canonical_identity_key,category,item_category,source_type,
   opening_quantity,low_stock_threshold,is_se_maintenance_equipment,notes,is_active)
  VALUES(btrim(regexp_replace(p_identity_key,'[[:space:]]+',' ','g')),display_name,unit_name,p_requires_serial,identity,
   COALESCE(nullif(p_definition->>'category',''),'設備維修'),nullif(p_definition->>'item_category',''),COALESCE(nullif(p_definition->>'source_type',''),'其他'),
   COALESCE((p_definition->>'opening_quantity')::numeric,0),COALESCE((p_definition->>'low_stock_threshold')::numeric,0),
   COALESCE((p_definition->>'is_se_maintenance_equipment')::boolean,false),p_definition->>'notes',true)
  RETURNING * INTO item;
 EXCEPTION WHEN unique_violation THEN
  SELECT * INTO item FROM public.inventory_items WHERE canonical_identity_key IS NOT NULL AND app_private.normalize_inventory_item_identity(canonical_identity_key)=identity;
  IF item.id IS NULL THEN RAISE EXCEPTION 'INVENTORY_ITEM_DEFINITION_CONFLICT' USING ERRCODE='PT409'; END IF;
  IF NOT item.is_active OR app_private.normalize_inventory_item_identity(item.unit)<>app_private.normalize_inventory_item_identity(unit_name)
   OR item.requires_serial IS DISTINCT FROM p_requires_serial THEN
   RAISE EXCEPTION 'INVENTORY_ITEM_DEFINITION_CONFLICT' USING ERRCODE='PT409';
  END IF;
  RETURN jsonb_build_object('item',to_jsonb(item),'created',false);
 END;
 RETURN jsonb_build_object('item',to_jsonb(item),'created',true);
END $$;
REVOKE ALL ON FUNCTION public.get_or_create_inventory_item(text,text,boolean,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_inventory_item(text,text,boolean,jsonb) TO authenticated;
REVOKE INSERT ON public.inventory_items FROM PUBLIC,anon,authenticated;
-- The new key is read-only to clients, even if legacy table-level UPDATE exists.
-- Trigger above forbids changing any old NULL key or an established identity.
GRANT SELECT(canonical_identity_key) ON public.inventory_items TO authenticated;

-- Existing requirements are read by canonical project/item, with effective SITE quantity.
CREATE FUNCTION public.get_receiving_project_requirements(p_project_id uuid,p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN
  RAISE EXCEPTION 'INVALID_PROJECT' USING ERRCODE='PT409';
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]') INTO result FROM (
  SELECT m.id,m.batch_id,b.batch_name,m.item_name,m.specification,m.unit,m.quantity,m.created_at,
   COALESCE((SELECT sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END)
    FROM public.material_receipts WHERE project_material_id=m.id AND (receipt_location='SITE' OR receipt_location IS NULL)),0) AS received
  FROM public.project_materials m JOIN public.project_material_batches b ON b.id=m.batch_id
  JOIN public.inventory_items i ON i.id=m.inventory_item_id
  WHERE m.project_id=p_project_id AND m.inventory_item_id=p_item_id AND m.receiving_archived_at IS NULL
   AND m.delivery_destination='SITE' AND m.procurement_status<>'RECEIVED' AND m.unit=i.unit
 ) r WHERE r.quantity>r.received;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_receiving_project_requirements(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_receiving_project_requirements(uuid,uuid) TO authenticated;

-- Keep the existing canonical handoff/retract writer. Reject a stale or mismatched
-- explicitly selected requirement before delegating; no change to SE behavior.
ALTER FUNCTION public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 SET SCHEMA app_private;
ALTER FUNCTION app_private.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text)
 RENAME TO route_receiving_inventory_before_item_identity;
REVOKE ALL ON FUNCTION app_private.route_receiving_inventory_before_item_identity(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.route_receiving_inventory(p_request_id uuid,p_receipt_id uuid,p_route_type text,p_quantity numeric,p_serial_ids uuid[],p_project_id uuid,p_material_id uuid,p_create_new boolean,p_received_at timestamptz,p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.team_members:=app_private.inventory_actor(); scope jsonb;
BEGIN
 -- Cached retries retain the original writer's payload/actor validation and result.
 PERFORM pg_advisory_xact_lock(hashtextextended('receiving:'||p_request_id::text,0));
 IF p_route_type='SITE' AND p_material_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_private.receiving_requests WHERE request_id=p_request_id) THEN
  LOCK TABLE public.se_supply_records IN SHARE ROW EXCLUSIVE MODE;
  scope:=app_private.lock_receiving_handoff(p_receipt_id);
  PERFORM 1 FROM public.project_materials WHERE id=p_material_id AND project_id=p_project_id
   AND inventory_item_id=(scope->>'item_id')::uuid AND receiving_archived_at IS NULL AND delivery_destination='SITE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_REQUIREMENT_CHANGED' USING ERRCODE='PT409'; END IF;
 END IF;
 RETURN app_private.route_receiving_inventory_before_item_identity(p_request_id,p_receipt_id,p_route_type,p_quantity,p_serial_ids,p_project_id,p_material_id,p_create_new,p_received_at,p_notes);
END $$;
REVOKE ALL ON FUNCTION public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.route_receiving_inventory(uuid,uuid,text,numeric,uuid[],uuid,uuid,boolean,timestamptz,text) TO authenticated;
