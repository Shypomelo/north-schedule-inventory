-- Candidate-only access verification. Every fixture and mutation is rolled back.
BEGIN;
SELECT set_config('test.toolbox_group', (SELECT id::text FROM public.work_groups WHERE key = 'ENGINEERING'), true);
SELECT set_config('test.toolbox_owner', (
  SELECT m.email FROM public.team_members m JOIN public.member_work_groups mg ON mg.member_id = m.id
  WHERE mg.work_group_id = current_setting('test.toolbox_group')::uuid AND lower(m.role) = 'engineer'
    AND m.is_active AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1
), true);
SELECT set_config('test.toolbox_peer', (
  SELECT m.email FROM public.team_members m JOIN public.member_work_groups mg ON mg.member_id = m.id
  WHERE mg.work_group_id = current_setting('test.toolbox_group')::uuid AND lower(m.role) = 'engineer'
    AND m.is_active AND m.deleted_at IS NULL AND m.email <> current_setting('test.toolbox_owner')
  ORDER BY m.id LIMIT 1
), true);
SELECT set_config('test.toolbox_outsider', (
  SELECT m.email FROM public.team_members m WHERE lower(m.role) = 'engineer'
    AND m.is_active AND m.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.member_work_groups mg WHERE mg.member_id = m.id
        AND mg.work_group_id = current_setting('test.toolbox_group')::uuid
    ) ORDER BY m.id LIMIT 1
), true);
SELECT set_config('test.toolbox_admin', (
  SELECT email FROM public.team_members WHERE lower(role) = 'admin' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1
), true);
SELECT set_config('test.toolbox_viewer', (
  SELECT email FROM public.team_members WHERE lower(role) = 'viewer' AND is_active AND deleted_at IS NULL ORDER BY id LIMIT 1
), true);
DO $$ BEGIN
  IF current_setting('test.toolbox_owner', true) IS NULL OR current_setting('test.toolbox_peer', true) IS NULL
    OR current_setting('test.toolbox_outsider', true) IS NULL OR current_setting('test.toolbox_admin', true) IS NULL
    OR current_setting('test.toolbox_viewer', true) IS NULL THEN RAISE EXCEPTION 'Missing Candidate role fixture'; END IF;
END $$;
INSERT INTO public.tool_links(name,url,category,scope,owner_member_id)
SELECT '__toolbox_rls_personal', 'https://example.com/personal', 'test', 'PERSONAL', id
FROM public.team_members WHERE email = current_setting('test.toolbox_owner');
INSERT INTO public.tool_links(name,url,category,scope,work_group_id)
VALUES ('__toolbox_rls_department','https://example.com/department','test','DEPARTMENT',current_setting('test.toolbox_group')::uuid);
INSERT INTO public.tool_links(name,url,category,scope)
VALUES ('__toolbox_rls_global','https://example.com/global','test','GLOBAL');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', jsonb_build_object('email',current_setting('test.toolbox_owner'),'role','authenticated')::text, true);
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.tool_links WHERE name LIKE '__toolbox_rls_%') = 3 THEN 1 ELSE 0 END AS owner_visibility;
INSERT INTO public.tool_links(name,url,category,scope,owner_member_id)
VALUES ('__toolbox_rls_owner_crud','https://example.com/owner','test','PERSONAL',app_private.current_member_id());
WITH changed AS (UPDATE public.tool_links SET description = 'updated' WHERE name = '__toolbox_rls_owner_crud' RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM changed) = 1 THEN 1 ELSE 0 END AS personal_update;
WITH removed AS (DELETE FROM public.tool_links WHERE name = '__toolbox_rls_owner_crud' RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM removed) = 1 THEN 1 ELSE 0 END AS personal_delete;
DO $$ DECLARE denied boolean := false; BEGIN
  BEGIN
    INSERT INTO public.tool_links(name,url,category,scope,work_group_id)
    VALUES ('__toolbox_rls_denied_department','https://example.com/denied','test','DEPARTMENT',current_setting('test.toolbox_group')::uuid);
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Engineer created department link'; END IF;
END $$;
DO $$ DECLARE denied boolean := false; BEGIN
  BEGIN
    INSERT INTO public.tool_links(name,url,category,scope)
    VALUES ('__toolbox_rls_denied_global','https://example.com/denied','test','GLOBAL');
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Engineer created global link'; END IF;
END $$;

SELECT set_config('request.jwt.claims', jsonb_build_object('email',current_setting('test.toolbox_peer'),'role','authenticated')::text, true);
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.tool_links WHERE name LIKE '__toolbox_rls_%') = 2 THEN 1 ELSE 0 END AS peer_visibility;
WITH changed AS (UPDATE public.tool_links SET description = 'forbidden' WHERE name = '__toolbox_rls_personal' RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM changed) = 0 THEN 1 ELSE 0 END AS personal_isolation_update;
WITH changed AS (UPDATE public.tool_links SET description = 'forbidden' WHERE name = '__toolbox_rls_department' RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM changed) = 0 THEN 1 ELSE 0 END AS department_admin_only_update;
WITH removed AS (DELETE FROM public.tool_links WHERE name IN ('__toolbox_rls_personal','__toolbox_rls_department','__toolbox_rls_global') RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM removed) = 0 THEN 1 ELSE 0 END AS peer_cannot_delete;
DO $$ DECLARE denied boolean := false; BEGIN
  BEGIN
    INSERT INTO public.tool_links(name,url,category,scope,owner_member_id)
    SELECT '__toolbox_rls_denied_personal','https://example.com/denied','test','PERSONAL',id
    FROM public.team_members WHERE email = current_setting('test.toolbox_owner');
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Peer created another member personal link'; END IF;
END $$;

SELECT set_config('request.jwt.claims', jsonb_build_object('email',current_setting('test.toolbox_outsider'),'role','authenticated')::text, true);
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.tool_links WHERE name LIKE '__toolbox_rls_%') = 1 THEN 1 ELSE 0 END AS nonmember_global_only;
SELECT set_config('request.jwt.claims', jsonb_build_object('email',current_setting('test.toolbox_viewer'),'role','authenticated')::text, true);
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.tool_links WHERE name = '__toolbox_rls_global') = 1 THEN 1 ELSE 0 END AS viewer_global_visibility;

SELECT set_config('request.jwt.claims', jsonb_build_object('email',current_setting('test.toolbox_admin'),'role','authenticated')::text, true);
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.tool_links WHERE name IN ('__toolbox_rls_department','__toolbox_rls_global')) = 2 THEN 1 ELSE 0 END AS admin_visibility;
INSERT INTO public.tool_links(name,url,category,scope,work_group_id)
VALUES ('__toolbox_rls_admin_department','https://example.com/admin','test','DEPARTMENT',current_setting('test.toolbox_group')::uuid);
INSERT INTO public.tool_links(name,url,category,scope)
VALUES ('__toolbox_rls_admin_global','https://example.com/admin-global','test','GLOBAL');
WITH changed AS (UPDATE public.tool_links SET description = 'admin updated' WHERE name IN ('__toolbox_rls_admin_department','__toolbox_rls_admin_global') RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM changed) = 2 THEN 1 ELSE 0 END AS admin_update;
WITH removed AS (DELETE FROM public.tool_links WHERE name IN ('__toolbox_rls_admin_department','__toolbox_rls_admin_global') RETURNING id)
SELECT 1 / CASE WHEN (SELECT count(*) FROM removed) = 2 THEN 1 ELSE 0 END AS admin_delete;
DO $$ DECLARE denied boolean := false; BEGIN
  BEGIN
    INSERT INTO public.tool_links(name,url,category,scope)
    VALUES ('__toolbox_rls_http_denied','http://example.com','test','GLOBAL');
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'HTTP URL passed validation'; END IF;
END $$;

RESET ROLE;
ROLLBACK;
SELECT count(*) AS candidate_fixture_residue FROM public.tool_links WHERE name LIKE '__toolbox_rls_%';
