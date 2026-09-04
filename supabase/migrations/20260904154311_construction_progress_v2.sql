ALTER TABLE public.project_construction_progress
    ADD COLUMN planned_end_date text,
    ADD COLUMN is_completed boolean NOT NULL DEFAULT false,
    ADD COLUMN actual_completed_date text,
    ADD COLUMN work_name text,
    ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE public.contractors
    ADD COLUMN work_capabilities text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.contractors.contractor_type IS
    'Primary contractor category used for grouping, sorting, labels, and reporting.';
COMMENT ON COLUMN public.contractors.work_capabilities IS
    'Technical work types this contractor can perform; used for assignment filtering.';

-- Production contractor_type values are all non-null and covered by the
-- existing contractors_contractor_type_check constraint. Preserve that known
-- capability without inferring any additional business capability.
UPDATE public.contractors
SET work_capabilities = ARRAY[contractor_type];

ALTER TABLE public.contractors
    ADD CONSTRAINT contractors_work_capabilities_allowed_check
    CHECK (
        work_capabilities <@ ARRAY[
            'racking',
            'electrical',
            'steel',
            'roof_cover',
            'civil',
            'other'
        ]::text[]
        AND array_position(work_capabilities, NULL) IS NULL
    ),
    ADD CONSTRAINT contractors_work_capabilities_nonempty_check
    CHECK (cardinality(work_capabilities) > 0),
    ADD CONSTRAINT contractors_primary_category_capability_check
    CHECK (contractor_type = ANY(work_capabilities));

-- Keep the strict final contract while remaining compatible with the old
-- Production client, which does not send work_capabilities yet. PostgreSQL
-- runs this BEFORE trigger before validating CHECK constraints on the final row.
CREATE OR REPLACE FUNCTION app_private.normalize_contractor_work_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
    IF NEW.work_capabilities IS NULL
       OR cardinality(NEW.work_capabilities) = 0 THEN
        NEW.work_capabilities := ARRAY[NEW.contractor_type];
    ELSIF NOT (NEW.contractor_type = ANY(NEW.work_capabilities)) THEN
        NEW.work_capabilities := array_append(
            NEW.work_capabilities,
            NEW.contractor_type
        );
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.normalize_contractor_work_capabilities() FROM PUBLIC;

CREATE TRIGGER normalize_contractor_work_capabilities
BEFORE INSERT OR UPDATE ON public.contractors
FOR EACH ROW
EXECUTE FUNCTION app_private.normalize_contractor_work_capabilities();

COMMENT ON COLUMN public.project_construction_progress.completed_date IS
    'Legacy mixed-semantics date retained for compatibility. New features must use planned_end_date and actual_completed_date.';
COMMENT ON COLUMN public.project_construction_progress.planned_end_date IS
    'Planned construction work item completion date (YYYY-MM-DD).';
COMMENT ON COLUMN public.project_construction_progress.is_completed IS
    'Explicit completion flag; must agree with actual_completed_date.';
COMMENT ON COLUMN public.project_construction_progress.actual_completed_date IS
    'Actual construction work item completion date (YYYY-MM-DD).';
COMMENT ON COLUMN public.project_construction_progress.work_name IS
    'Project-specific work item label, primarily for work_type = other.';
COMMENT ON COLUMN public.project_construction_progress.sort_order IS
    'Project-specific display order. It does not imply construction status.';

-- Backfill only the new display-order field. Do not infer completion from the
-- legacy completed_date column or copy legacy date values into V2 fields.
UPDATE public.project_construction_progress
SET sort_order = CASE work_type
    WHEN 'racking' THEN 10
    WHEN 'electrical' THEN 20
    WHEN 'steel' THEN 30
    WHEN 'roof_cover' THEN 40
    WHEN 'civil' THEN 50
    WHEN 'other' THEN 60
END;

ALTER TABLE public.project_construction_progress
    ADD CONSTRAINT project_construction_progress_completion_consistent_check
    CHECK (
        (is_completed = true AND actual_completed_date IS NOT NULL)
        OR
        (is_completed = false AND actual_completed_date IS NULL)
    ),
    ADD CONSTRAINT project_construction_progress_sort_order_nonnegative_check
    CHECK (sort_order >= 0);

DROP INDEX IF EXISTS public.idx_project_construction_progress_active_project_work_type;

CREATE UNIQUE INDEX idx_project_construction_progress_active_fixed_work_type
    ON public.project_construction_progress (project_id, work_type)
    WHERE deleted_at IS NULL
      AND work_type IN ('racking', 'electrical', 'steel', 'roof_cover', 'civil');

CREATE INDEX idx_project_construction_progress_active_project_sort_order
    ON public.project_construction_progress (project_id, sort_order)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION app_private.set_project_construction_progress_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.set_project_construction_progress_updated_at() FROM PUBLIC;

CREATE TRIGGER set_project_construction_progress_updated_at
BEFORE UPDATE ON public.project_construction_progress
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_construction_progress_updated_at();
