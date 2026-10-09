-- Reject stale project drag payloads after taking the same advisory lock used
-- by new-item position seeding. The client supplies the positions it read.
CREATE OR REPLACE FUNCTION public.reorder_project_work_items(p_project_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_expected text[]; v_received text[]; v_current jsonb; v_before jsonb; v_updated integer;
BEGIN
  IF NOT app_private.is_editor_member() THEN
    RAISE EXCEPTION 'Editor required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order must be an array' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('project-item-order:'||p_project_id::text,0));
  SELECT coalesce(array_agg(item_kind||':'||item_id::text ORDER BY item_kind,item_id),'{}'::text[])
    INTO v_expected FROM (
      SELECT 'MILESTONE'::text item_kind,id item_id FROM public.project_milestones
        WHERE project_id=p_project_id AND deleted_at IS NULL AND archived_at IS NULL
          AND milestone_key<>'SITE_ENTRY'
      UNION ALL
      SELECT 'CONSTRUCTION',id FROM public.project_construction_progress
        WHERE project_id=p_project_id AND deleted_at IS NULL
          AND status_override IS DISTINCT FROM 'disabled'
    ) active_items;
  SELECT coalesce(array_agg((item->>'kind')||':'||(item->>'id') ORDER BY item->>'kind',item->>'id'),'{}'::text[]),
    coalesce(jsonb_object_agg((item->>'kind')||':'||(item->>'id'),item->'expected_position'),'{}'::jsonb)
    INTO v_received,v_before FROM jsonb_array_elements(p_items) item;
  IF cardinality(v_expected)<>cardinality(v_received)
    OR cardinality(v_received)<>(SELECT count(DISTINCT item) FROM unnest(v_received) item)
    OR v_expected IS DISTINCT FROM v_received THEN
    RAISE EXCEPTION 'Project items changed; reload before sorting' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(jsonb_object_agg(pos.item_kind||':'||pos.item_id::text,pos.position),'{}'::jsonb)
    INTO v_current FROM public.project_work_item_positions pos
    WHERE pos.project_id=p_project_id
      AND (pos.item_kind||':'||pos.item_id::text)=ANY(v_expected);
  IF v_before IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'Project order changed; reload before sorting' USING ERRCODE='40001';
  END IF;
  UPDATE public.project_work_item_positions position_row
  SET position=ordered.ordinality*100,updated_at=now()
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS ordered(item,ordinality)
  WHERE position_row.project_id=p_project_id
    AND position_row.item_kind=ordered.item->>'kind'
    AND position_row.item_id=(ordered.item->>'id')::uuid;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated<>cardinality(v_expected) THEN
    RAISE EXCEPTION 'Project order rows missing' USING ERRCODE='40001';
  END IF;
END $$;

-- The original one-argument toolbox RPC cannot check a stale client read.
-- Its replacement also locks only the caller's own personal order rows.
REVOKE EXECUTE ON FUNCTION public.reorder_my_tool_links(uuid[]) FROM authenticated;
CREATE FUNCTION public.reorder_my_tool_links_if_current(p_ids uuid[],p_expected jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_member uuid := app_private.current_member_id(); v_visible uuid[]; v_current jsonb;
BEGIN
  IF v_member IS NULL OR NOT app_private.is_normal_toolbox_member() THEN
    RAISE EXCEPTION 'Active member required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Expected positions required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tool-order:'||v_member::text,0));
  SELECT coalesce(array_agg(link.id ORDER BY link.id),'{}'::uuid[]),
    coalesce(jsonb_object_agg(link.id::text,personal.position),'{}'::jsonb)
    INTO v_visible,v_current
  FROM public.tool_links link LEFT JOIN public.tool_link_personal_order personal
    ON personal.member_id=v_member AND personal.tool_link_id=link.id
  WHERE (link.scope='PERSONAL' AND link.owner_member_id=v_member)
    OR link.scope='GLOBAL'
    OR (link.scope='DEPARTMENT' AND (app_private.is_admin_member() OR EXISTS (
      SELECT 1 FROM public.member_work_groups membership
      WHERE membership.member_id=v_member AND membership.work_group_id=link.work_group_id
    )));
  IF p_ids IS NULL OR cardinality(p_ids)<>cardinality(v_visible)
    OR cardinality(p_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
    OR (SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) FROM unnest(p_ids) id) IS DISTINCT FROM v_visible
    OR p_expected IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'Tool visibility or order changed; reload before sorting' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.tool_link_personal_order(member_id,tool_link_id,position,updated_at)
  SELECT v_member,id,ordinality::integer,now() FROM unnest(p_ids) WITH ORDINALITY AS item(id,ordinality)
  ON CONFLICT (member_id,tool_link_id) DO UPDATE
    SET position=EXCLUDED.position,updated_at=now();
  DELETE FROM public.tool_link_personal_order
  WHERE member_id=v_member AND NOT(tool_link_id=ANY(p_ids));
END $$;
REVOKE ALL ON FUNCTION public.reorder_my_tool_links_if_current(uuid[],jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reorder_my_tool_links_if_current(uuid[],jsonb) TO authenticated;

NOTIFY pgrst,'reload schema';
