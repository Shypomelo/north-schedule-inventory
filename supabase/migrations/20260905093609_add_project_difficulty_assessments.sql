CREATE TABLE public.project_difficulty_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL
    REFERENCES public.projects(id) ON DELETE CASCADE,
  assessment_type text NOT NULL,
  overall_difficulty smallint NOT NULL,
  owner_communication_difficulty smallint NOT NULL,
  site_construction_difficulty smallint NOT NULL,
  site_coordination_difficulty smallint NOT NULL,
  evaluator_user_id uuid NOT NULL
    REFERENCES public.team_members(id),
  evaluator_name text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_difficulty_assessments_type_check
    CHECK (assessment_type IN ('PRE_ESTIMATE', 'POST_EXECUTION')),
  CONSTRAINT project_difficulty_assessments_overall_check
    CHECK (overall_difficulty BETWEEN 1 AND 5),
  CONSTRAINT project_difficulty_assessments_owner_communication_check
    CHECK (owner_communication_difficulty BETWEEN 1 AND 5),
  CONSTRAINT project_difficulty_assessments_site_construction_check
    CHECK (site_construction_difficulty BETWEEN 1 AND 5),
  CONSTRAINT project_difficulty_assessments_site_coordination_check
    CHECK (site_coordination_difficulty BETWEEN 1 AND 5),
  CONSTRAINT project_difficulty_assessments_evaluator_name_not_blank
    CHECK (btrim(evaluator_name) <> ''),
  CONSTRAINT project_difficulty_assessments_project_type_unique
    UNIQUE (project_id, assessment_type)
);

CREATE INDEX project_difficulty_assessments_project_id_idx
  ON public.project_difficulty_assessments (project_id);

CREATE TRIGGER set_project_difficulty_assessments_updated_at
BEFORE UPDATE ON public.project_difficulty_assessments
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_workflow_v2_updated_at();

CREATE FUNCTION app_private.set_project_difficulty_assessment_evaluator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  matching_member_ids uuid[];
  matching_member_names text[];
BEGIN
  SELECT array_agg(member.id), array_agg(member.name)
  INTO matching_member_ids, matching_member_names
  FROM public.team_members AS member
  WHERE lower(member.email) = lower(auth.jwt() ->> 'email')
    AND member.is_active = true
    AND member.deleted_at IS NULL;

  IF coalesce(cardinality(matching_member_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'Exactly one active evaluator identity is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  NEW.evaluator_user_id := matching_member_ids[1];
  NEW.evaluator_name := matching_member_names[1];

  RETURN NEW;
END;
$$;

CREATE TRIGGER set_project_difficulty_assessment_evaluator
BEFORE INSERT ON public.project_difficulty_assessments
FOR EACH ROW
EXECUTE FUNCTION app_private.set_project_difficulty_assessment_evaluator();

CREATE FUNCTION app_private.protect_project_difficulty_assessment_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.assessment_type IS DISTINCT FROM OLD.assessment_type
     OR NEW.evaluator_user_id IS DISTINCT FROM OLD.evaluator_user_id
     OR NEW.evaluator_name IS DISTINCT FROM OLD.evaluator_name THEN
    RAISE EXCEPTION 'Project difficulty assessment provenance is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_project_difficulty_assessment_provenance
BEFORE UPDATE ON public.project_difficulty_assessments
FOR EACH ROW
EXECUTE FUNCTION app_private.protect_project_difficulty_assessment_provenance();

ALTER TABLE public.project_difficulty_assessments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.project_difficulty_assessments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.project_difficulty_assessments
  TO authenticated;

CREATE POLICY "Active members can view project difficulty assessments"
ON public.project_difficulty_assessments
FOR SELECT TO authenticated
USING (app_private.is_active_member());

CREATE POLICY "Editor members can insert project difficulty assessments"
ON public.project_difficulty_assessments
FOR INSERT TO authenticated
WITH CHECK (
  app_private.is_editor_member()
);

CREATE POLICY "Editor members can update project difficulty assessments"
ON public.project_difficulty_assessments
FOR UPDATE TO authenticated
USING (app_private.is_editor_member())
WITH CHECK (app_private.is_editor_member());

-- Deliberately no DELETE grant or policy: these rows are project history.

NOTIFY pgrst, 'reload schema';
