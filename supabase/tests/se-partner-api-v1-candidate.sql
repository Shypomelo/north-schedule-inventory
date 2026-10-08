-- Run only on Candidate fssogssryeunkjkdgewx. Every fixture is rolled back.
BEGIN;
SELECT set_config('test.se_project', (SELECT id::text FROM public.projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1), true);
SELECT set_config('test.se_other_project', (SELECT id::text FROM public.projects WHERE deleted_at IS NULL ORDER BY id OFFSET 1 LIMIT 1), true);
SELECT set_config('test.se_model', (SELECT code FROM public.inventory_items WHERE is_active ORDER BY id LIMIT 1), true);
SELECT set_config('test.se_item', (SELECT id::text FROM public.inventory_items WHERE is_active ORDER BY id LIMIT 1), true);
SELECT set_config('test.se_source', gen_random_uuid()::text, true);
SELECT set_config('test.se_other_source', gen_random_uuid()::text, true);
SELECT set_config('test.se_wrong_model_source', gen_random_uuid()::text, true);
SELECT set_config('test.se_batch', gen_random_uuid()::text, true);
SELECT set_config('test.se_material', gen_random_uuid()::text, true);
SELECT set_config('test.se_site_material', gen_random_uuid()::text, true);
SELECT set_config('test.se_admin_email', (SELECT email FROM public.team_members WHERE lower(role)='admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1), true);
SELECT set_config('test.se_viewer_email', (SELECT email FROM public.team_members WHERE lower(role)='viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1), true);
INSERT INTO public.se_supply_records(id,project_id,inventory_item_id,new_model,quantity,unit,receiving_only)
VALUES (current_setting('test.se_source')::uuid,current_setting('test.se_project')::uuid,
 current_setting('test.se_item')::uuid,current_setting('test.se_model'),5,'台',true),
 (current_setting('test.se_other_source')::uuid,current_setting('test.se_other_project')::uuid,
 current_setting('test.se_item')::uuid,current_setting('test.se_model'),5,'台',true),
 (current_setting('test.se_wrong_model_source')::uuid,current_setting('test.se_project')::uuid,
 NULL,'SE_TEST_WRONG_MODEL',5,'台',true);
INSERT INTO public.project_material_batches(id,project_id,batch_name,created_by)
VALUES (current_setting('test.se_batch')::uuid,current_setting('test.se_project')::uuid,
  '[SE TEST] pending batch',
  (SELECT id FROM public.team_members WHERE email=current_setting('test.se_admin_email')));
INSERT INTO public.project_materials(id,project_id,batch_id,item_name,specification,quantity,unit,
  created_by,inventory_item_id,delivery_destination)
VALUES (current_setting('test.se_material')::uuid,current_setting('test.se_project')::uuid,
  current_setting('test.se_batch')::uuid,'[SE TEST] office',current_setting('test.se_model'),4,'台',
  (SELECT id FROM public.team_members WHERE email=current_setting('test.se_admin_email')),
  current_setting('test.se_item')::uuid,'OFFICE'),
 (current_setting('test.se_site_material')::uuid,current_setting('test.se_project')::uuid,
  current_setting('test.se_batch')::uuid,'[SE TEST] site',current_setting('test.se_model'),4,'台',
  (SELECT id FROM public.team_members WHERE email=current_setting('test.se_admin_email')),
  current_setting('test.se_item')::uuid,'SITE');
CREATE FUNCTION pg_temp.se_test_backdate(p_run_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.se_api_sync_runs SET requested_at = clock_timestamp() - interval '2 hours'
  WHERE run_id = p_run_id;
$$;
SELECT set_config('request.jwt.claims', jsonb_build_object('email',current_setting('test.se_admin_email'),'role','authenticated')::text, true);
SET LOCAL ROLE authenticated;

DO $test$
DECLARE
  v_project uuid := current_setting('test.se_project')::uuid;
  v_other_project uuid := current_setting('test.se_other_project')::uuid;
  v_model text := current_setting('test.se_model');
  v_run record;
  v_page record;
  v_payload jsonb;
  v_item uuid;
  v_second uuid;
  v_third uuid;
  v_link uuid;
  v_watermark timestamptz;
  v_item_count integer;
  v_viewer text := current_setting('test.se_viewer_email');
BEGIN
  PERFORM public.se_set_case_scope_rule('SE_TEST_NORTH','NORTH',v_project);
  PERFORM public.se_set_case_scope_rule('SE_TEST_OUTSIDE','NOT_NORTH',NULL);
  PERFORM public.se_set_case_scope_rule('SE_TEST_OTHER_NORTH','NORTH',v_other_project);
  SELECT * INTO v_run FROM public.se_sync_reserve('MANUAL',NULL,1);
  IF v_run.since_at IS NOT NULL THEN RAISE EXCEPTION 'unexpected initial watermark'; END IF;
  BEGIN PERFORM public.se_sync_reserve('MANUAL',NULL,1);
    RAISE EXCEPTION 'hourly quota accepted second run';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_HOURLY_QUOTA%' THEN RAISE; END IF;
  END;
  SELECT * INTO v_page FROM public.se_sync_reserve('MANUAL',v_run.run_id,2);
  IF v_page.run_id <> v_run.run_id THEN RAISE EXCEPTION 'page identity changed'; END IF;
  BEGIN PERFORM public.se_sync_reserve('MANUAL',v_run.run_id,3);
    RAISE EXCEPTION 'manual quota accepted third request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_MODE_QUOTA%' THEN RAISE; END IF;
  END;

  v_payload := jsonb_build_object('orders',jsonb_build_array(
    jsonb_build_object('orderNo','SE_TEST_SPLIT','caseNumbers',jsonb_build_array('SE_TEST_NORTH','SE_TEST_NORTH-2'),
      'siteName','Split','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1),jsonb_build_object('name',v_model,'qty',2)),
      'status','shipped','statusLabel','已出貨','carrier','大榮','trackingNos',jsonb_build_array('SE_TEST_TRACK_1','SE_TEST_TRACK_2'),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_OUTSIDE_ORDER','caseNumbers',jsonb_build_array('SE_TEST_OUTSIDE'),
      'siteName','Outside','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1)),
      'status','pending','statusLabel','待處理','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_EMPTY_CASE','caseNumbers',jsonb_build_array(),
      'siteName','Unknown','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1)),
      'status','partner_review','statusLabel','待人工確認','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_MIXED','caseNumbers',jsonb_build_array('SE_TEST_NORTH','SE_TEST_OUTSIDE'),
      'siteName','Mixed','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1)),
      'status','pending','statusLabel','待處理','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_NORTH_ORDER','caseNumbers',jsonb_build_array('SE_TEST_NORTH'),
      'siteName','North','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',3)),
      'status','shipped','statusLabel','已出貨','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_SECOND_ORDER','caseNumbers',jsonb_build_array('SE_TEST_NORTH'),
      'siteName','North','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',3)),
      'status','shipped','statusLabel','已出貨','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_THIRD_ORDER','caseNumbers',jsonb_build_array('SE_TEST_NORTH'),
      'siteName','North','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1)),
      'status','shipped','statusLabel','已出貨','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_CANCELLED','caseNumbers',jsonb_build_array('SE_TEST_NORTH'),
      'siteName','North','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1)),
      'status','cancelled','statusLabel','已取消','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt',''),
    jsonb_build_object('orderNo','SE_TEST_MULTI_NORTH','caseNumbers',jsonb_build_array('SE_TEST_NORTH','SE_TEST_OTHER_NORTH'),
      'siteName','Multiple','items',jsonb_build_array(jsonb_build_object('name',v_model,'qty',1)),
      'status','shipped','statusLabel','已出貨','carrier','','trackingNos',jsonb_build_array(),
      'createdAt','2026-10-02','updatedAt','')),
    'removed',jsonb_build_array(jsonb_build_object('orderNo','SE_TEST_REMOVED',
      'removedAt','2026-10-03T02:10:00.000Z','reason','deleted')));
  PERFORM public.se_sync_apply(v_run.run_id,v_payload,2);
  SELECT watermark_at INTO v_watermark FROM public.se_api_sync_runs WHERE run_id=v_run.run_id AND page_no=1;
  IF v_watermark IS NULL THEN RAISE EXCEPTION 'watermark absent after complete pagination'; END IF;
  IF (SELECT scope_state FROM public.se_orders WHERE order_no='SE_TEST_SPLIT') <> 'UNREVIEWED'
    OR (SELECT scope_state FROM public.se_orders WHERE order_no='SE_TEST_MIXED') <> 'UNREVIEWED'
    OR (SELECT scope_state FROM public.se_orders WHERE order_no='SE_TEST_EMPTY_CASE') <> 'UNREVIEWED'
    THEN RAISE EXCEPTION 'uncertain order was classified'; END IF;
  IF (SELECT scope_state FROM public.se_orders WHERE order_no='SE_TEST_OUTSIDE_ORDER') <> 'NOT_NORTH'
    OR (SELECT site_name <> '' OR raw_items <> '[]'::jsonb OR cardinality(tracking_nos) <> 0
      FROM public.se_orders WHERE order_no='SE_TEST_OUTSIDE_ORDER')
    THEN RAISE EXCEPTION 'outside data retained'; END IF;
  IF (SELECT scope_state FROM public.se_orders WHERE order_no='SE_TEST_MULTI_NORTH') <> 'NORTH'
    OR (SELECT project_id IS NOT NULL FROM public.se_orders WHERE order_no='SE_TEST_MULTI_NORTH')
    THEN RAISE EXCEPTION 'multi project collapsed'; END IF;
  IF (SELECT jsonb_array_length(raw_items) FROM public.se_orders WHERE order_no='SE_TEST_SPLIT') <> 2
    OR (SELECT count(*) FROM public.se_order_items WHERE order_no='SE_TEST_SPLIT') <> 1
    OR (SELECT quantity FROM public.se_order_items WHERE order_no='SE_TEST_SPLIT') <> 3
    THEN RAISE EXCEPTION 'duplicate raw item rows lost'; END IF;
  IF (SELECT removed_at IS NULL FROM public.se_orders WHERE order_no='SE_TEST_REMOVED')
    OR EXISTS (SELECT 1 FROM public.se_order_item_serials) THEN RAISE EXCEPTION 'removed or SN mismatch'; END IF;
  BEGIN PERFORM public.se_confirm_order_scope('SE_TEST_SPLIT','NORTH',v_project);
    RAISE EXCEPTION 'split case inherited without rule';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_MULTI_CASE_REVIEW_REQUIRED%' THEN RAISE; END IF;
  END;
  PERFORM public.se_set_case_scope_rule('SE_TEST_NORTH-2','NORTH',v_project);
  PERFORM public.se_confirm_order_scope('SE_TEST_SPLIT','NORTH',v_project);

  SELECT id INTO v_item FROM public.se_order_items WHERE order_no='SE_TEST_NORTH_ORDER';
  SELECT id INTO v_second FROM public.se_order_items WHERE order_no='SE_TEST_SECOND_ORDER';
  SELECT id INTO v_third FROM public.se_order_items WHERE order_no='SE_TEST_THIRD_ORDER';
  BEGIN PERFORM public.se_link_order_item(v_item,'SE_SUPPLY',current_setting('test.se_other_source')::uuid,1);
    RAISE EXCEPTION 'project conflict accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_LINK_PROJECT_CONFLICT%' THEN RAISE; END IF;
  END;
  BEGIN PERFORM public.se_link_order_item(v_item,'SE_SUPPLY',current_setting('test.se_wrong_model_source')::uuid,1);
    RAISE EXCEPTION 'model conflict accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_LINK_SOURCE_CONFLICT%' THEN RAISE; END IF;
  END;
  SELECT public.se_link_order_item(v_item,'SE_SUPPLY',current_setting('test.se_source')::uuid,2) INTO v_link;
  BEGIN PERFORM public.se_link_order_item(v_item,'SE_SUPPLY',current_setting('test.se_source')::uuid,2);
    RAISE EXCEPTION 'duplicate link accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_LINK_CAPACITY%' THEN RAISE; END IF;
  END;
  PERFORM public.se_link_order_item(v_second,'SE_SUPPLY',current_setting('test.se_source')::uuid,3);
  BEGIN PERFORM public.se_link_order_item(v_third,'SE_SUPPLY',current_setting('test.se_source')::uuid,1);
    RAISE EXCEPTION 'source over-capacity accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_LINK_CAPACITY%' AND SQLERRM NOT LIKE '%SE_LINK_PENDING_CAPACITY%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.se_order_item_links WHERE source_id=current_setting('test.se_source')::uuid AND cancelled_at IS NULL) <> 2
    THEN RAISE EXCEPTION 'many orders one pending link count wrong'; END IF;
  PERFORM public.se_unlink_order_item(v_link);
  IF (SELECT count(*) FROM public.se_order_item_links WHERE source_id=current_setting('test.se_source')::uuid AND cancelled_at IS NULL) <> 1
    THEN RAISE EXCEPTION 'unlink failed'; END IF;
  PERFORM public.se_link_order_item(v_item,'PROJECT_MATERIAL',current_setting('test.se_material')::uuid,1);
  BEGIN PERFORM public.se_link_order_item(v_item,'PROJECT_MATERIAL',current_setting('test.se_site_material')::uuid,1);
    RAISE EXCEPTION 'SITE material linked as pending';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_LINK_NOT_PENDING%' THEN RAISE; END IF;
  END;
  BEGIN PERFORM public.se_link_order_item((SELECT id FROM public.se_order_items WHERE order_no='SE_TEST_CANCELLED'),
      'SE_SUPPLY',current_setting('test.se_source')::uuid,1);
    RAISE EXCEPTION 'cancelled order linked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_LINK_ORDER_INACTIVE%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('email',v_viewer,'role','authenticated')::text,true);
  IF NOT EXISTS (SELECT 1 FROM public.se_orders WHERE order_no='SE_TEST_NORTH_ORDER')
    OR NOT EXISTS (SELECT 1 FROM public.se_order_items WHERE order_no='SE_TEST_NORTH_ORDER')
    OR NOT EXISTS (SELECT 1 FROM public.se_order_item_links WHERE source_id=current_setting('test.se_source')::uuid)
    OR EXISTS (SELECT 1 FROM public.se_orders WHERE order_no IN
      ('SE_TEST_OUTSIDE_ORDER','SE_TEST_MIXED','SE_TEST_EMPTY_CASE'))
    OR EXISTS (SELECT 1 FROM public.se_order_items WHERE order_no IN
      ('SE_TEST_OUTSIDE_ORDER','SE_TEST_MIXED','SE_TEST_EMPTY_CASE'))
    THEN RAISE EXCEPTION 'viewer or child RLS mismatch'; END IF;
  BEGIN PERFORM public.se_confirm_order_scope('SE_TEST_NORTH_ORDER','NOT_NORTH',NULL);
    RAISE EXCEPTION 'viewer changed scope';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%SE_ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('email','nobody@example.invalid','role','authenticated')::text,true);
  IF EXISTS (SELECT 1 FROM public.se_orders) OR EXISTS (SELECT 1 FROM public.se_order_items)
    OR EXISTS (SELECT 1 FROM public.se_order_item_links) THEN RAISE EXCEPTION 'inactive user RLS leaked'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('email',current_setting('test.se_admin_email'),'role','authenticated')::text,true);

  -- Backdate within the rollback-only fixture so another run can test failed pagination.
  PERFORM pg_temp.se_test_backdate(v_run.run_id);
  SELECT * INTO v_run FROM public.se_sync_reserve('SCHEDULED',NULL,1);
  SELECT * INTO v_page FROM public.se_sync_reserve('SCHEDULED',v_run.run_id,2);
  PERFORM public.se_sync_fail(v_run.run_id,'HTTP_500');
  IF (SELECT max(watermark_at) FROM public.se_api_sync_runs WHERE state='APPLIED') IS DISTINCT FROM v_watermark
    THEN RAISE EXCEPTION 'failed pagination advanced watermark'; END IF;
  PERFORM pg_temp.se_test_backdate(v_run.run_id);
  SELECT * INTO v_run FROM public.se_sync_reserve('SCHEDULED',NULL,1);
  IF v_run.since_at IS DISTINCT FROM v_watermark THEN RAISE EXCEPTION 'incremental since incorrect'; END IF;
  SELECT count(*) INTO v_item_count FROM public.se_order_items;
  PERFORM public.se_sync_apply(v_run.run_id,v_payload,1);
  IF (SELECT count(*) FROM public.se_order_items) <> v_item_count THEN RAISE EXCEPTION 'repeat sync duplicated items'; END IF;
END $test$;

ROLLBACK;
SELECT 'PASS' AS result,
  (SELECT count(*) FROM public.se_orders WHERE order_no LIKE 'SE_TEST_%') AS order_cleanup,
  (SELECT count(*) FROM public.se_case_scope_rules WHERE case_number LIKE 'SE_TEST_%') AS rule_cleanup,
  (SELECT count(*) FROM public.se_order_item_links l JOIN public.se_order_items i ON i.id = l.item_id
    WHERE i.order_no LIKE 'SE_TEST_%') AS link_cleanup;
