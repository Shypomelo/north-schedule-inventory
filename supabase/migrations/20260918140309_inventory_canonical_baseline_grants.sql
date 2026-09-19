-- Baseline rows reinterpret effective stock. Only the existing gated initialization RPC may write them.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.inventory_initializations,public.inventory_initialization_items,public.inventory_initialization_serials FROM PUBLIC,anon,authenticated;
REVOKE TRUNCATE ON public.inventory_transactions,public.inventory_serials,public.inventory_transaction_serials,public.inventory_batches FROM PUBLIC,anon,authenticated;
ALTER TABLE public.inventory_initializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initialization_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_initialization_serials ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_initializations_member_read ON public.inventory_initializations FOR SELECT TO authenticated USING ((SELECT app_private.is_active_member()));
CREATE POLICY inventory_initialization_items_member_read ON public.inventory_initialization_items FOR SELECT TO authenticated USING ((SELECT app_private.is_active_member()));
CREATE POLICY inventory_initialization_serials_member_read ON public.inventory_initialization_serials FOR SELECT TO authenticated USING ((SELECT app_private.is_active_member()));
NOTIFY pgrst,'reload schema';
