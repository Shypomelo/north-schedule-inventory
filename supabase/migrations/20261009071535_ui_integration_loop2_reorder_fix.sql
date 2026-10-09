-- Candidate verification caught PostgreSQL operator precedence in the JSON
-- key concatenation. Keep the complete validation and transactional update.
CREATE OR REPLACE FUNCTION public.reorder_project_work_items(p_project_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_expected text[]; v_received text[]; v_updated integer;
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
  SELECT coalesce(array_agg((item->>'kind')||':'||(item->>'id') ORDER BY item->>'kind',item->>'id'),'{}'::text[])
    INTO v_received FROM jsonb_array_elements(p_items) item;
  IF cardinality(v_expected)<>cardinality(v_received)
    OR cardinality(v_received)<>(SELECT count(DISTINCT item) FROM unnest(v_received) item)
    OR v_expected IS DISTINCT FROM v_received THEN
    RAISE EXCEPTION 'Project items changed; reload before sorting' USING ERRCODE='40001';
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

NOTIFY pgrst,'reload schema';
