ALTER TABLE public.project_material_batches
    ADD COLUMN planned_receipt_at timestamptz,
    ADD COLUMN received_at timestamptz;

COMMENT ON COLUMN public.project_material_batches.planned_receipt_at IS
    'Canonical planned receipt time shared by the material batch, receipt schedule, and dashboard.';

COMMENT ON COLUMN public.project_material_batches.received_at IS
    'Canonical completion time for the inbound receipt batch.';

WITH batch_plan AS (
    SELECT batch_id, min(expected_delivery_at) AS planned_receipt_at
    FROM public.project_materials
    WHERE expected_delivery_at IS NOT NULL
    GROUP BY batch_id
)
UPDATE public.project_material_batches AS batch
SET planned_receipt_at = plan.planned_receipt_at
FROM batch_plan AS plan
WHERE batch.id = plan.batch_id
  AND batch.planned_receipt_at IS NULL;

WITH completed_schedule AS (
    SELECT source_material_batch_id AS batch_id, max(updated_at) AS received_at
    FROM public.schedule_tasks
    WHERE source_material_batch_id IS NOT NULL
      AND lower(btrim(replace(task_type, chr(12288), ' '))) = lower('收料')
      AND status IN ('完成', '已完成')
      AND deleted_at IS NULL
    GROUP BY source_material_batch_id
), completed_batch AS (
    UPDATE public.project_material_batches AS batch
    SET received_at = receipt.received_at
    FROM completed_schedule AS receipt
    WHERE batch.id = receipt.batch_id
      AND batch.received_at IS NULL
    RETURNING batch.id, batch.received_at
)
UPDATE public.project_materials AS material
SET procurement_status = 'RECEIVED',
    received_at = COALESCE(material.received_at, batch.received_at)
FROM completed_batch AS batch
WHERE material.batch_id = batch.id
  AND (material.procurement_status <> 'RECEIVED' OR material.received_at IS NULL);

CREATE INDEX project_material_batches_pending_receipt_time_idx
    ON public.project_material_batches (project_id, planned_receipt_at, id)
    WHERE planned_receipt_at IS NOT NULL
      AND received_at IS NULL;

CREATE OR REPLACE FUNCTION public.update_material_receipt_plan(
    p_batch_id uuid,
    p_planned_receipt_at timestamptz
)
RETURNS SETOF public.project_material_batches
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
    v_batch public.project_material_batches%ROWTYPE;
BEGIN
    SELECT * INTO v_batch
    FROM public.project_material_batches
    WHERE id = p_batch_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Material receipt batch not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_batch.received_at IS NOT NULL THEN
        RAISE EXCEPTION 'Completed material receipt batch cannot be rescheduled'
            USING ERRCODE = '23514';
    END IF;

    IF p_planned_receipt_at IS NULL AND EXISTS (
        SELECT 1
        FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = p_batch_id
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消'
          AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成'
          AND task.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'A scheduled receipt requires a planned receipt time'
            USING ERRCODE = '23514';
    END IF;

    UPDATE public.project_material_batches
    SET planned_receipt_at = p_planned_receipt_at
    WHERE id = p_batch_id;

    UPDATE public.project_materials
    SET expected_delivery_at = p_planned_receipt_at
    WHERE batch_id = p_batch_id
      AND procurement_status <> 'RECEIVED'
      AND received_at IS NULL;

    IF p_planned_receipt_at IS NOT NULL THEN
        UPDATE public.schedule_tasks
        SET task_date = (p_planned_receipt_at AT TIME ZONE 'Asia/Taipei')::date,
            start_time = (p_planned_receipt_at AT TIME ZONE 'Asia/Taipei')::time,
            is_all_day = false,
            updated_at = now()
        WHERE source_material_batch_id = p_batch_id
          AND lower(btrim(replace(task_type, chr(12288), ' '))) = lower('收料')
          AND status IS DISTINCT FROM '取消'
          AND status IS DISTINCT FROM '完成'
          AND status IS DISTINCT FROM '已完成'
          AND deleted_at IS NULL;
    END IF;

    RETURN QUERY
    SELECT batch.*
    FROM public.project_material_batches AS batch
    WHERE batch.id = p_batch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_material_receipt_schedule(
    p_schedule_task_id uuid,
    p_completed_at timestamptz DEFAULT now()
)
RETURNS SETOF public.schedule_tasks
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
    v_task public.schedule_tasks%ROWTYPE;
BEGIN
    SELECT * INTO v_task
    FROM public.schedule_tasks
    WHERE id = p_schedule_task_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Receipt schedule not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_task.source_material_batch_id IS NULL
       OR lower(btrim(replace(v_task.task_type, chr(12288), ' '))) <> lower('收料') THEN
        RAISE EXCEPTION 'Schedule is not linked to a material receipt batch'
            USING ERRCODE = '23514';
    END IF;

    IF v_task.status = '取消' OR v_task.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Cancelled receipt schedule cannot be completed'
            USING ERRCODE = '23514';
    END IF;

    UPDATE public.schedule_tasks
    SET status = '完成',
        updated_at = p_completed_at
    WHERE id = p_schedule_task_id;

    UPDATE public.project_material_batches
    SET received_at = COALESCE(received_at, p_completed_at)
    WHERE id = v_task.source_material_batch_id;

    UPDATE public.project_materials
    SET procurement_status = 'RECEIVED',
        received_at = COALESCE(received_at, p_completed_at)
    WHERE batch_id = v_task.source_material_batch_id
      AND (procurement_status <> 'RECEIVED' OR received_at IS NULL);

    RETURN QUERY
    SELECT task.*
    FROM public.schedule_tasks AS task
    WHERE task.id = p_schedule_task_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_material_receipt_plan(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_material_receipt_schedule(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_material_receipt_plan(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_material_receipt_schedule(uuid, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
