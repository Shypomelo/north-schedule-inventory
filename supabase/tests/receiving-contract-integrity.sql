-- Read-only V4 + V5 integrity. Run after fixture rollback, or on the isolated fixture clone.
WITH base AS (
WITH effective_receipts AS (
 SELECT r.id,r.quantity_received-COALESCE((SELECT sum(v.quantity_received) FROM public.material_receipts v WHERE v.reversal_of_id=r.id AND v.event_type='REVERSAL'),0) quantity
 FROM public.material_receipts r WHERE r.event_type='RECEIVE'
), balances AS (
 SELECT i.id,i.opening_quantity+COALESCE(sum(CASE t.transaction_type WHEN 'IN' THEN t.quantity WHEN 'RETURN' THEN t.quantity WHEN 'OUT' THEN -t.quantity WHEN 'ADJUST' THEN t.quantity ELSE 0 END),0) balance
 FROM public.inventory_items i LEFT JOIN public.inventory_transactions t ON t.item_id=i.id AND t.is_voided IS NOT TRUE AND t.excluded_by_initialization_id IS NULL GROUP BY i.id
)
SELECT jsonb_build_object(
'counts',jsonb_build_object(
'receipts',(SELECT count(*) FROM public.material_receipts),
'inventory_linked_receipts',(SELECT count(*) FROM public.material_receipts WHERE inventory_linked),
'receiving_entries',(SELECT count(*) FROM public.receiving_serial_entries),
'inventory_transactions',(SELECT count(*) FROM public.inventory_transactions),
'inventory_serials',(SELECT count(*) FROM public.inventory_serials),
'allocations',(SELECT count(*) FROM public.receiving_inventory_allocations)),
'violations',jsonb_build_object(
'receipt_source_orphans',(SELECT count(*) FROM public.material_receipts r LEFT JOIN public.project_materials m ON m.id=r.project_material_id LEFT JOIN public.se_supply_records s ON s.id=r.se_supply_record_id LEFT JOIN public.receiving_arrival_lines l ON l.id=r.arrival_line_id WHERE (r.source_type='PROJECT_MATERIAL' AND m.id IS NULL) OR (r.source_type='SE_SUPPLY' AND s.id IS NULL) OR (r.source_type='ARRIVAL' AND l.id IS NULL)),
'reversal_reference_mismatch',(SELECT count(*) FROM public.material_receipts r LEFT JOIN public.material_receipts p ON p.id=r.reversal_of_id WHERE r.event_type='REVERSAL' AND (p.id IS NULL OR p.event_type<>'RECEIVE' OR r.source_type<>p.source_type OR r.project_material_id IS DISTINCT FROM p.project_material_id OR r.se_supply_record_id IS DISTINCT FROM p.se_supply_record_id OR r.arrival_line_id IS DISTINCT FROM p.arrival_line_id)),
'over_reversed_receipts',(SELECT count(*) FROM effective_receipts WHERE quantity<0),
'receipt_transaction_orphans',(SELECT count(*) FROM public.material_receipts r LEFT JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id WHERE r.inventory_transaction_id IS NOT NULL AND t.id IS NULL),
'receipt_transaction_kind_mismatch',(SELECT count(*) FROM public.material_receipts r JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id WHERE r.event_type='RECEIVE' AND ((r.receipt_location='OFFICE' AND t.transaction_type<>'IN') OR (r.receipt_location='SITE' AND t.transaction_type<>'OUT'))),
'entry_source_orphans',(SELECT count(*) FROM public.receiving_serial_entries e LEFT JOIN public.project_materials m ON m.id=e.project_material_id LEFT JOIN public.se_supply_records s ON s.id=e.se_supply_record_id WHERE (e.project_material_id IS NOT NULL AND m.id IS NULL) OR (e.se_supply_record_id IS NOT NULL AND s.id IS NULL)),
'entry_serial_item_mismatch',(SELECT count(*) FROM public.receiving_serial_entries e LEFT JOIN public.inventory_serials s ON s.id=e.inventory_serial_id WHERE e.inventory_serial_id IS NOT NULL AND (s.id IS NULL OR s.item_id<>e.inventory_item_id)),
'entry_source_item_mismatch',(SELECT count(*) FROM public.receiving_serial_entries e LEFT JOIN public.project_materials m ON m.id=e.project_material_id LEFT JOIN public.se_supply_records s ON s.id=e.se_supply_record_id LEFT JOIN public.receiving_arrival_lines l ON l.id=e.arrival_line_id WHERE e.retired_at IS NULL AND COALESCE(m.inventory_item_id,s.inventory_item_id,l.inventory_item_id) IS DISTINCT FROM e.inventory_item_id),
'active_entry_receipt_mismatch',(SELECT count(*) FROM public.receiving_serial_entries e LEFT JOIN public.material_receipts r ON r.id=e.active_receipt_id WHERE e.active_receipt_id IS NOT NULL AND (r.id IS NULL OR r.event_type<>'RECEIVE' OR r.receipt_location IS DISTINCT FROM 'OFFICE' OR NOT r.inventory_linked OR e.retired_at IS NOT NULL OR e.project_material_id IS DISTINCT FROM r.project_material_id OR e.se_supply_record_id IS DISTINCT FROM r.se_supply_record_id OR e.arrival_line_id IS DISTINCT FROM r.arrival_line_id)),
'active_entry_missing_provenance',(SELECT count(*) FROM public.receiving_serial_entries e WHERE e.active_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.material_receipt_serials rs WHERE rs.receipt_id=e.active_receipt_id AND rs.entry_id=e.id AND rs.inventory_serial_id=e.inventory_serial_id)),
'receipt_serial_orphans',(SELECT count(*) FROM public.material_receipt_serials rs LEFT JOIN public.material_receipts r ON r.id=rs.receipt_id LEFT JOIN public.receiving_serial_entries e ON e.id=rs.entry_id LEFT JOIN public.inventory_serials s ON s.id=rs.inventory_serial_id WHERE r.id IS NULL OR e.id IS NULL OR s.id IS NULL),
'negative_inventory_balances',(SELECT count(*) FROM balances WHERE balance<0),
'duplicate_normalized_serials',(SELECT count(*) FROM (SELECT normalized_full FROM public.inventory_serials WHERE normalized_full IS NOT NULL GROUP BY normalized_full HAVING count(*)>1)s),
'duplicate_active_entry_serials',(SELECT count(*) FROM (SELECT inventory_serial_id FROM public.receiving_serial_entries WHERE active_receipt_id IS NOT NULL GROUP BY inventory_serial_id HAVING count(*)>1)s),
'duplicate_active_reservations',(SELECT count(*) FROM (SELECT inventory_serial_id FROM public.se_supply_records WHERE inventory_serial_id IS NOT NULL AND inventory_routed AND cancelled_at IS NULL AND replace_date IS NULL GROUP BY inventory_serial_id HAVING count(*)>1)s),
'transaction_serial_item_mismatch',(SELECT count(*) FROM public.inventory_transaction_serials ts JOIN public.inventory_transactions t ON t.id=ts.transaction_id JOIN public.inventory_serials s ON s.id=ts.serial_id WHERE t.item_id<>s.item_id),
'allocation_receipt_item_mismatch',(SELECT count(*) FROM public.receiving_inventory_allocations a LEFT JOIN public.material_receipts r ON r.id=a.office_receipt_id LEFT JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id WHERE r.id IS NULL OR r.event_type<>'RECEIVE' OR r.receipt_location IS DISTINCT FROM 'OFFICE' OR NOT r.inventory_linked OR (t.id IS NOT NULL AND t.item_id<>a.inventory_item_id)),
'over_allocated_receipts',(SELECT count(*) FROM (SELECT a.office_receipt_id FROM public.receiving_inventory_allocations a JOIN effective_receipts e ON e.id=a.office_receipt_id WHERE a.cancelled_at IS NULL GROUP BY a.office_receipt_id,e.quantity HAVING sum(a.quantity)>e.quantity)s),
'allocation_serial_mismatch',(SELECT count(*) FROM public.receiving_inventory_allocations a LEFT JOIN public.inventory_serials s ON s.id=a.inventory_serial_id WHERE a.inventory_serial_id IS NOT NULL AND (s.id IS NULL OR s.item_id<>a.inventory_item_id)),
'allocation_downstream_mismatch',(SELECT count(*) FROM public.receiving_inventory_allocations a LEFT JOIN public.se_supply_records s ON s.id=a.se_supply_record_id LEFT JOIN public.material_receipts r ON r.id=a.site_receipt_id LEFT JOIN public.inventory_transactions t ON t.id=a.inventory_transaction_id WHERE a.cancelled_at IS NULL AND ((a.route_type='SE' AND (s.id IS NULL OR s.inventory_serial_id IS DISTINCT FROM a.inventory_serial_id OR s.cancelled_at IS NOT NULL)) OR (a.route_type='SITE' AND (r.id IS NULL OR r.receipt_location IS DISTINCT FROM 'SITE' OR r.project_material_id IS DISTINCT FROM a.project_material_id OR t.id IS NULL OR t.is_voided OR t.transaction_type<>'OUT' OR t.item_id<>a.inventory_item_id)))),
'private_routing_context_leftovers',(SELECT count(*) FROM app_private.inventory_routing_context)
)) integrity
)

SELECT jsonb_build_object('counts',base.integrity->'counts','violations',(base.integrity->'violations')||jsonb_build_object(
 'serial_project_orphans',(SELECT count(*) FROM public.inventory_serials s LEFT JOIN public.projects p ON p.id=s.project_id WHERE s.project_id IS NOT NULL AND p.id IS NULL),
 'transaction_project_orphans',(SELECT count(*) FROM public.inventory_transactions s LEFT JOIN public.projects p ON p.id=s.project_id WHERE s.project_id IS NOT NULL AND p.id IS NULL),
 'material_project_orphans',(SELECT count(*) FROM public.project_materials s LEFT JOIN public.projects p ON p.id=s.project_id WHERE s.project_id IS NOT NULL AND p.id IS NULL),
 'se_project_orphans',(SELECT count(*) FROM public.se_supply_records s LEFT JOIN public.projects p ON p.id=s.project_id WHERE s.project_id IS NOT NULL AND p.id IS NULL),
 'arrival_line_orphans',(SELECT count(*) FROM public.receiving_arrival_lines l LEFT JOIN public.receiving_arrivals a ON a.id=l.arrival_id WHERE a.id IS NULL),
 'posted_arrival_receipt_mismatch',(SELECT count(*) FROM public.receiving_arrival_lines l LEFT JOIN public.material_receipts r ON r.id=l.receipt_id
  WHERE l.resolution_state='POSTED' AND (r.id IS NULL OR r.arrival_line_id IS DISTINCT FROM l.id OR r.event_type<>'RECEIVE'
   OR r.source_type<>'ARRIVAL' OR r.quantity_received<>l.quantity OR r.receipt_location IS DISTINCT FROM 'OFFICE' OR r.inventory_linked IS NOT TRUE)),
 'unknown_arrival_canonical_effect',(SELECT count(*) FROM public.receiving_arrival_lines l WHERE l.resolution_state='UNRESOLVED' AND
  (l.receipt_id IS NOT NULL OR l.posting_date IS NOT NULL OR EXISTS(SELECT 1 FROM public.receiving_serial_entries e WHERE e.arrival_line_id=l.id AND (e.inventory_serial_id IS NOT NULL OR e.active_receipt_id IS NOT NULL)))),
 'active_match_invalid_line',(SELECT count(*) FROM public.receiving_arrival_matches m LEFT JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id
  LEFT JOIN public.receiving_arrivals a ON a.id=l.arrival_id WHERE m.cancelled_at IS NULL AND (l.id IS NULL OR l.resolution_state<>'POSTED' OR a.id IS NULL OR a.voided_at IS NOT NULL)),
 'over_matched_arrival',(SELECT count(*) FROM (SELECT l.id FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id WHERE m.cancelled_at IS NULL GROUP BY l.id,l.quantity HAVING sum(m.quantity)>l.quantity) bad),
 'over_matched_pending',(SELECT count(*) FROM (SELECT m.project_material_id,m.se_supply_record_id FROM public.receiving_arrival_matches m
  LEFT JOIN public.project_materials p ON p.id=m.project_material_id LEFT JOIN public.se_supply_records s ON s.id=m.se_supply_record_id
  WHERE m.cancelled_at IS NULL GROUP BY m.project_material_id,m.se_supply_record_id,p.quantity,s.quantity HAVING sum(m.quantity)>COALESCE(p.quantity,s.quantity)) bad),
 'match_item_unit_mismatch',(SELECT count(*) FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id
  LEFT JOIN public.project_materials p ON p.id=m.project_material_id LEFT JOIN public.se_supply_records s ON s.id=m.se_supply_record_id
  WHERE m.cancelled_at IS NULL AND (COALESCE(p.inventory_item_id,s.inventory_item_id) IS DISTINCT FROM l.inventory_item_id OR COALESCE(p.unit,s.unit) IS DISTINCT FROM l.unit)),
 'match_project_conflict',(SELECT count(*) FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id JOIN public.receiving_arrivals a ON a.id=l.arrival_id
  LEFT JOIN public.project_materials p ON p.id=m.project_material_id LEFT JOIN public.se_supply_records s ON s.id=m.se_supply_record_id
  WHERE m.cancelled_at IS NULL AND a.project_id IS NOT NULL AND COALESCE(p.project_id,s.project_id) IS NOT NULL AND a.project_id<>COALESCE(p.project_id,s.project_id)),
 'match_serial_owner_mismatch',(SELECT count(*) FROM public.receiving_arrival_match_serials ms JOIN public.receiving_arrival_matches m ON m.id=ms.match_id
  LEFT JOIN public.receiving_serial_entries e ON e.id=ms.arrival_entry_id WHERE e.id IS NULL OR e.arrival_line_id IS DISTINCT FROM m.arrival_line_id),
 'match_serial_state_mismatch',(SELECT count(*) FROM public.receiving_arrival_match_serials ms JOIN public.receiving_arrival_matches m ON m.id=ms.match_id WHERE ms.cancelled_at IS DISTINCT FROM m.cancelled_at),
 'duplicate_active_actual_match_serial',(SELECT count(*) FROM (SELECT arrival_entry_id FROM public.receiving_arrival_match_serials WHERE cancelled_at IS NULL GROUP BY arrival_entry_id HAVING count(*)>1) bad),
 'duplicate_active_pending_match_serial',(SELECT count(*) FROM (SELECT pending_entry_id FROM public.receiving_arrival_match_serials WHERE cancelled_at IS NULL AND pending_entry_id IS NOT NULL GROUP BY pending_entry_id HAVING count(*)>1) bad),
 'match_serial_count_mismatch',(SELECT count(*) FROM public.receiving_arrival_matches m JOIN public.receiving_arrival_lines l ON l.id=m.arrival_line_id JOIN public.inventory_items i ON i.id=l.inventory_item_id
  WHERE m.cancelled_at IS NULL AND (SELECT count(*) FROM public.receiving_arrival_match_serials ms WHERE ms.match_id=m.id AND ms.cancelled_at IS NULL)<>CASE WHEN i.requires_serial THEN m.quantity ELSE 0 END),
 'pending_match_serial_owner_mismatch',(SELECT count(*) FROM public.receiving_arrival_match_serials ms JOIN public.receiving_arrival_matches m ON m.id=ms.match_id LEFT JOIN public.receiving_serial_entries e ON e.id=ms.pending_entry_id
  WHERE ms.pending_entry_id IS NOT NULL AND (e.id IS NULL OR e.project_material_id IS DISTINCT FROM m.project_material_id OR e.se_supply_record_id IS DISTINCT FROM m.se_supply_record_id)),
 'cancellation_fact_mismatch',(SELECT count(*) FROM public.activity_logs a
  LEFT JOIN public.project_materials p ON p.id::text=a.target_id AND a.changes->'after'->>'source_type'='PROJECT_MATERIAL'
  LEFT JOIN public.se_supply_records s ON s.id::text=a.target_id AND a.changes->'after'->>'source_type'='SE_SUPPLY'
  WHERE a.action='PENDING_REMAINING_CANCELLED' AND (COALESCE(p.quantity,s.quantity) IS DISTINCT FROM (a.changes->'after'->>'expected')::numeric
   OR COALESCE(p.receiving_archived_at,s.receiving_archived_at) IS NULL
   OR (a.changes->'after'->>'cancelled_remaining')::numeric IS DISTINCT FROM (a.changes->'after'->>'expected')::numeric-(a.changes->'after'->>'fulfilled_at_cancellation')::numeric)),
 'receiving_contract_context_leftovers',(SELECT count(*) FROM app_private.receiving_contract_context),
 'handoff_item_serial_shape',(SELECT count(*) FROM public.receiving_inventory_allocations a JOIN public.inventory_items i ON i.id=a.inventory_item_id
  WHERE i.requires_serial IS DISTINCT FROM (a.inventory_serial_id IS NOT NULL) OR a.inventory_serial_id IS NOT NULL AND a.quantity<>1),
 'handoff_active_se_quantity_item',(SELECT count(*) FROM public.receiving_inventory_allocations a JOIN public.se_supply_records s ON s.id=a.se_supply_record_id
  WHERE a.cancelled_at IS NULL AND (a.quantity IS DISTINCT FROM s.quantity OR a.inventory_item_id IS DISTINCT FROM s.inventory_item_id OR s.receiving_only)),
 'handoff_active_source_void',(SELECT count(*) FROM public.receiving_inventory_allocations x JOIN public.material_receipts r ON r.id=x.office_receipt_id
  LEFT JOIN public.receiving_arrival_lines l ON l.id=r.arrival_line_id LEFT JOIN public.receiving_arrivals a ON a.id=l.arrival_id
  LEFT JOIN public.inventory_transactions t ON t.id=r.inventory_transaction_id
  WHERE x.cancelled_at IS NULL AND (a.voided_at IS NOT NULL OR t.is_voided OR t.excluded_by_initialization_id IS NOT NULL)),
 'handoff_supersedes_provenance',(SELECT count(*) FROM public.receiving_inventory_allocations a LEFT JOIN public.receiving_inventory_allocations prior ON prior.id=a.supersedes_allocation_id
  WHERE a.supersedes_allocation_id IS NOT NULL AND (prior.id IS NULL OR prior.cancelled_at IS NULL OR prior.office_receipt_id<>a.office_receipt_id
   OR prior.se_supply_record_id IS DISTINCT FROM a.se_supply_record_id OR prior.route_type<>'SE' OR a.route_type<>'SE')),
 'handoff_reversal_provenance',(SELECT count(*) FROM public.receiving_inventory_allocations a LEFT JOIN public.material_receipts r ON r.id=a.reversal_receipt_id
  WHERE a.reversal_receipt_id IS NOT NULL AND (a.cancelled_at IS NULL OR a.route_type<>'SITE' OR r.event_type IS DISTINCT FROM 'REVERSAL'
   OR r.reversal_of_id IS DISTINCT FROM a.site_receipt_id OR r.inventory_transaction_id IS DISTINCT FROM a.inventory_transaction_id)),
 'handoff_nonserial_reserved_exceeds_inventory',(SELECT count(*) FROM public.inventory_items i WHERE NOT i.requires_serial
  AND app_private.receiving_reserved_quantity(i.id)>app_private.inventory_effective_balance(i.id))
)) integrity FROM base;
