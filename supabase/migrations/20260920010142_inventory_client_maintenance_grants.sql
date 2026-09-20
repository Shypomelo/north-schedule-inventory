-- PostgreSQL 17+ MAINTAIN is omitted by information_schema.role_table_grants.
-- The App uses SELECT/DML or RPC, never VACUUM/ANALYZE/REINDEX/CLUSTER.
-- Client maintenance access is not part of the Inventory runtime contract.
-- Retain every service_role grant; do not alter default privileges.
REVOKE MAINTAIN ON
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
FROM PUBLIC,anon,authenticated;
