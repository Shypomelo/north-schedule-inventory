-- Phase A.2 final convergence: batch receipt default plus optional material override.
-- Existing canonical tables and append-only material_receipts stay unchanged.

ALTER TABLE public.project_material_batches
    ADD COLUMN same_day_delivery boolean NOT NULL DEFAULT true;

ALTER TABLE public.schedule_tasks
    ADD COLUMN source_material_receipt_at timestamptz;

UPDATE public.project_material_batches AS batch
SET same_day_delivery = NOT EXISTS (
    SELECT 1
    FROM public.project_materials AS material
    WHERE material.batch_id = batch.id
      AND material.procurement_status <> 'RECEIVED'
      AND material.received_at IS NULL
      AND material.expected_delivery_at IS NOT NULL
      AND material.expected_delivery_at IS DISTINCT FROM batch.planned_receipt_at
);

UPDATE public.project_materials AS material
SET expected_delivery_at = NULL
FROM public.project_material_batches AS batch
WHERE material.batch_id = batch.id
  AND batch.same_day_delivery
  AND material.procurement_status <> 'RECEIVED'
  AND material.received_at IS NULL
  AND material.expected_delivery_at IS NOT DISTINCT FROM batch.planned_receipt_at;

UPDATE public.schedule_tasks AS task
SET source_material_receipt_at = batch.planned_receipt_at
FROM public.project_material_batches AS batch
WHERE task.source_material_batch_id = batch.id
  AND task.source_material_receipt_at IS NULL;

DROP INDEX IF EXISTS public.schedule_tasks_active_material_batch_unique_idx;

CREATE UNIQUE INDEX schedule_tasks_active_material_receipt_group_unique_idx
    ON public.schedule_tasks (source_material_batch_id, source_material_receipt_at)
    WHERE source_material_batch_id IS NOT NULL
      AND source_material_receipt_at IS NOT NULL
      AND status IS DISTINCT FROM '取消'
      AND status IS DISTINCT FROM '完成'
      AND status IS DISTINCT FROM '已完成'
      AND deleted_at IS NULL;

COMMENT ON COLUMN public.project_material_batches.same_day_delivery IS
    'When true, unfinished materials inherit planned_receipt_at and cannot carry individual overrides.';
COMMENT ON COLUMN public.schedule_tasks.source_material_receipt_at IS
    'Immutable identity of the effective receipt-time group currently represented by this receipt schedule.';

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
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Material receipt batch not found' USING ERRCODE = 'P0002'; END IF;
    IF v_batch.received_at IS NOT NULL THEN RAISE EXCEPTION 'Completed material receipt batch cannot be rescheduled' USING ERRCODE = '23514'; END IF;
    IF p_planned_receipt_at IS NULL AND EXISTS (
        SELECT 1 FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = p_batch_id
          AND task.source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
    ) THEN RAISE EXCEPTION 'A scheduled receipt requires a planned receipt time' USING ERRCODE = '23514'; END IF;

    IF p_planned_receipt_at IS NOT NULL THEN
        UPDATE public.schedule_tasks AS target
        SET status = '取消', updated_at = now()
        WHERE target.source_material_batch_id = p_batch_id
          AND target.source_material_receipt_at = p_planned_receipt_at
          AND target.source_material_receipt_at IS DISTINCT FROM v_batch.planned_receipt_at
          AND lower(btrim(replace(target.task_type, chr(12288), ' '))) = lower('收料')
          AND target.status IS DISTINCT FROM '取消' AND target.status IS DISTINCT FROM '完成'
          AND target.status IS DISTINCT FROM '已完成' AND target.deleted_at IS NULL;
    END IF;

    UPDATE public.project_material_batches
    SET planned_receipt_at = p_planned_receipt_at, updated_at = now()
    WHERE id = p_batch_id;

    IF p_planned_receipt_at IS NOT NULL THEN
        UPDATE public.schedule_tasks
        SET source_material_receipt_at = p_planned_receipt_at,
            task_date = (p_planned_receipt_at AT TIME ZONE 'Asia/Taipei')::date,
            start_time = (p_planned_receipt_at AT TIME ZONE 'Asia/Taipei')::time,
            is_all_day = false, updated_at = now()
        WHERE source_material_batch_id = p_batch_id
          AND source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at
          AND lower(btrim(replace(task_type, chr(12288), ' '))) = lower('收料')
          AND status IS DISTINCT FROM '取消' AND status IS DISTINCT FROM '完成'
          AND status IS DISTINCT FROM '已完成' AND deleted_at IS NULL;
    END IF;

    RETURN QUERY SELECT batch.* FROM public.project_material_batches AS batch WHERE batch.id = p_batch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_material_batch_same_day(
    p_batch_id uuid,
    p_same_day_delivery boolean
)
RETURNS SETOF public.project_material_batches
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
    v_batch public.project_material_batches%ROWTYPE;
    v_keep_task_id uuid;
BEGIN
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Material receipt batch not found' USING ERRCODE = 'P0002'; END IF;
    IF v_batch.received_at IS NOT NULL THEN RAISE EXCEPTION 'Completed material receipt batch cannot be changed' USING ERRCODE = '23514'; END IF;

    IF p_same_day_delivery THEN
        SELECT task.id INTO v_keep_task_id
        FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = p_batch_id
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
        ORDER BY (task.source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at) DESC, task.created_at, task.id
        LIMIT 1 FOR UPDATE;

        UPDATE public.schedule_tasks
        SET status = '取消', updated_at = now()
        WHERE source_material_batch_id = p_batch_id
          AND id IS DISTINCT FROM v_keep_task_id
          AND lower(btrim(replace(task_type, chr(12288), ' '))) = lower('收料')
          AND status IS DISTINCT FROM '取消' AND status IS DISTINCT FROM '完成'
          AND status IS DISTINCT FROM '已完成' AND deleted_at IS NULL;

        IF v_keep_task_id IS NOT NULL AND v_batch.planned_receipt_at IS NOT NULL THEN
            UPDATE public.schedule_tasks
            SET source_material_receipt_at = v_batch.planned_receipt_at,
                task_date = (v_batch.planned_receipt_at AT TIME ZONE 'Asia/Taipei')::date,
                start_time = (v_batch.planned_receipt_at AT TIME ZONE 'Asia/Taipei')::time,
                is_all_day = false, updated_at = now()
            WHERE id = v_keep_task_id;
        ELSIF v_keep_task_id IS NOT NULL THEN
            UPDATE public.schedule_tasks SET status = '取消', updated_at = now() WHERE id = v_keep_task_id;
        END IF;

        UPDATE public.project_materials
        SET expected_delivery_at = NULL, updated_at = now()
        WHERE batch_id = p_batch_id AND procurement_status <> 'RECEIVED' AND received_at IS NULL;
    END IF;

    UPDATE public.project_material_batches
    SET same_day_delivery = p_same_day_delivery, updated_at = now()
    WHERE id = p_batch_id;
    RETURN QUERY SELECT batch.* FROM public.project_material_batches AS batch WHERE batch.id = p_batch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_material_receipt_override(
    p_material_id uuid,
    p_expected_delivery_at timestamptz
)
RETURNS SETOF public.project_materials
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
    v_material public.project_materials%ROWTYPE;
    v_batch public.project_material_batches%ROWTYPE;
    v_old_effective timestamptz;
    v_new_override timestamptz;
    v_new_effective timestamptz;
    v_old_task_id uuid;
BEGIN
    SELECT * INTO v_material FROM public.project_materials WHERE id = p_material_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project material not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = v_material.batch_id FOR UPDATE;
    IF v_batch.same_day_delivery THEN RAISE EXCEPTION 'Same-day batches must edit the batch receipt default' USING ERRCODE = '23514'; END IF;
    IF v_material.procurement_status = 'RECEIVED' OR v_material.received_at IS NOT NULL THEN RAISE EXCEPTION 'Received material cannot be rescheduled' USING ERRCODE = '23514'; END IF;

    v_old_effective := COALESCE(v_material.expected_delivery_at, v_batch.planned_receipt_at);
    v_new_override := CASE WHEN p_expected_delivery_at IS NOT DISTINCT FROM v_batch.planned_receipt_at THEN NULL ELSE p_expected_delivery_at END;
    v_new_effective := COALESCE(v_new_override, v_batch.planned_receipt_at);
    UPDATE public.project_materials SET expected_delivery_at = v_new_override, updated_at = now() WHERE id = p_material_id;

    IF v_old_effective IS DISTINCT FROM v_new_effective AND NOT EXISTS (
        SELECT 1 FROM public.project_materials AS material
        WHERE material.batch_id = v_batch.id AND material.id <> p_material_id
          AND material.procurement_status <> 'RECEIVED' AND material.received_at IS NULL
          AND COALESCE(material.expected_delivery_at, v_batch.planned_receipt_at) IS NOT DISTINCT FROM v_old_effective
    ) THEN
        SELECT task.id INTO v_old_task_id FROM public.schedule_tasks AS task
        WHERE task.source_material_batch_id = v_batch.id
          AND task.source_material_receipt_at IS NOT DISTINCT FROM v_old_effective
          AND lower(btrim(replace(task.task_type, chr(12288), ' '))) = lower('收料')
          AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
          AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
        ORDER BY task.created_at, task.id LIMIT 1 FOR UPDATE;
        IF v_old_task_id IS NOT NULL THEN
            IF v_new_effective IS NULL OR EXISTS (
                SELECT 1 FROM public.schedule_tasks AS task
                WHERE task.source_material_batch_id = v_batch.id
                  AND task.source_material_receipt_at IS NOT DISTINCT FROM v_new_effective
                  AND task.id <> v_old_task_id
                  AND task.status IS DISTINCT FROM '取消' AND task.status IS DISTINCT FROM '完成'
                  AND task.status IS DISTINCT FROM '已完成' AND task.deleted_at IS NULL
            ) THEN
                UPDATE public.schedule_tasks SET status = '取消', updated_at = now() WHERE id = v_old_task_id;
            ELSE
                UPDATE public.schedule_tasks
                SET source_material_receipt_at = v_new_effective,
                    task_date = (v_new_effective AT TIME ZONE 'Asia/Taipei')::date,
                    start_time = (v_new_effective AT TIME ZONE 'Asia/Taipei')::time,
                    is_all_day = false, updated_at = now()
                WHERE id = v_old_task_id;
            END IF;
        END IF;
    END IF;
    RETURN QUERY SELECT material.* FROM public.project_materials AS material WHERE material.id = p_material_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_material_receipt_group(
    p_schedule_task_id uuid,
    p_expected_delivery_at timestamptz
)
RETURNS SETOF public.schedule_tasks
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
    v_task public.schedule_tasks%ROWTYPE;
    v_batch public.project_material_batches%ROWTYPE;
BEGIN
    IF p_expected_delivery_at IS NULL THEN RAISE EXCEPTION 'Receipt group time is required' USING ERRCODE = '23502'; END IF;
    SELECT * INTO v_task FROM public.schedule_tasks WHERE id = p_schedule_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt schedule not found' USING ERRCODE = 'P0002'; END IF;
    IF v_task.source_material_batch_id IS NULL OR v_task.source_material_receipt_at IS NULL
       OR lower(btrim(replace(v_task.task_type, chr(12288), ' '))) <> lower('收料') THEN
        RAISE EXCEPTION 'Schedule is not linked to a receipt-time group' USING ERRCODE = '23514';
    END IF;
    IF v_task.status = '取消' OR v_task.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Cancelled receipt schedule cannot be rescheduled' USING ERRCODE = '23514'; END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = v_task.source_material_batch_id FOR UPDATE;

    UPDATE public.schedule_tasks
    SET status = '取消', updated_at = now()
    WHERE source_material_batch_id = v_batch.id
      AND source_material_receipt_at = p_expected_delivery_at
      AND id <> p_schedule_task_id
      AND status IS DISTINCT FROM '取消' AND status IS DISTINCT FROM '完成'
      AND status IS DISTINCT FROM '已完成' AND deleted_at IS NULL;

    IF v_task.source_material_receipt_at IS NOT DISTINCT FROM v_batch.planned_receipt_at THEN
        UPDATE public.project_material_batches SET planned_receipt_at = p_expected_delivery_at, updated_at = now() WHERE id = v_batch.id;
    ELSE
        UPDATE public.project_materials
        SET expected_delivery_at = CASE WHEN p_expected_delivery_at IS NOT DISTINCT FROM v_batch.planned_receipt_at THEN NULL ELSE p_expected_delivery_at END,
            updated_at = now()
        WHERE batch_id = v_batch.id AND procurement_status <> 'RECEIVED' AND received_at IS NULL
          AND expected_delivery_at IS NOT DISTINCT FROM v_task.source_material_receipt_at;
    END IF;

    UPDATE public.schedule_tasks
    SET source_material_receipt_at = p_expected_delivery_at,
        task_date = (p_expected_delivery_at AT TIME ZONE 'Asia/Taipei')::date,
        start_time = (p_expected_delivery_at AT TIME ZONE 'Asia/Taipei')::time,
        is_all_day = false, updated_at = now()
    WHERE id = p_schedule_task_id;
    RETURN QUERY SELECT task.* FROM public.schedule_tasks AS task WHERE task.id = p_schedule_task_id;
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
    v_batch public.project_material_batches%ROWTYPE;
BEGIN
    SELECT * INTO v_task FROM public.schedule_tasks WHERE id = p_schedule_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt schedule not found' USING ERRCODE = 'P0002'; END IF;
    IF v_task.source_material_batch_id IS NULL OR v_task.source_material_receipt_at IS NULL
       OR lower(btrim(replace(v_task.task_type, chr(12288), ' '))) <> lower('收料') THEN
        RAISE EXCEPTION 'Schedule is not linked to a receipt-time group' USING ERRCODE = '23514';
    END IF;
    IF v_task.status = '取消' OR v_task.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Cancelled receipt schedule cannot be completed' USING ERRCODE = '23514'; END IF;
    SELECT * INTO v_batch FROM public.project_material_batches WHERE id = v_task.source_material_batch_id FOR UPDATE;

    UPDATE public.schedule_tasks SET status = '完成', updated_at = p_completed_at WHERE id = p_schedule_task_id;
    UPDATE public.project_materials
    SET procurement_status = 'RECEIVED', received_at = COALESCE(received_at, p_completed_at),
        received_on = COALESCE(received_on, (p_completed_at AT TIME ZONE 'Asia/Taipei')::date), updated_at = now()
    WHERE batch_id = v_batch.id AND (procurement_status <> 'RECEIVED' OR received_at IS NULL)
      AND COALESCE(expected_delivery_at, v_batch.planned_receipt_at) IS NOT DISTINCT FROM v_task.source_material_receipt_at;

    IF NOT EXISTS (
        SELECT 1 FROM public.project_materials AS material
        WHERE material.batch_id = v_batch.id AND (material.procurement_status <> 'RECEIVED' OR material.received_at IS NULL)
    ) THEN
        UPDATE public.project_material_batches SET received_at = COALESCE(received_at, p_completed_at), updated_at = now() WHERE id = v_batch.id;
    END IF;
    RETURN QUERY SELECT task.* FROM public.schedule_tasks AS task WHERE task.id = p_schedule_task_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_material_receipt_plan(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_material_batch_same_day(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_material_receipt_override(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reschedule_material_receipt_group(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_material_receipt_schedule(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_material_receipt_plan(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_material_batch_same_day(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_material_receipt_override(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_material_receipt_group(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_material_receipt_schedule(uuid, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
