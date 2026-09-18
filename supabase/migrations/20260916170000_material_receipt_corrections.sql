-- Material A.2 final calibration: append-only receipt corrections.
-- A reversal preserves the original receipt and subtracts from its effective quantity.

ALTER TABLE public.material_receipts
    ADD COLUMN event_type text NOT NULL DEFAULT 'RECEIVE',
    ADD COLUMN reversal_of_id uuid REFERENCES public.material_receipts(id) ON DELETE RESTRICT;

ALTER TABLE public.material_receipts
    ADD CONSTRAINT material_receipts_event_type_check
        CHECK (event_type IN ('RECEIVE', 'REVERSAL')),
    ADD CONSTRAINT material_receipts_reversal_reference_check
        CHECK (
            (event_type = 'RECEIVE' AND reversal_of_id IS NULL)
            OR (event_type = 'REVERSAL' AND reversal_of_id IS NOT NULL)
        );

CREATE INDEX material_receipts_reversal_of_idx
    ON public.material_receipts (reversal_of_id, created_at, id)
    WHERE reversal_of_id IS NOT NULL;

COMMENT ON COLUMN public.material_receipts.event_type IS
    'Append-only receipt event semantics. RECEIVE adds quantity; REVERSAL subtracts quantity.';
COMMENT ON COLUMN public.material_receipts.reversal_of_id IS
    'Original RECEIVE event corrected by this REVERSAL event.';

CREATE OR REPLACE FUNCTION app_private.rederive_material_receipt_source(
    p_source_type text,
    p_source_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_effective numeric;
    v_completed_at timestamptz;
    v_completed_by uuid;
    v_batch_id uuid;
BEGIN
    SELECT COALESCE(sum(
        CASE WHEN receipt.event_type = 'REVERSAL'
            THEN -receipt.quantity_received
            ELSE receipt.quantity_received
        END
    ), 0)
    INTO v_effective
    FROM public.material_receipts AS receipt
    WHERE (p_source_type = 'PROJECT_MATERIAL' AND receipt.project_material_id = p_source_id)
       OR (p_source_type = 'SE_SUPPLY' AND receipt.se_supply_record_id = p_source_id);

    SELECT receipt.received_at, receipt.received_by
    INTO v_completed_at, v_completed_by
    FROM public.material_receipts AS receipt
    WHERE receipt.event_type = 'RECEIVE'
      AND (
        (p_source_type = 'PROJECT_MATERIAL' AND receipt.project_material_id = p_source_id)
        OR (p_source_type = 'SE_SUPPLY' AND receipt.se_supply_record_id = p_source_id)
      )
    ORDER BY receipt.received_at DESC, receipt.id DESC
    LIMIT 1;

    IF p_source_type = 'PROJECT_MATERIAL' THEN
        SELECT material.batch_id INTO v_batch_id
        FROM public.project_materials AS material
        WHERE material.id = p_source_id;

        UPDATE public.project_materials AS material
        SET procurement_status = CASE
                WHEN v_effective <= 0 THEN CASE
                    WHEN batch.ordered_at IS NULL THEN 'NOT_ORDERED'
                    ELSE 'ORDERED'
                END
                WHEN v_effective < material.quantity THEN 'PARTIAL_RECEIVED'
                ELSE 'RECEIVED'
            END,
            received_at = CASE WHEN v_effective >= material.quantity THEN v_completed_at ELSE NULL END,
            received_on = CASE WHEN v_effective >= material.quantity
                THEN (v_completed_at AT TIME ZONE 'Asia/Taipei')::date
                ELSE NULL
            END,
            updated_at = now()
        FROM public.project_material_batches AS batch
        WHERE material.id = p_source_id
          AND batch.id = material.batch_id;

        UPDATE public.project_material_batches AS batch
        SET received_at = CASE
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM public.project_materials AS material
                    WHERE material.batch_id = batch.id
                      AND (material.procurement_status <> 'RECEIVED' OR material.received_at IS NULL)
                ) THEN (
                    SELECT max(material.received_at)
                    FROM public.project_materials AS material
                    WHERE material.batch_id = batch.id
                )
                ELSE NULL
            END,
            updated_at = now()
        WHERE batch.id = v_batch_id;
    ELSIF p_source_type = 'SE_SUPPLY' THEN
        UPDATE public.se_supply_records AS record
        SET procurement_status = CASE
                WHEN v_effective <= 0 THEN 'ORDERED'
                WHEN v_effective < record.quantity THEN 'PARTIAL_RECEIVED'
                ELSE 'RECEIVED'
            END,
            received_at = CASE WHEN v_effective >= record.quantity THEN v_completed_at ELSE NULL END,
            received_by = CASE WHEN v_effective >= record.quantity THEN v_completed_by ELSE NULL END,
            receive_date = CASE WHEN v_effective >= record.quantity
                THEN (v_completed_at AT TIME ZONE 'Asia/Taipei')::date
                ELSE NULL
            END,
            updated_at = now()
        WHERE record.id = p_source_id;
    ELSE
        RAISE EXCEPTION 'Unsupported material receipt source' USING ERRCODE = '23514';
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.rederive_material_receipt_source(text, uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.confirm_material_receipt(
    p_source_type text,
    p_source_id uuid,
    p_quantity_received numeric,
    p_received_at timestamptz DEFAULT now(),
    p_notes text DEFAULT NULL
)
RETURNS SETOF public.material_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_member_id uuid;
    v_receipt public.material_receipts%ROWTYPE;
    v_material public.project_materials%ROWTYPE;
    v_se public.se_supply_records%ROWTYPE;
    v_received numeric;
    v_receipt_count integer;
BEGIN
    IF NOT app_private.is_editor_member() THEN
        RAISE EXCEPTION 'Only active editor members can confirm receipts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_member_id := app_private.current_member_id();
    IF v_member_id IS NULL THEN
        RAISE EXCEPTION 'Current active member not found'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_source_type NOT IN ('PROJECT_MATERIAL', 'SE_SUPPLY') THEN
        RAISE EXCEPTION 'Unsupported material receipt source' USING ERRCODE = '23514';
    END IF;
    IF p_quantity_received IS NULL OR p_quantity_received <= 0 THEN
        RAISE EXCEPTION 'Received quantity must be positive' USING ERRCODE = '23514';
    END IF;
    IF p_received_at IS NULL THEN
        RAISE EXCEPTION 'Received time is required' USING ERRCODE = '23502';
    END IF;

    IF p_source_type = 'PROJECT_MATERIAL' THEN
        SELECT * INTO v_material
        FROM public.project_materials WHERE id = p_source_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Project material not found' USING ERRCODE = 'P0002'; END IF;

        SELECT COALESCE(sum(CASE WHEN receipt.event_type = 'REVERSAL'
                    THEN -receipt.quantity_received ELSE receipt.quantity_received END), 0),
               count(*)
        INTO v_received, v_receipt_count
        FROM public.material_receipts AS receipt
        WHERE receipt.project_material_id = v_material.id;

        IF (v_receipt_count = 0 AND (v_material.procurement_status = 'RECEIVED' OR v_material.received_at IS NOT NULL))
           OR v_received >= v_material.quantity THEN
            RAISE EXCEPTION 'Project material is already fully received' USING ERRCODE = '23514';
        END IF;
        IF p_quantity_received > v_material.quantity - v_received THEN
            RAISE EXCEPTION 'Received quantity exceeds the remaining project material quantity' USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.material_receipts (
            source_type, project_material_id, event_type, quantity_received,
            received_by, received_at, notes
        ) VALUES (
            'PROJECT_MATERIAL', v_material.id, 'RECEIVE', p_quantity_received,
            v_member_id, p_received_at, NULLIF(btrim(COALESCE(p_notes, '')), '')
        ) RETURNING * INTO v_receipt;
    ELSE
        SELECT * INTO v_se
        FROM public.se_supply_records WHERE id = p_source_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'SE supply record not found' USING ERRCODE = 'P0002'; END IF;

        SELECT COALESCE(sum(CASE WHEN receipt.event_type = 'REVERSAL'
                    THEN -receipt.quantity_received ELSE receipt.quantity_received END), 0),
               count(*)
        INTO v_received, v_receipt_count
        FROM public.material_receipts AS receipt
        WHERE receipt.se_supply_record_id = v_se.id;

        IF (v_receipt_count = 0 AND (v_se.procurement_status = 'RECEIVED' OR v_se.received_at IS NOT NULL))
           OR v_received >= v_se.quantity THEN
            RAISE EXCEPTION 'SE supply is already fully received' USING ERRCODE = '23514';
        END IF;
        IF p_quantity_received > v_se.quantity - v_received THEN
            RAISE EXCEPTION 'Received quantity exceeds the remaining SE supply quantity' USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.material_receipts (
            source_type, se_supply_record_id, event_type, quantity_received,
            received_by, received_at, notes
        ) VALUES (
            'SE_SUPPLY', v_se.id, 'RECEIVE', p_quantity_received,
            v_member_id, p_received_at, NULLIF(btrim(COALESCE(p_notes, '')), '')
        ) RETURNING * INTO v_receipt;
    END IF;

    PERFORM app_private.rederive_material_receipt_source(p_source_type, p_source_id);
    RETURN NEXT v_receipt;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_material_receipt(
    p_receipt_id uuid,
    p_quantity_reversed numeric,
    p_reversed_at timestamptz DEFAULT now(),
    p_notes text DEFAULT NULL
)
RETURNS SETOF public.material_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_member_id uuid;
    v_original public.material_receipts%ROWTYPE;
    v_reversal public.material_receipts%ROWTYPE;
    v_already_reversed numeric;
    v_source_id uuid;
BEGIN
    IF NOT app_private.is_editor_member() THEN
        RAISE EXCEPTION 'Only active editor members can correct receipts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_member_id := app_private.current_member_id();
    IF v_member_id IS NULL THEN
        RAISE EXCEPTION 'Current active member not found'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_quantity_reversed IS NULL OR p_quantity_reversed <= 0 THEN
        RAISE EXCEPTION 'Reversal quantity must be positive' USING ERRCODE = '23514';
    END IF;
    IF p_reversed_at IS NULL THEN
        RAISE EXCEPTION 'Reversal time is required' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_original
    FROM public.material_receipts
    WHERE id = p_receipt_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Original material receipt not found' USING ERRCODE = 'P0002'; END IF;
    IF v_original.event_type <> 'RECEIVE' THEN
        RAISE EXCEPTION 'Only a RECEIVE event can be reversed' USING ERRCODE = '23514';
    END IF;

    v_source_id := COALESCE(v_original.project_material_id, v_original.se_supply_record_id);
    IF v_original.source_type = 'PROJECT_MATERIAL' THEN
        PERFORM 1 FROM public.project_materials WHERE id = v_source_id FOR UPDATE;
    ELSE
        PERFORM 1 FROM public.se_supply_records WHERE id = v_source_id FOR UPDATE;
    END IF;

    SELECT COALESCE(sum(receipt.quantity_received), 0)
    INTO v_already_reversed
    FROM public.material_receipts AS receipt
    WHERE receipt.event_type = 'REVERSAL'
      AND receipt.reversal_of_id = v_original.id;

    IF p_quantity_reversed > v_original.quantity_received - v_already_reversed THEN
        RAISE EXCEPTION 'Reversal quantity exceeds the unreversed receipt quantity'
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.material_receipts (
        source_type, project_material_id, se_supply_record_id,
        event_type, reversal_of_id, quantity_received,
        received_by, received_at, notes
    ) VALUES (
        v_original.source_type, v_original.project_material_id, v_original.se_supply_record_id,
        'REVERSAL', v_original.id, p_quantity_reversed,
        v_member_id, p_reversed_at, NULLIF(btrim(COALESCE(p_notes, '')), '')
    ) RETURNING * INTO v_reversal;

    PERFORM app_private.rederive_material_receipt_source(v_original.source_type, v_source_id);
    RETURN NEXT v_reversal;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_material_receipt_schedule(
    p_schedule_task_id uuid,
    p_completed_at timestamptz DEFAULT now()
)
RETURNS SETOF public.schedule_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_task public.schedule_tasks%ROWTYPE;
    v_batch public.project_material_batches%ROWTYPE;
    v_material record;
BEGIN
    IF NOT app_private.is_editor_member() THEN
        RAISE EXCEPTION 'Only active editor members can complete receipt schedules'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO v_task FROM public.schedule_tasks WHERE id = p_schedule_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt schedule not found' USING ERRCODE = 'P0002'; END IF;
    IF v_task.source_material_batch_id IS NULL OR v_task.source_material_receipt_at IS NULL
       OR lower(btrim(replace(v_task.task_type, chr(12288), ' '))) <> lower('收料') THEN
        RAISE EXCEPTION 'Schedule is not linked to a receipt-time group' USING ERRCODE = '23514';
    END IF;
    IF v_task.status = '取消' OR v_task.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Cancelled receipt schedule cannot be completed' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_batch FROM public.project_material_batches
    WHERE id = v_task.source_material_batch_id FOR UPDATE;

    FOR v_material IN
        SELECT material.id,
               GREATEST(material.quantity - COALESCE((
                   SELECT sum(CASE WHEN receipt.event_type = 'REVERSAL'
                       THEN -receipt.quantity_received ELSE receipt.quantity_received END)
                   FROM public.material_receipts AS receipt
                   WHERE receipt.project_material_id = material.id
               ), 0), 0) AS remaining_quantity
        FROM public.project_materials AS material
        WHERE material.batch_id = v_batch.id
          AND COALESCE(material.expected_delivery_at, v_batch.planned_receipt_at)
              IS NOT DISTINCT FROM v_task.source_material_receipt_at
    LOOP
        IF v_material.remaining_quantity > 0 THEN
            PERFORM public.confirm_material_receipt(
                'PROJECT_MATERIAL', v_material.id, v_material.remaining_quantity,
                p_completed_at, '由收料排程完成'
            );
        END IF;
    END LOOP;

    UPDATE public.schedule_tasks
    SET status = '完成', updated_at = p_completed_at
    WHERE id = p_schedule_task_id;
    RETURN QUERY SELECT task.* FROM public.schedule_tasks AS task WHERE task.id = p_schedule_task_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_material_receipt(uuid, numeric, timestamptz, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_material_receipt(uuid, numeric, timestamptz, text)
TO authenticated;

REVOKE ALL ON FUNCTION public.confirm_material_receipt(text, uuid, numeric, timestamptz, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_material_receipt(text, uuid, numeric, timestamptz, text)
TO authenticated;

REVOKE ALL ON FUNCTION public.complete_material_receipt_schedule(uuid, timestamptz)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_material_receipt_schedule(uuid, timestamptz)
TO authenticated;

COMMENT ON FUNCTION public.reverse_material_receipt(uuid, numeric, timestamptz, text) IS
    'Appends a bounded REVERSAL event and re-derives project/SE receipt state without changing original evidence.';
COMMENT ON TABLE public.material_receipts IS
    'Append-only inbound receiving evidence. RECEIVE adds effective quantity and REVERSAL subtracts it.';

NOTIFY pgrst, 'reload schema';
