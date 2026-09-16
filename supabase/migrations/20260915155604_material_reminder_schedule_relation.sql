ALTER TABLE public.schedule_tasks
    ADD COLUMN source_material_batch_id uuid
        REFERENCES public.project_material_batches(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.schedule_tasks.source_material_batch_id IS
    'Canonical project material batch that produced a user-created receiving schedule.';

CREATE UNIQUE INDEX schedule_tasks_active_material_batch_unique_idx
    ON public.schedule_tasks (source_material_batch_id)
    WHERE source_material_batch_id IS NOT NULL
      AND deleted_at IS NULL
      AND status IS DISTINCT FROM '取消';

CREATE INDEX project_materials_pending_receipt_project_time_idx
    ON public.project_materials (project_id, expected_delivery_at, batch_id)
    WHERE expected_delivery_at IS NOT NULL
      AND received_at IS NULL
      AND procurement_status <> 'RECEIVED';

INSERT INTO public.schedule_task_types (name, sort_order)
SELECT '收料', COALESCE(max(sort_order), -1) + 1
FROM public.schedule_task_types
WHERE NOT EXISTS (
    SELECT 1
    FROM public.schedule_task_types
    WHERE lower(btrim(replace(name, chr(12288), ' '))) = lower('收料')
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
