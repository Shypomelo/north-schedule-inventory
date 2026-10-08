-- Candidate fix for Supabase's explicit anon default function grants.
-- Also harmless when the preceding migration already revoked these grants.
REVOKE ALL ON FUNCTION app_private.se_sync_allowed() FROM anon;
REVOKE ALL ON FUNCTION public.se_sync_reserve(text, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.se_sync_fail(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.se_sync_apply(uuid, jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.se_set_case_scope_rule(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.se_confirm_order_scope(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.se_link_order_item(uuid, text, uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.se_unlink_order_item(uuid) FROM anon;
