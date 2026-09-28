-- Read-only supplement to the 47 checks in receiving-contract-integrity.sql.
SELECT jsonb_build_object(
 'canonical_key_duplicate_groups',(SELECT count(*) FROM (
   SELECT app_private.normalize_inventory_item_identity(canonical_identity_key)
   FROM public.inventory_items WHERE canonical_identity_key IS NOT NULL
   GROUP BY 1 HAVING count(*)>1
 ) collisions),
 'canonical_key_empty_values',(SELECT count(*) FROM public.inventory_items
   WHERE canonical_identity_key IS NOT NULL
   AND app_private.normalize_inventory_item_identity(canonical_identity_key)='')
) AS violations;
