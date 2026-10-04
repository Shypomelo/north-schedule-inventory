-- Distinguish immutable preparation lineage from demand capacity.
CREATE OR REPLACE FUNCTION app_private.guard_project_prep_material() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE prepared numeric; received numeric;
BEGIN
 SELECT COALESCE(sum(quantity),0) INTO prepared FROM public.receiving_inventory_allocations
  WHERE project_material_id=OLD.id AND route_type='PROJECT_PREP' AND cancelled_at IS NULL;
 IF prepared=0 THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROJECT_PREP_RETRACTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 IF row(NEW.project_id,NEW.inventory_item_id,NEW.unit,NEW.delivery_destination,NEW.receiving_archived_at)
  IS DISTINCT FROM row(OLD.project_id,OLD.inventory_item_id,OLD.unit,OLD.delivery_destination,OLD.receiving_archived_at)
 THEN RAISE EXCEPTION 'PROJECT_PREP_RETRACTION_REQUIRED' USING ERRCODE='PT409'; END IF;
 SELECT COALESCE(sum(CASE WHEN event_type='REVERSAL' THEN -quantity_received ELSE quantity_received END),0)
 INTO received FROM public.material_receipts WHERE project_material_id=OLD.id
  AND (receipt_location='SITE' OR receipt_location IS NULL);
 IF NEW.quantity<prepared+received
 THEN RAISE EXCEPTION 'PROJECT_PREP_CAPACITY_CONFLICT' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_project_prep_material() FROM PUBLIC,anon,authenticated,service_role;
