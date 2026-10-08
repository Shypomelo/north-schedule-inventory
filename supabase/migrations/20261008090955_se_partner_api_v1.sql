-- SolarEdge Partner orders are external evidence, never Receiving or Inventory postings.
CREATE TABLE public.se_orders (
  order_no text PRIMARY KEY CHECK (btrim(order_no) <> ''),
  case_numbers text[] NOT NULL DEFAULT '{}',
  site_name text NOT NULL DEFAULT '',
  raw_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(raw_items) = 'array'),
  status text NOT NULL DEFAULT '',
  status_label text NOT NULL DEFAULT '',
  carrier text NOT NULL DEFAULT '',
  tracking_nos text[] NOT NULL DEFAULT '{}',
  created_on date,
  api_updated_at timestamptz,
  scope_state text NOT NULL DEFAULT 'UNREVIEWED' CHECK (scope_state IN ('UNREVIEWED', 'NORTH', 'NOT_NORTH')),
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  removed_at timestamptz,
  removed_reason text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope_state = 'NORTH' OR project_id IS NULL)
);

-- Stable aggregate identity is (order, normalized model). API array positions stay only in raw_items.
CREATE TABLE public.se_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no text NOT NULL REFERENCES public.se_orders(order_no) ON DELETE RESTRICT,
  model_name text NOT NULL CHECK (btrim(model_name) <> ''),
  model_key text NOT NULL CHECK (model_key = upper(btrim(model_name))),
  quantity numeric NOT NULL CHECK (quantity > 0),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (order_no, model_key)
);

CREATE TABLE public.se_order_item_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.se_order_items(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('PROJECT_MATERIAL', 'SE_SUPPLY')),
  source_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL CHECK (quantity > 0),
  created_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE UNIQUE INDEX se_order_item_links_active_identity
ON public.se_order_item_links(item_id, source_type, source_id) WHERE cancelled_at IS NULL;
CREATE INDEX se_order_item_links_source ON public.se_order_item_links(source_type, source_id) WHERE cancelled_at IS NULL;

-- Exact case numbers only. Split suffixes never inherit by string manipulation.
CREATE TABLE public.se_case_scope_rules (
  case_number text PRIMARY KEY CHECK (btrim(case_number) <> ''),
  scope_state text NOT NULL CHECK (scope_state IN ('NORTH', 'NOT_NORTH')),
  project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
  confirmed_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_state = 'NORTH' AND project_id IS NOT NULL) OR (scope_state = 'NOT_NORTH' AND project_id IS NULL))
);

-- Future manual SN reservation. The Partner API does not provide serial numbers.
CREATE TABLE public.se_order_item_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.se_order_items(id) ON DELETE RESTRICT,
  serial_number text NOT NULL CHECK (btrim(serial_number) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, serial_number)
);

-- One row per reserved external GET. Reservations count even when HTTP fails.
CREATE TABLE public.se_api_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('MANUAL', 'SCHEDULED')),
  page_no integer NOT NULL CHECK (page_no BETWEEN 1 AND 4),
  requested_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'APPLIED', 'FAILED')),
  since_at timestamptz,
  watermark_at timestamptz,
  error_code text,
  UNIQUE (run_id, page_no)
);
CREATE INDEX se_api_sync_runs_quota ON public.se_api_sync_runs(requested_at DESC);

ALTER TABLE public.se_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se_order_item_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se_case_scope_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se_order_item_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se_api_sync_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.se_orders, public.se_order_items, public.se_order_item_links,
  public.se_order_item_serials, public.se_case_scope_rules, public.se_api_sync_runs TO authenticated;

CREATE POLICY se_orders_read ON public.se_orders FOR SELECT TO authenticated USING (
  (SELECT app_private.is_admin_member()) OR
  ((SELECT app_private.is_active_member()) AND scope_state = 'NORTH')
);
CREATE POLICY se_order_items_read ON public.se_order_items FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.se_orders o WHERE o.order_no = se_order_items.order_no)
);
CREATE POLICY se_order_item_links_read ON public.se_order_item_links FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.se_order_items i WHERE i.id = se_order_item_links.item_id)
);
CREATE POLICY se_order_item_serials_read ON public.se_order_item_serials FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.se_order_items i WHERE i.id = se_order_item_serials.item_id)
);
CREATE POLICY se_case_scope_rules_admin_read ON public.se_case_scope_rules FOR SELECT TO authenticated
  USING ((SELECT app_private.is_admin_member()));
CREATE POLICY se_api_sync_runs_admin_read ON public.se_api_sync_runs FOR SELECT TO authenticated
  USING ((SELECT app_private.is_admin_member()));

CREATE FUNCTION app_private.se_sync_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_private.is_admin_member() OR coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;
REVOKE ALL ON FUNCTION app_private.se_sync_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.se_sync_allowed() TO authenticated, service_role;

CREATE FUNCTION public.se_sync_reserve(p_mode text, p_run_id uuid DEFAULT NULL, p_page_no integer DEFAULT 1)
RETURNS TABLE (request_id uuid, run_id uuid, since_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_day date := (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date;
  v_run uuid;
  v_since timestamptz;
  v_id uuid;
  v_mode_limit integer;
BEGIN
  IF NOT app_private.se_sync_allowed() THEN RAISE EXCEPTION 'SE_SYNC_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF p_mode NOT IN ('MANUAL', 'SCHEDULED') OR p_page_no NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'SE_SYNC_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  v_mode_limit := CASE WHEN p_mode = 'SCHEDULED' THEN 6 ELSE 2 END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('se-partner-api-quota', 0));
  IF (SELECT count(*) FROM public.se_api_sync_runs r
      WHERE (r.requested_at AT TIME ZONE 'Asia/Taipei')::date = v_day) >= 8 THEN
    RAISE EXCEPTION 'SE_DAILY_QUOTA' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.se_api_sync_runs r
      WHERE r.mode = p_mode AND (r.requested_at AT TIME ZONE 'Asia/Taipei')::date = v_day)
      >= v_mode_limit THEN
    RAISE EXCEPTION 'SE_MODE_QUOTA' USING ERRCODE = 'P0001';
  END IF;
  IF p_page_no = 1 THEN
    IF p_run_id IS NOT NULL THEN RAISE EXCEPTION 'SE_RUN_ID_UNEXPECTED' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.se_api_sync_runs r
        WHERE r.page_no = 1 AND r.requested_at > v_now - interval '1 hour') THEN
      RAISE EXCEPTION 'SE_HOURLY_QUOTA' USING ERRCODE = 'P0001';
    END IF;
    v_run := gen_random_uuid();
    SELECT max(r.watermark_at) INTO v_since FROM public.se_api_sync_runs r
      WHERE r.page_no = 1 AND r.state = 'APPLIED';
  ELSE
    IF p_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.se_api_sync_runs r
      WHERE r.run_id = p_run_id AND r.page_no = p_page_no - 1
        AND r.state = 'RESERVED' AND r.requested_at > v_now - interval '15 minutes') THEN
      RAISE EXCEPTION 'SE_RUN_NOT_ACTIVE' USING ERRCODE = 'P0001';
    END IF;
    v_run := p_run_id;
    SELECT r.since_at INTO v_since FROM public.se_api_sync_runs r
      WHERE r.run_id = v_run AND r.page_no = 1;
    IF (SELECT r.mode FROM public.se_api_sync_runs r WHERE r.run_id = v_run AND r.page_no = 1) <> p_mode THEN
      RAISE EXCEPTION 'SE_RUN_MODE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  INSERT INTO public.se_api_sync_runs(run_id, mode, page_no, requested_at, since_at)
  VALUES (v_run, p_mode, p_page_no, v_now, v_since) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_run, v_since;
END;
$$;
REVOKE ALL ON FUNCTION public.se_sync_reserve(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_sync_reserve(text, uuid, integer) TO authenticated, service_role;

CREATE FUNCTION public.se_sync_fail(p_run_id uuid, p_error_code text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app_private.se_sync_allowed() THEN RAISE EXCEPTION 'SE_SYNC_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  UPDATE public.se_api_sync_runs SET state = 'FAILED', error_code = left(coalesce(p_error_code, 'UNKNOWN'), 80)
  WHERE run_id = p_run_id AND state = 'RESERVED';
END;
$$;
REVOKE ALL ON FUNCTION public.se_sync_fail(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_sync_fail(uuid, text) TO authenticated, service_role;

CREATE FUNCTION public.se_sync_apply(p_run_id uuid, p_payload jsonb, p_page_count integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order jsonb;
  v_removed jsonb;
  v_item record;
  v_order_no text;
  v_cases text[];
  v_items jsonb;
  v_old_cases text[];
  v_old_scope text;
  v_old_project uuid;
  v_old_removed timestamptz;
  v_reviewed_by uuid;
  v_reviewed_at timestamptz;
  v_scope text;
  v_project uuid;
  v_rule_total integer;
  v_rule_count integer;
  v_rule_north integer;
  v_rule_not_north integer;
  v_rule_projects uuid[];
  v_changed boolean;
  v_first_at timestamptz;
BEGIN
  IF NOT app_private.se_sync_allowed() THEN RAISE EXCEPTION 'SE_SYNC_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('se-partner-api-quota', 0));
  IF p_page_count NOT BETWEEN 1 AND 4 OR
    (SELECT count(*) FROM public.se_api_sync_runs r WHERE r.run_id = p_run_id AND r.state = 'RESERVED') <> p_page_count OR
    (SELECT count(DISTINCT r.page_no) FROM public.se_api_sync_runs r WHERE r.run_id = p_run_id) <> p_page_count OR
    NOT EXISTS (SELECT 1 FROM public.se_api_sync_runs r WHERE r.run_id = p_run_id AND r.page_no = 1
      AND r.requested_at > clock_timestamp() - interval '15 minutes') THEN
    RAISE EXCEPTION 'SE_RUN_NOT_COMPLETE' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' OR jsonb_typeof(p_payload -> 'orders') <> 'array'
    OR jsonb_typeof(p_payload -> 'removed') <> 'array' THEN
    RAISE EXCEPTION 'SE_PAYLOAD_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT r.requested_at INTO v_first_at FROM public.se_api_sync_runs r
    WHERE r.run_id = p_run_id AND r.page_no = 1;

  FOR v_order IN SELECT value FROM jsonb_array_elements(p_payload -> 'orders') value LOOP
    v_order_no := btrim(v_order ->> 'orderNo');
    v_items := v_order -> 'items';
    IF v_order_no IS NULL OR v_order_no = '' OR jsonb_typeof(v_order -> 'caseNumbers') <> 'array'
      OR jsonb_typeof(v_items) <> 'array' OR v_order ->> 'siteName' IS NULL
      OR v_order ->> 'status' IS NULL OR v_order ->> 'statusLabel' IS NULL
      OR v_order ->> 'carrier' IS NULL OR jsonb_typeof(v_order -> 'trackingNos') <> 'array'
      OR v_order ->> 'createdAt' IS NULL OR v_order ->> 'updatedAt' IS NULL THEN
      RAISE EXCEPTION 'SE_ORDER_INVALID' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i
      WHERE jsonb_typeof(i) <> 'object' OR btrim(i ->> 'name') = ''
        OR (i ->> 'qty')::numeric <= 0) THEN
      RAISE EXCEPTION 'SE_ITEM_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(array_agg(value), '{}') INTO v_cases FROM jsonb_array_elements_text(v_order -> 'caseNumbers') value;
    v_old_cases := NULL; v_old_scope := NULL; v_old_project := NULL; v_old_removed := NULL;
    v_reviewed_by := NULL; v_reviewed_at := NULL;
    SELECT o.case_numbers, o.scope_state, o.project_id, o.removed_at, o.reviewed_by, o.reviewed_at
      INTO v_old_cases, v_old_scope, v_old_project, v_old_removed, v_reviewed_by, v_reviewed_at
    FROM public.se_orders o WHERE o.order_no = v_order_no FOR UPDATE;
    IF v_old_scope IN ('NORTH', 'NOT_NORTH') AND v_old_cases = v_cases AND v_old_removed IS NULL THEN
      v_scope := v_old_scope; v_project := v_old_project;
    ELSE
      SELECT count(*), count(r.case_number), count(*) FILTER (WHERE r.scope_state = 'NORTH'),
        count(*) FILTER (WHERE r.scope_state = 'NOT_NORTH'),
        array_agg(DISTINCT r.project_id) FILTER (WHERE r.project_id IS NOT NULL)
      INTO v_rule_total, v_rule_count, v_rule_north, v_rule_not_north, v_rule_projects
      FROM unnest(v_cases) c LEFT JOIN public.se_case_scope_rules r ON r.case_number = c;
      v_scope := 'UNREVIEWED'; v_project := NULL; v_reviewed_by := NULL; v_reviewed_at := NULL;
      IF v_rule_total > 0 AND v_rule_count = v_rule_total THEN
        IF v_rule_north = v_rule_total THEN
          v_scope := 'NORTH';
          IF cardinality(v_rule_projects) = 1 THEN v_project := v_rule_projects[1]; END IF;
        ELSIF v_rule_not_north = v_rule_total THEN
          v_scope := 'NOT_NORTH';
        END IF;
      END IF;
    END IF;
    v_changed := v_old_cases IS DISTINCT FROM v_cases OR v_old_scope IS DISTINCT FROM v_scope OR v_old_removed IS NOT NULL;
    INSERT INTO public.se_orders(order_no, case_numbers, site_name, raw_items, status, status_label,
      carrier, tracking_nos, created_on, api_updated_at, scope_state, project_id,
      reviewed_by, reviewed_at, removed_at, removed_reason, synced_at)
    VALUES (v_order_no, v_cases,
      CASE WHEN v_scope = 'NOT_NORTH' THEN '' ELSE v_order ->> 'siteName' END,
      CASE WHEN v_scope = 'NOT_NORTH' THEN '[]'::jsonb ELSE v_items END,
      CASE WHEN v_scope = 'NOT_NORTH' THEN '' ELSE v_order ->> 'status' END,
      CASE WHEN v_scope = 'NOT_NORTH' THEN '' ELSE v_order ->> 'statusLabel' END,
      CASE WHEN v_scope = 'NOT_NORTH' THEN '' ELSE v_order ->> 'carrier' END,
      CASE WHEN v_scope = 'NOT_NORTH' THEN '{}'::text[] ELSE
        ARRAY(SELECT value FROM jsonb_array_elements_text(v_order -> 'trackingNos') value) END,
      CASE WHEN v_scope = 'NOT_NORTH' THEN NULL ELSE (v_order ->> 'createdAt')::date END,
      nullif(v_order ->> 'updatedAt', '')::timestamptz,
      v_scope, v_project, v_reviewed_by, v_reviewed_at, NULL, NULL, clock_timestamp())
    ON CONFLICT (order_no) DO UPDATE SET
      case_numbers = excluded.case_numbers, site_name = excluded.site_name, raw_items = excluded.raw_items,
      status = excluded.status, status_label = excluded.status_label, carrier = excluded.carrier,
      tracking_nos = excluded.tracking_nos, created_on = excluded.created_on,
      api_updated_at = excluded.api_updated_at, scope_state = excluded.scope_state,
      project_id = excluded.project_id, reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at, removed_at = NULL, removed_reason = NULL, synced_at = excluded.synced_at;
    IF v_changed OR v_order ->> 'status' = 'cancelled' THEN
      UPDATE public.se_order_item_links l SET cancelled_at = clock_timestamp()
      WHERE l.cancelled_at IS NULL AND EXISTS (
        SELECT 1 FROM public.se_order_items i WHERE i.id = l.item_id AND i.order_no = v_order_no);
    END IF;
    IF v_scope = 'NOT_NORTH' THEN
      DELETE FROM public.se_order_item_links l WHERE EXISTS (
        SELECT 1 FROM public.se_order_items i WHERE i.id = l.item_id AND i.order_no = v_order_no);
      DELETE FROM public.se_order_item_serials s WHERE EXISTS (
        SELECT 1 FROM public.se_order_items i WHERE i.id = s.item_id AND i.order_no = v_order_no);
      DELETE FROM public.se_order_items WHERE order_no = v_order_no;
    ELSE
      UPDATE public.se_order_items SET is_active = false WHERE order_no = v_order_no;
      FOR v_item IN
        SELECT min(btrim(i ->> 'name')) AS model_name, upper(btrim(i ->> 'name')) AS model_key,
          sum((i ->> 'qty')::numeric) AS quantity
        FROM jsonb_array_elements(v_items) i GROUP BY upper(btrim(i ->> 'name'))
      LOOP
        INSERT INTO public.se_order_items(order_no, model_name, model_key, quantity, is_active)
        VALUES (v_order_no, v_item.model_name, v_item.model_key, v_item.quantity,
          v_order ->> 'status' <> 'cancelled')
        ON CONFLICT (order_no, model_key) DO UPDATE SET model_name = excluded.model_name,
          quantity = excluded.quantity, is_active = excluded.is_active;
      END LOOP;
      UPDATE public.se_order_item_links l SET cancelled_at = clock_timestamp()
      WHERE l.cancelled_at IS NULL AND EXISTS (
        SELECT 1 FROM public.se_order_items i WHERE i.id = l.item_id AND i.order_no = v_order_no
          AND (NOT i.is_active OR i.quantity < (SELECT sum(x.quantity) FROM public.se_order_item_links x
            WHERE x.item_id = i.id AND x.cancelled_at IS NULL)));
    END IF;
  END LOOP;

  FOR v_removed IN SELECT value FROM jsonb_array_elements(p_payload -> 'removed') value LOOP
    v_order_no := btrim(v_removed ->> 'orderNo');
    IF v_order_no IS NULL OR v_order_no = '' OR v_removed ->> 'reason' NOT IN ('deleted', 'reassigned')
      OR v_removed ->> 'removedAt' IS NULL THEN
      RAISE EXCEPTION 'SE_REMOVED_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.se_orders(order_no, removed_at, removed_reason)
      VALUES (v_order_no, (v_removed ->> 'removedAt')::timestamptz, v_removed ->> 'reason')
    ON CONFLICT (order_no) DO UPDATE SET removed_at = excluded.removed_at,
      removed_reason = excluded.removed_reason, synced_at = clock_timestamp();
    UPDATE public.se_order_items SET is_active = false WHERE order_no = v_order_no;
    UPDATE public.se_order_item_links l SET cancelled_at = clock_timestamp()
      WHERE l.cancelled_at IS NULL AND EXISTS (
        SELECT 1 FROM public.se_order_items i WHERE i.id = l.item_id AND i.order_no = v_order_no);
  END LOOP;
  UPDATE public.se_api_sync_runs SET state = 'APPLIED', watermark_at = CASE WHEN page_no = 1 THEN v_first_at ELSE NULL END
    WHERE run_id = p_run_id AND state = 'RESERVED';
END;
$$;
REVOKE ALL ON FUNCTION public.se_sync_apply(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_sync_apply(uuid, jsonb, integer) TO authenticated, service_role;

CREATE FUNCTION public.se_set_case_scope_rule(p_case_number text, p_scope text, p_project_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_case text := btrim(p_case_number);
BEGIN
  IF NOT app_private.is_admin_member() THEN RAISE EXCEPTION 'SE_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF v_case IS NULL OR v_case = '' OR p_scope NOT IN ('NORTH', 'NOT_NORTH') OR
    (p_scope = 'NORTH' AND (p_project_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL))) OR
    (p_scope = 'NOT_NORTH' AND p_project_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SE_CASE_RULE_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.se_case_scope_rules(case_number, scope_state, project_id, confirmed_by)
  VALUES (v_case, p_scope, p_project_id, app_private.current_member_id())
  ON CONFLICT (case_number) DO UPDATE SET scope_state = excluded.scope_state,
    project_id = excluded.project_id, confirmed_by = excluded.confirmed_by, confirmed_at = clock_timestamp();
  -- A changed rule removes old visibility until the whole order is reviewed again.
  UPDATE public.se_orders SET scope_state = 'UNREVIEWED', project_id = NULL,
    reviewed_by = NULL, reviewed_at = NULL
  WHERE v_case = ANY(case_numbers);
  UPDATE public.se_order_item_links l SET cancelled_at = clock_timestamp()
  WHERE l.cancelled_at IS NULL AND EXISTS (
    SELECT 1 FROM public.se_order_items i JOIN public.se_orders o ON o.order_no = i.order_no
    WHERE i.id = l.item_id AND v_case = ANY(o.case_numbers));
END;
$$;
REVOKE ALL ON FUNCTION public.se_set_case_scope_rule(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_set_case_scope_rule(text, text, uuid) TO authenticated;

CREATE FUNCTION public.se_confirm_order_scope(p_order_no text, p_scope text, p_project_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order public.se_orders%ROWTYPE;
  v_rule_count integer;
  v_north_count integer;
  v_project_count integer;
  v_rule_project uuid;
BEGIN
  IF NOT app_private.is_admin_member() THEN RAISE EXCEPTION 'SE_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_order FROM public.se_orders WHERE order_no = p_order_no FOR UPDATE;
  IF NOT FOUND OR v_order.removed_at IS NOT NULL OR v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'SE_ORDER_INACTIVE' USING ERRCODE = 'P0001';
  END IF;
  IF p_scope NOT IN ('UNREVIEWED', 'NORTH', 'NOT_NORTH') THEN
    RAISE EXCEPTION 'SE_SCOPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_scope = 'NORTH' THEN
    IF p_project_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'SE_PROJECT_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT count(r.case_number), count(*) FILTER (WHERE r.scope_state = 'NORTH'),
      count(DISTINCT r.project_id), min(r.project_id::text)::uuid
    INTO v_rule_count, v_north_count, v_project_count, v_rule_project
    FROM unnest(v_order.case_numbers) c LEFT JOIN public.se_case_scope_rules r ON r.case_number = c;
    IF cardinality(v_order.case_numbers) > 1 THEN
      IF v_rule_count <> cardinality(v_order.case_numbers) OR
        v_north_count <> cardinality(v_order.case_numbers) THEN
        RAISE EXCEPTION 'SE_MULTI_CASE_REVIEW_REQUIRED' USING ERRCODE = 'P0001';
      END IF;
      IF v_project_count <> 1 AND p_project_id IS NOT NULL THEN
        RAISE EXCEPTION 'SE_MULTI_PROJECT_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      IF v_project_count = 1 AND p_project_id IS DISTINCT FROM v_rule_project THEN
        RAISE EXCEPTION 'SE_CASE_PROJECT_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_rule_count = 1 THEN
      IF v_north_count <> 1 OR (p_project_id IS NOT NULL AND p_project_id <> v_rule_project) THEN
        RAISE EXCEPTION 'SE_CASE_SCOPE_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF cardinality(v_order.case_numbers) <= 1 AND coalesce(p_project_id, v_rule_project) IS NULL THEN
      RAISE EXCEPTION 'SE_PROJECT_REQUIRED' USING ERRCODE = '22023';
    END IF;
    UPDATE public.se_orders SET scope_state = 'NORTH',
      project_id = CASE WHEN cardinality(v_order.case_numbers) > 1 AND v_project_count > 1
        THEN NULL ELSE coalesce(p_project_id, v_rule_project) END,
      reviewed_by = app_private.current_member_id(), reviewed_at = clock_timestamp()
    WHERE order_no = p_order_no;
  ELSE
    UPDATE public.se_order_item_links l SET cancelled_at = clock_timestamp()
    WHERE l.cancelled_at IS NULL AND EXISTS
      (SELECT 1 FROM public.se_order_items i WHERE i.id = l.item_id AND i.order_no = p_order_no);
    UPDATE public.se_orders SET scope_state = p_scope, project_id = NULL,
      reviewed_by = app_private.current_member_id(), reviewed_at = clock_timestamp()
    WHERE order_no = p_order_no;
    IF p_scope = 'NOT_NORTH' THEN
      UPDATE public.se_orders SET site_name = '', raw_items = '[]'::jsonb, status = '',
        status_label = '', carrier = '', tracking_nos = '{}', created_on = NULL WHERE order_no = p_order_no;
      DELETE FROM public.se_order_item_links l WHERE EXISTS
        (SELECT 1 FROM public.se_order_items i WHERE i.id = l.item_id AND i.order_no = p_order_no);
      DELETE FROM public.se_order_item_serials s WHERE EXISTS
        (SELECT 1 FROM public.se_order_items i WHERE i.id = s.item_id AND i.order_no = p_order_no);
      DELETE FROM public.se_order_items WHERE order_no = p_order_no;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.se_confirm_order_scope(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_confirm_order_scope(text, text, uuid) TO authenticated;

CREATE FUNCTION public.se_link_order_item(p_item_id uuid, p_source_type text, p_source_id uuid, p_quantity numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item public.se_order_items%ROWTYPE;
  v_order public.se_orders%ROWTYPE;
  v_project_id uuid;
  v_model text;
  v_alt_model text;
  v_source_quantity numeric;
  v_link_id uuid;
BEGIN
  IF NOT app_private.is_admin_member() THEN RAISE EXCEPTION 'SE_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_source_type NOT IN ('PROJECT_MATERIAL', 'SE_SUPPLY') THEN
    RAISE EXCEPTION 'SE_LINK_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('se-link:' || p_source_type || ':' || p_source_id::text, 0));
  SELECT * INTO v_item FROM public.se_order_items WHERE id = p_item_id FOR UPDATE;
  SELECT * INTO v_order FROM public.se_orders WHERE order_no = v_item.order_no FOR UPDATE;
  IF v_item.id IS NULL OR NOT v_item.is_active OR v_order.scope_state <> 'NORTH'
    OR v_order.status = 'cancelled' OR v_order.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'SE_LINK_ORDER_INACTIVE' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_type = 'PROJECT_MATERIAL' THEN
    SELECT m.project_id, m.quantity, i.code, m.specification
      INTO v_project_id, v_source_quantity, v_model, v_alt_model
    FROM public.project_materials m LEFT JOIN public.inventory_items i ON i.id = m.inventory_item_id
    WHERE m.id = p_source_id AND m.receiving_archived_at IS NULL AND m.receiving_deleted_at IS NULL
      AND m.procurement_status <> 'RECEIVED' FOR UPDATE OF m;
  ELSE
    SELECT s.project_id, s.quantity, i.code, s.new_model
      INTO v_project_id, v_source_quantity, v_model, v_alt_model
    FROM public.se_supply_records s LEFT JOIN public.inventory_items i ON i.id = s.inventory_item_id
    WHERE s.id = p_source_id AND s.receiving_only AND s.cancelled_at IS NULL
      AND s.receiving_archived_at IS NULL AND s.receiving_deleted_at IS NULL
      AND s.procurement_status <> 'RECEIVED' FOR UPDATE OF s;
  END IF;
  IF v_project_id IS NULL OR v_source_quantity IS NULL OR
    (upper(btrim(coalesce(v_model, ''))) <> v_item.model_key AND
      upper(btrim(coalesce(v_alt_model, ''))) <> v_item.model_key) THEN
    RAISE EXCEPTION 'SE_LINK_SOURCE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_order.project_id IS NOT NULL AND v_order.project_id <> v_project_id THEN
    RAISE EXCEPTION 'SE_LINK_PROJECT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_order.project_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.se_case_scope_rules r WHERE r.case_number = ANY(v_order.case_numbers)
      AND r.scope_state = 'NORTH' AND r.project_id = v_project_id) THEN
    RAISE EXCEPTION 'SE_LINK_PROJECT_UNCONFIRMED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.se_order_item_links l WHERE l.item_id = p_item_id
      AND l.source_type = p_source_type AND l.source_id = p_source_id AND l.cancelled_at IS NULL) OR
    coalesce((SELECT sum(l.quantity) FROM public.se_order_item_links l
      WHERE l.item_id = p_item_id AND l.cancelled_at IS NULL), 0) + p_quantity > v_item.quantity OR
    coalesce((SELECT sum(l.quantity) FROM public.se_order_item_links l
      WHERE l.source_type = p_source_type AND l.source_id = p_source_id AND l.cancelled_at IS NULL), 0)
      + p_quantity > v_source_quantity THEN
    RAISE EXCEPTION 'SE_LINK_CAPACITY' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.se_order_item_links(item_id, source_type, source_id, project_id, quantity, created_by)
    VALUES (p_item_id, p_source_type, p_source_id, v_project_id, p_quantity, app_private.current_member_id())
    RETURNING id INTO v_link_id;
  RETURN v_link_id;
END;
$$;
REVOKE ALL ON FUNCTION public.se_link_order_item(uuid, text, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_link_order_item(uuid, text, uuid, numeric) TO authenticated;

CREATE FUNCTION public.se_unlink_order_item(p_link_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app_private.is_admin_member() THEN RAISE EXCEPTION 'SE_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  UPDATE public.se_order_item_links SET cancelled_at = clock_timestamp()
  WHERE id = p_link_id AND cancelled_at IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.se_unlink_order_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.se_unlink_order_item(uuid) TO authenticated;

-- This project grants anon EXECUTE through default privileges, independent of PUBLIC.
REVOKE ALL ON FUNCTION app_private.se_sync_allowed() FROM anon;
REVOKE ALL ON FUNCTION public.se_sync_reserve(text, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.se_sync_fail(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.se_sync_apply(uuid, jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.se_set_case_scope_rule(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.se_confirm_order_scope(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.se_link_order_item(uuid, text, uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.se_unlink_order_item(uuid) FROM anon;
