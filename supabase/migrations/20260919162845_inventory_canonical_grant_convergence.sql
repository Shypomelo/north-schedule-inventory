-- Inventory client ACL convergence. See docs/inventory-grant-convergence.md.
-- Existing RLS, RPC bodies and service_role privileges are unchanged.
-- No application path needs anonymous table access or client schema privileges.
REVOKE SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON
  public.activity_logs,
  public.inventory_batches,
  public.inventory_initialization_items,
  public.inventory_initialization_serials,
  public.inventory_initializations,
  public.inventory_items,
  public.inventory_monthly_closing_items,
  public.inventory_monthly_closings,
  public.inventory_serials,
  public.inventory_transaction_serials,
  public.inventory_transactions
FROM PUBLIC,anon;
REVOKE TRUNCATE,REFERENCES,TRIGGER ON
  public.activity_logs,
  public.inventory_batches,
  public.inventory_initialization_items,
  public.inventory_initialization_serials,
  public.inventory_initializations,
  public.inventory_items,
  public.inventory_monthly_closing_items,
  public.inventory_monthly_closings,
  public.inventory_serials,
  public.inventory_transaction_serials,
  public.inventory_transactions
FROM authenticated;

-- Canonical RPC owns ledger, serial and initialization writes.
REVOKE INSERT,UPDATE,DELETE ON
  public.inventory_batches,
  public.inventory_initialization_items,
  public.inventory_initialization_serials,
  public.inventory_initializations,
  public.inventory_serials,
  public.inventory_transaction_serials,
  public.inventory_transactions
FROM authenticated;
REVOKE UPDATE,DELETE ON public.activity_logs FROM authenticated;

-- Preserve signed-in reads and the existing RLS-controlled non-ledger writes.
GRANT SELECT ON
  public.activity_logs,
  public.inventory_batches,
  public.inventory_initialization_items,
  public.inventory_initialization_serials,
  public.inventory_initializations,
  public.inventory_items,
  public.inventory_monthly_closing_items,
  public.inventory_monthly_closings,
  public.inventory_serials,
  public.inventory_transaction_serials,
  public.inventory_transactions
TO authenticated;
GRANT INSERT,UPDATE,DELETE ON public.inventory_items,
  public.inventory_monthly_closings,public.inventory_monthly_closing_items TO authenticated;
GRANT INSERT ON public.activity_logs TO authenticated;

-- Reassert canonical entry-point access without widening helper exposure.
REVOKE EXECUTE ON FUNCTION
  public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz),
  public.register_inventory_serial_atomic(text,uuid,uuid),
  public.delete_unlinked_inventory_serial_atomic(uuid),
  public.initialize_inventory(jsonb)
FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION
  public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz),
  public.register_inventory_serial_atomic(text,uuid,uuid),
  public.delete_unlinked_inventory_serial_atomic(uuid),
  public.initialize_inventory(jsonb)
TO authenticated;
