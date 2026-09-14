CREATE TABLE public.material_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT material_groups_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX material_groups_normalized_name_key
    ON public.material_groups (lower(btrim(name)));

CREATE INDEX material_groups_active_sort_idx
    ON public.material_groups (is_active, sort_order, name);

CREATE INDEX material_groups_created_by_idx
    ON public.material_groups (created_by);

ALTER TABLE public.material_catalog_items
    ADD COLUMN group_id uuid REFERENCES public.material_groups(id) ON DELETE RESTRICT;

WITH legacy_groups AS (
    SELECT DISTINCT ON (lower(btrim(group_name)))
        lower(btrim(group_name)) AS normalized_name,
        btrim(group_name) AS name,
        created_by,
        created_at
    FROM public.material_catalog_items
    WHERE group_name IS NOT NULL
      AND btrim(group_name) <> ''
    ORDER BY lower(btrim(group_name)), created_at, id
), ordered_legacy_groups AS (
    SELECT
        name,
        created_by,
        created_at,
        row_number() OVER (ORDER BY normalized_name) * 10 AS sort_order
    FROM legacy_groups
)
INSERT INTO public.material_groups (name, sort_order, created_by, created_at, updated_at)
SELECT name, sort_order, created_by, created_at, created_at
FROM ordered_legacy_groups;

UPDATE public.material_catalog_items AS item
SET group_id = material_group.id
FROM public.material_groups AS material_group
WHERE item.group_id IS NULL
  AND item.group_name IS NOT NULL
  AND btrim(item.group_name) <> ''
  AND lower(btrim(item.group_name)) = lower(btrim(material_group.name));

CREATE INDEX material_catalog_items_group_sort_idx
    ON public.material_catalog_items (group_id, is_active, sort_order, name);

CREATE TRIGGER set_material_groups_updated_at
BEFORE UPDATE ON public.material_groups
FOR EACH ROW
EXECUTE FUNCTION app_private.set_material_updated_at();

CREATE TRIGGER protect_material_group_creator
BEFORE UPDATE OF created_by ON public.material_groups
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_material_creator();

CREATE OR REPLACE FUNCTION app_private.sync_material_catalog_group_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    IF NEW.group_id IS NULL THEN
        NEW.group_name := NULL;
    ELSE
        SELECT name
        INTO NEW.group_name
        FROM public.material_groups
        WHERE id = NEW.group_id;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER sync_material_catalog_group_name
BEFORE INSERT OR UPDATE OF group_id ON public.material_catalog_items
FOR EACH ROW
EXECUTE FUNCTION app_private.sync_material_catalog_group_name();

CREATE OR REPLACE FUNCTION app_private.cascade_material_group_legacy_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    UPDATE public.material_catalog_items
    SET group_name = NEW.name
    WHERE group_id = NEW.id;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER cascade_material_group_legacy_name
AFTER UPDATE OF name ON public.material_groups
FOR EACH ROW
WHEN (NEW.name IS DISTINCT FROM OLD.name)
EXECUTE FUNCTION app_private.cascade_material_group_legacy_name();

ALTER TABLE public.material_groups ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.material_groups FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.material_groups TO authenticated;

CREATE POLICY "Active members can view material groups"
ON public.material_groups FOR SELECT
TO authenticated
USING ((SELECT app_private.is_active_member()));

CREATE POLICY "Admin members can insert material groups"
ON public.material_groups FOR INSERT
TO authenticated
WITH CHECK (
    (SELECT app_private.is_admin_member())
    AND created_by = (SELECT app_private.current_member_id())
);

CREATE POLICY "Admin members can update material groups"
ON public.material_groups FOR UPDATE
TO authenticated
USING ((SELECT app_private.is_admin_member()))
WITH CHECK (
    (SELECT app_private.is_admin_member())
    AND created_by IS NOT NULL
);
