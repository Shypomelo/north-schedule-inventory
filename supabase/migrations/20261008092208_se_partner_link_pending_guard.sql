-- The link never changes Receiving quantity. Its own sum is capped by the canonical
-- remaining pending quantity, with a source row lock for concurrent attempts.
CREATE FUNCTION app_private.se_link_pending_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_scope jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'se-link:' || NEW.source_type || ':' || NEW.source_id::text, 0));
  IF NEW.source_type = 'PROJECT_MATERIAL' THEN
    PERFORM 1 FROM public.project_materials m WHERE m.id = NEW.source_id
      AND m.delivery_destination = 'OFFICE' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SE_LINK_NOT_PENDING' USING ERRCODE = 'P0001'; END IF;
    v_scope := public.get_receiving_pending_fulfilment(NEW.source_id, NULL);
  ELSIF NEW.source_type = 'SE_SUPPLY' THEN
    PERFORM 1 FROM public.se_supply_records s WHERE s.id = NEW.source_id
      AND s.receiving_only FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SE_LINK_NOT_PENDING' USING ERRCODE = 'P0001'; END IF;
    v_scope := public.get_receiving_pending_fulfilment(NULL, NEW.source_id);
  ELSE
    RAISE EXCEPTION 'SE_LINK_SOURCE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF coalesce((v_scope ->> 'active')::boolean, false) = false OR
    coalesce((SELECT sum(l.quantity) FROM public.se_order_item_links l
      WHERE l.source_type = NEW.source_type AND l.source_id = NEW.source_id AND l.cancelled_at IS NULL), 0)
      + NEW.quantity > (v_scope ->> 'remaining')::numeric THEN
    RAISE EXCEPTION 'SE_LINK_PENDING_CAPACITY' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.se_link_pending_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER se_link_pending_guard BEFORE INSERT ON public.se_order_item_links
FOR EACH ROW EXECUTE FUNCTION app_private.se_link_pending_guard();
