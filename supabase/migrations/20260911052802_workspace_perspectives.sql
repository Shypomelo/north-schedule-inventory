-- Candidate only. Dashboard perspectives are presentation preferences, not data permissions.
-- Membership-row existence must remain observable even when the referenced group is inactive.
-- Group selectability is still enforced by work_groups_active_read; mutation stays ADMIN-only.
ALTER POLICY member_work_groups_active_read ON public.member_work_groups
USING ((SELECT app_private.is_active_member()));

CREATE TABLE public.dashboard_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text NOT NULL CHECK (btrim(name) <> ''), is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.dashboard_views (key,name,sort_order) VALUES
 ('ENGINEERING','工程視角',10),('PROJECT_MANAGEMENT','專案管理視角',20),('DESIGN','設計視角',30);
CREATE TABLE public.member_dashboard_views (
 member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
 dashboard_view_id uuid NOT NULL REFERENCES public.dashboard_views(id) ON DELETE CASCADE,
 is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(member_id,dashboard_view_id)
);
CREATE UNIQUE INDEX member_dashboard_views_one_default ON public.member_dashboard_views(member_id) WHERE is_default;
CREATE INDEX member_dashboard_views_view_member ON public.member_dashboard_views(dashboard_view_id,member_id);
ALTER TABLE public.dashboard_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_dashboard_views ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.dashboard_views,public.member_dashboard_views TO authenticated;
GRANT INSERT,UPDATE,DELETE ON public.member_dashboard_views TO authenticated;
CREATE POLICY dashboard_views_read ON public.dashboard_views FOR SELECT TO authenticated
 USING ((SELECT app_private.is_active_member()));
CREATE POLICY member_dashboard_views_read ON public.member_dashboard_views FOR SELECT TO authenticated
 USING ((SELECT app_private.is_active_member()) AND (member_id=(SELECT app_private.current_member_id()) OR (SELECT app_private.is_admin_member())));
CREATE POLICY member_dashboard_views_admin ON public.member_dashboard_views FOR ALL TO authenticated
 USING ((SELECT app_private.is_admin_member())) WITH CHECK ((SELECT app_private.is_admin_member()));

CREATE FUNCTION public.set_member_dashboard_views(p_member_id uuid,p_view_ids uuid[],p_default_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NOT coalesce(app_private.is_admin_member(),false) THEN RAISE EXCEPTION 'Only admin members may assign dashboard views' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dashboard_views:'||p_member_id::text,0));
 IF p_view_ids IS NULL OR EXISTS (SELECT 1 FROM unnest(p_view_ids) AS requested(view_id) WHERE requested.view_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.dashboard_views v WHERE v.id=requested.view_id AND v.is_active))
 OR (p_default_id IS NOT NULL AND NOT p_default_id=ANY(p_view_ids)) THEN RAISE EXCEPTION 'Invalid dashboard view assignment' USING ERRCODE='23514'; END IF;
 DELETE FROM public.member_dashboard_views WHERE member_id=p_member_id;
 INSERT INTO public.member_dashboard_views(member_id,dashboard_view_id,is_default)
 SELECT p_member_id,id,coalesce(id=p_default_id,false) FROM (SELECT DISTINCT unnest(p_view_ids) id) ids;
END $$;
REVOKE ALL ON FUNCTION public.set_member_dashboard_views(uuid,uuid[],uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_member_dashboard_views(uuid,uuid[],uuid) TO authenticated;

-- Atomic owner-only replacement. Removed zones retain their items and are archived,
-- but require explicit destination to avoid hiding unfinished work.
CREATE FUNCTION public.configure_my_work_zones(p_zones jsonb,p_move_to uuid DEFAULT NULL)
RETURNS SETOF public.work_zones LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE owner_id uuid:=app_private.current_member_id(); z jsonb; zone_id uuid; zone_ids uuid[]:='{}'; n integer:=0;
BEGIN
 IF owner_id IS NULL THEN RAISE EXCEPTION 'Active member required' USING ERRCODE='42501'; END IF;
 IF p_zones IS NULL OR jsonb_typeof(p_zones)<>'array' THEN RAISE EXCEPTION 'Configure exactly two or three zones' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(p_zones) NOT IN (2,3) THEN RAISE EXCEPTION 'Configure exactly two or three zones' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text,0));
 FOR z IN SELECT value FROM jsonb_array_elements(p_zones) LOOP
  IF coalesce(btrim(z->>'name'),'')='' THEN RAISE EXCEPTION 'Zone name required' USING ERRCODE='23514'; END IF;
  zone_id:=coalesce(nullif(z->>'id','')::uuid,gen_random_uuid());
  IF zone_id=ANY(zone_ids) THEN RAISE EXCEPTION 'Duplicate zone' USING ERRCODE='23514'; END IF;
  IF nullif(z->>'id','') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.work_zones WHERE id=zone_id AND owner_member_id=owner_id) THEN RAISE EXCEPTION 'Zone not owned' USING ERRCODE='42501'; END IF;
  zone_ids:=array_append(zone_ids,zone_id);
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.work_items WHERE owner_member_id=owner_id AND NOT work_zone_id=ANY(zone_ids)) THEN
  IF p_move_to IS NULL OR NOT p_move_to=ANY(zone_ids) THEN RAISE EXCEPTION 'Choose a retained zone for existing items' USING ERRCODE='23514'; END IF;
 END IF;
 UPDATE public.work_zones SET is_active=false,updated_at=now() WHERE owner_member_id=owner_id;
 FOR z IN SELECT value FROM jsonb_array_elements(p_zones) LOOP
  n:=n+1;
  INSERT INTO public.work_zones(id,owner_member_id,name,sort_order,is_active)
  VALUES(zone_ids[n],owner_id,btrim(z->>'name'),n,true)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,is_active=true,updated_at=now();
 END LOOP;
 UPDATE public.work_items SET work_zone_id=p_move_to,updated_at=now()
 WHERE owner_member_id=owner_id AND NOT work_zone_id=ANY(zone_ids);
 RETURN QUERY SELECT * FROM public.work_zones WHERE owner_member_id=owner_id AND is_active ORDER BY sort_order;
END $$;
REVOKE ALL ON FUNCTION public.configure_my_work_zones(jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.configure_my_work_zones(jsonb,uuid) TO authenticated;
