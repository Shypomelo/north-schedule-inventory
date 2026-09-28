-- V6 contract inspection only. Run against Candidate fssogssryeunkjkdgewx.
-- No application RPC mutations, fixtures, DDL, or migration writes.
BEGIN READ ONLY;

SELECT current_setting('transaction_read_only') AS read_only,
  (SELECT jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', p.proname,
    'arguments', pg_get_function_identity_arguments(p.oid),
    'definition', pg_get_functiondef(p.oid)
  ) ORDER BY n.nspname, p.proname)
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prokind = 'f' AND (
     (n.nspname = 'public' AND (
       p.proname IN ('reserve_inventory_for_se', 'deliver_inventory_to_project')
       OR p.prosrc ILIKE '%receiving_inventory_allocations%'
       OR p.prosrc ILIKE '%reserve_inventory_for_se(%'
       OR p.prosrc ILIKE '%deliver_inventory_to_project(%'
     )) OR (n.nspname = 'app_private' AND p.proname = 'receiving_source')
   )) AS related_functions,
  (SELECT jsonb_agg(jsonb_build_object(
    'table', c.conrelid::regclass::text,
    'name', c.conname, 'definition', pg_get_constraintdef(c.oid)
  ) ORDER BY c.conname)
   FROM pg_constraint c
   WHERE c.conrelid IN ('public.material_receipts'::regclass,
                       'public.receiving_inventory_allocations'::regclass)
     AND c.contype = 'c') AS receipt_and_allocation_constraints,
  (SELECT count(*) FROM public.receiving_arrivals) AS arrivals,
  (SELECT count(*) FROM public.receiving_arrival_lines) AS arrival_lines,
  (SELECT count(*) FROM public.receiving_arrival_matches) AS matches;

ROLLBACK;

-- Separately executed read-only rejection probe (expected P0001):
-- BEGIN READ ONLY;
-- SELECT app_private.receiving_source('ARRIVAL', NULL::uuid);
-- ROLLBACK;
-- Result: Invalid receiving source. The ARRIVAL branch raises before table access.
