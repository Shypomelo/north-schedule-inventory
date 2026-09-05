-- This migration changes only the NORTH_DEFAULT template used for future
-- snapshots. Existing project_workflow_instances/project_milestones are not
-- updated, so project-specific workflow history remains immutable.

WITH template AS (
    SELECT id
    FROM public.project_workflow_templates
    WHERE template_key = 'NORTH_DEFAULT'
)
UPDATE public.project_workflow_template_steps AS step
SET is_active = false
FROM template
WHERE step.template_id = template.id
  AND step.step_key = 'GOVERNMENT_DOCUMENTS';

WITH desired(step_key, label, phase_key, type_key, sort_order) AS (
    VALUES
        ('SITE_SURVEY', '初次現勘', 'PREPARATION', 'ENGINEERING', 10),
        ('STRUCTURAL_DRAWING', '結構圖確認', 'PREPARATION', 'DESIGN', 20),
        ('ELECTRICAL_DRAWING', '電力圖確認', 'STARTUP', 'DESIGN', 30),
        ('MATERIAL_REQUEST', '物料申請', 'STARTUP', 'MATERIAL', 40),
        ('START_WORK_CHECKLIST', '開工清單', 'STARTUP', 'ENGINEERING', 50),
        ('TAIPOWER_SUBMISSION', '台電送件', 'STARTUP', 'TAIPOWER', 60),
        ('REVIEW_OPINION_RECEIVED', '審查意見書取得', 'STARTUP', 'GOVERNMENT', 70),
        ('CONSENT_FILING_RECEIVED', '同意備案取得', 'STARTUP', 'GOVERNMENT', 80),
        ('MISC_EXEMPTION_SUBMISSION', '免雜送件', 'STARTUP', 'GOVERNMENT', 90),
        ('MISC_EXEMPTION_RECEIVED', '免雜取得', 'STARTUP', 'GOVERNMENT', 100),
        ('TAIPOWER_COORDINATION', '台電協商', 'STARTUP', 'TAIPOWER', 110),
        ('ENTRY_READINESS', '進場條件確認', 'STARTUP', 'ENGINEERING', 120),
        ('SITE_ENTRY', '進場', 'CONSTRUCTION', 'ENGINEERING', 130),
        ('EXTERNAL_LINE_COMPLETED', '外線完成', 'CONSTRUCTION', 'TAIPOWER', 140),
        ('COMPLETION', '完工', 'CONSTRUCTION', 'ENGINEERING', 150),
        ('INTERNAL_ACCEPTANCE', '工程內部驗收', 'CLOSEOUT', 'ACCEPTANCE', 160),
        ('COMPLETION_REPORT', '報竣', 'CLOSEOUT', 'GOVERNMENT', 170),
        ('METER_INSTALLATION', '掛表', 'CLOSEOUT', 'TAIPOWER', 180)
),
resolved AS (
    SELECT
        template.id AS template_id,
        desired.step_key,
        desired.label,
        phase.id AS phase_id,
        workflow_type.id AS type_id,
        desired.sort_order
    FROM desired
    JOIN public.project_workflow_templates AS template
      ON template.template_key = 'NORTH_DEFAULT'
    JOIN public.project_workflow_phases AS phase
      ON phase.phase_key = desired.phase_key
    JOIN public.project_workflow_types AS workflow_type
      ON workflow_type.type_key = desired.type_key
)
INSERT INTO public.project_workflow_template_steps (
    template_id,
    step_key,
    label,
    phase_id,
    type_id,
    sort_order,
    default_is_applicable,
    is_active
)
SELECT
    template_id,
    step_key,
    label,
    phase_id,
    type_id,
    sort_order,
    true,
    true
FROM resolved
ON CONFLICT (template_id, step_key) DO UPDATE
SET label = EXCLUDED.label,
    phase_id = EXCLUDED.phase_id,
    type_id = EXCLUDED.type_id,
    sort_order = EXCLUDED.sort_order,
    is_active = true;
