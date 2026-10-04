-- Toolbox links use the existing member and work-group identity model.
CREATE TABLE public.tool_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  url text NOT NULL CHECK (url ~* '^https://[^[:space:]]+$'),
  category text NOT NULL CHECK (btrim(category) <> ''),
  description text,
  icon_key text,
  sort_order integer NOT NULL DEFAULT 0,
  scope text NOT NULL CHECK (scope IN ('PERSONAL', 'DEPARTMENT', 'GLOBAL')),
  owner_member_id uuid REFERENCES public.team_members(id) ON DELETE CASCADE,
  work_group_id uuid REFERENCES public.work_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_links_scope_owner CHECK (
    (scope = 'PERSONAL' AND owner_member_id IS NOT NULL AND work_group_id IS NULL) OR
    (scope = 'DEPARTMENT' AND owner_member_id IS NULL AND work_group_id IS NOT NULL) OR
    (scope = 'GLOBAL' AND owner_member_id IS NULL AND work_group_id IS NULL)
  )
);
CREATE INDEX tool_links_scope_order_idx ON public.tool_links(scope, sort_order, name);
CREATE INDEX tool_links_owner_idx ON public.tool_links(owner_member_id) WHERE scope = 'PERSONAL';
CREATE INDEX tool_links_group_idx ON public.tool_links(work_group_id) WHERE scope = 'DEPARTMENT';

-- A future restricted role must not inherit normal Toolbox access.
CREATE FUNCTION app_private.is_normal_toolbox_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members m
    WHERE m.id = app_private.current_member_id()
      AND m.is_active AND m.deleted_at IS NULL
      AND lower(m.role) IN ('admin', 'engineer', 'viewer')
  );
$$;
REVOKE ALL ON FUNCTION app_private.is_normal_toolbox_member() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.is_normal_toolbox_member() TO authenticated;

ALTER TABLE public.tool_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tool_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tool_links TO authenticated;
CREATE POLICY tool_links_read ON public.tool_links FOR SELECT TO authenticated USING (
  (SELECT app_private.is_normal_toolbox_member()) AND (
    (scope = 'PERSONAL' AND owner_member_id = (SELECT app_private.current_member_id())) OR
    (scope = 'DEPARTMENT' AND (
      (SELECT app_private.is_admin_member()) OR EXISTS (
        SELECT 1 FROM public.member_work_groups mg
        WHERE mg.member_id = (SELECT app_private.current_member_id()) AND mg.work_group_id = tool_links.work_group_id
      )
    )) OR scope = 'GLOBAL'
  )
);
CREATE POLICY tool_links_insert ON public.tool_links FOR INSERT TO authenticated WITH CHECK (
  (SELECT app_private.is_normal_toolbox_member()) AND (
    (scope = 'PERSONAL' AND owner_member_id = (SELECT app_private.current_member_id())) OR
    (scope IN ('DEPARTMENT', 'GLOBAL') AND (SELECT app_private.is_admin_member()))
  )
);
CREATE POLICY tool_links_update ON public.tool_links FOR UPDATE TO authenticated
USING ((SELECT app_private.is_normal_toolbox_member()) AND (
  (scope = 'PERSONAL' AND owner_member_id = (SELECT app_private.current_member_id())) OR
  (scope IN ('DEPARTMENT', 'GLOBAL') AND (SELECT app_private.is_admin_member()))
))
WITH CHECK ((SELECT app_private.is_normal_toolbox_member()) AND (
  (scope = 'PERSONAL' AND owner_member_id = (SELECT app_private.current_member_id())) OR
  (scope IN ('DEPARTMENT', 'GLOBAL') AND (SELECT app_private.is_admin_member()))
));
CREATE POLICY tool_links_delete ON public.tool_links FOR DELETE TO authenticated USING (
  (SELECT app_private.is_normal_toolbox_member()) AND (
    (scope = 'PERSONAL' AND owner_member_id = (SELECT app_private.current_member_id())) OR
    (scope IN ('DEPARTMENT', 'GLOBAL') AND (SELECT app_private.is_admin_member()))
  )
);
