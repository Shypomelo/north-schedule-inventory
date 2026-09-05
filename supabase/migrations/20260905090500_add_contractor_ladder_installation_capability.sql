ALTER TABLE public.contractors
    DROP CONSTRAINT contractors_work_capabilities_allowed_check,
    ADD CONSTRAINT contractors_work_capabilities_allowed_check
    CHECK (
        work_capabilities <@ ARRAY[
            'racking',
            'electrical',
            'steel',
            'roof_cover',
            'civil',
            'ladder_installation',
            'other'
        ]::text[]
        AND array_position(work_capabilities, NULL) IS NULL
    );
