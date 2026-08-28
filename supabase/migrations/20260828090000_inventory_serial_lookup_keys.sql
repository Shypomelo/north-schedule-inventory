-- Serial lookup keys for full/short serial identity search.
-- Keeps inventory_serials.serial_number unchanged.

CREATE OR REPLACE FUNCTION public.normalize_inventory_serial(p_serial text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $$
  SELECT upper(
    regexp_replace(
      btrim(translate(normalize(p_serial, NFKC), '－–—', '---')),
      '\s*-\s*',
      '-',
      'g'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.classify_inventory_serial_format(p_serial text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'short'
    WHEN public.normalize_inventory_serial(p_serial) ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN 'full'
    ELSE 'unknown'
  END;
$$;

CREATE OR REPLACE FUNCTION public.derive_inventory_serial_short_key(p_serial text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $$
  WITH normalized AS (
    SELECT public.normalize_inventory_serial(p_serial) AS value
  )
  SELECT CASE
    WHEN value ~ '^[A-Z0-9]{9}-[A-Z0-9]{2}$' THEN value
    WHEN value ~ '^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$'
      THEN split_part(value, '-', 2) || '-' || split_part(value, '-', 3)
    ELSE NULL
  END
  FROM normalized;
$$;

ALTER TABLE public.inventory_serials
ADD COLUMN IF NOT EXISTS normalized_full text
GENERATED ALWAYS AS (public.normalize_inventory_serial(serial_number)) STORED;

ALTER TABLE public.inventory_serials
ADD COLUMN IF NOT EXISTS short_key text
GENERATED ALWAYS AS (public.derive_inventory_serial_short_key(serial_number)) STORED;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.inventory_serials
    GROUP BY normalized_full
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'inventory_serials normalized_full collision detected; resolve manually before adding unique lookup index';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serials_normalized_full
ON public.inventory_serials(normalized_full);

CREATE INDEX IF NOT EXISTS idx_inventory_serials_short_key
ON public.inventory_serials(short_key)
WHERE short_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.lookup_inventory_serial(
  p_input text,
  p_item_id uuid DEFAULT NULL,
  p_allowed_statuses text[] DEFAULT NULL
)
RETURNS TABLE (
  result_type text,
  candidate_count integer,
  filtered_candidate_count integer,
  id uuid,
  item_id uuid,
  serial_number text,
  normalized_full text,
  short_key text,
  status text,
  is_allowed_candidate boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH input_value AS (
    SELECT
      public.normalize_inventory_serial(p_input) AS normalized_input,
      public.derive_inventory_serial_short_key(p_input) AS input_short_key,
      public.classify_inventory_serial_format(p_input) AS input_format
  ),
  exact_candidates AS (
    SELECT s.id, 'exact_full' AS match_kind
    FROM public.inventory_serials s
    CROSS JOIN input_value i
    WHERE s.normalized_full = i.normalized_input
  ),
  short_candidates AS (
    SELECT
      s.id,
      CASE
        WHEN i.input_format = 'full' THEN 'derived_short_key'
        ELSE 'short_key'
      END AS match_kind
    FROM public.inventory_serials s
    CROSS JOIN input_value i
    WHERE i.input_format IN ('full', 'short')
      AND i.input_short_key IS NOT NULL
      AND s.short_key = i.input_short_key
  ),
  identity_candidates AS (
    SELECT DISTINCT ON (candidate_id)
      candidate_id,
      match_kind
    FROM (
      SELECT id AS candidate_id, match_kind FROM exact_candidates
      UNION ALL
      SELECT id AS candidate_id, match_kind FROM short_candidates
    ) matches
    ORDER BY candidate_id, CASE match_kind WHEN 'exact_full' THEN 0 ELSE 1 END
  ),
  counts AS (
    SELECT
      count(*)::integer AS candidate_count,
      count(*) FILTER (
        WHERE (p_item_id IS NULL OR s.item_id = p_item_id)
          AND (p_allowed_statuses IS NULL OR s.status = ANY(p_allowed_statuses))
      )::integer AS filtered_candidate_count,
      (SELECT count(*)::integer FROM exact_candidates) AS exact_candidate_count,
      (SELECT input_format FROM input_value) AS input_format
    FROM identity_candidates c
    JOIN public.inventory_serials s ON s.id = c.candidate_id
  ),
  typed AS (
    SELECT CASE
      WHEN counts.candidate_count = 0 THEN 'no_match'
      WHEN counts.candidate_count > 1 THEN 'ambiguous'
      WHEN counts.filtered_candidate_count = 0 THEN 'filtered_out'
      WHEN counts.input_format = 'full' AND counts.exact_candidate_count = 0 THEN 'potential_same_identity'
      ELSE 'unique_match'
    END AS result_type,
    counts.*
    FROM counts
  )
  SELECT
    typed.result_type,
    typed.candidate_count,
    typed.filtered_candidate_count,
    s.id,
    s.item_id,
    s.serial_number,
    s.normalized_full,
    s.short_key,
    s.status,
    ((p_item_id IS NULL OR s.item_id = p_item_id)
      AND (p_allowed_statuses IS NULL OR s.status = ANY(p_allowed_statuses))) AS is_allowed_candidate
  FROM typed
  LEFT JOIN identity_candidates c ON typed.candidate_count > 0
  LEFT JOIN public.inventory_serials s ON s.id = c.candidate_id
  ORDER BY
    CASE WHEN c.match_kind = 'exact_full' THEN 0 ELSE 1 END,
    s.created_at,
    s.id;
$$;

REVOKE EXECUTE ON FUNCTION public.lookup_inventory_serial(text, uuid, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lookup_inventory_serial(text, uuid, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.lookup_inventory_serial(text, uuid, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
