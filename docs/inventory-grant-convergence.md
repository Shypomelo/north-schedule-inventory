# Inventory CLIENT grant convergence evidence

Captured 2026-09-20 before changes. Candidate: fssogssryeunkjkdgewx; Production: dghozkqvxlwpjmgleekw. Release: 9206b99446074d7eaffc9b1b1625a04cf5fc1fb9.

## Source and required access

- Source B: `supabase/review/schema-bootstrap.sql:3310-3311` explicitly grants Candidate authenticated/service_role table CRUD and deliberately omits Production legacy anon/TRUNCATE/TRIGGER rights. Production and Candidate currently have identical broad public-schema default privileges for postgres/supabase_admin. Those defaults explain a plausible origin of the older Production grants; exact historical grant attribution is not retained by PostgreSQL ACLs.
- Source C: canonical migrations 20260918135747 and 20260918140309 revoke client ledger/serial/baseline DML and TRUNCATE, and restrict canonical RPC EXECUTE. They do not normalize every older table ACL.
- Path R: signed-in Inventory SELECT queries, including baseline and monthly records, in `src/lib/db/poc-supabase.ts`.
- Path I: item CRUD remains direct with existing RLS and opening-balance trigger.
- Path M: `createMonthlyClosingInSupabase` retains closing SELECT/INSERT/UPDATE and snapshot DELETE/INSERT. Existing Candidate CRUD retained; no redesign of monthly permissions.
- Path A: activity_logs SELECT and INSERT remain shared audit client paths; no client UPDATE/DELETE is required.
- Path C: transaction CREATE/EDIT/VOID use createInventoryAtomicWriter; serial registration/deletion use canonical RPC. Ledger, serial and initialization tables are client read-only.
- No SQL TRUNCATE call exists in App source. SQL migrations only revoke client TRUNCATE. REFERENCES/TRIGGER are schema privileges, not required by App runtime. RLS is not a justification for TRUNCATE.
- service_role table CRUD and RPC access remain backend access. Legacy service_role maintenance privileges are explicitly deferred and untouched; client-only convergence is authorized.

## Table matrix (before migration)

Y/N are explicit grants; tests additionally inspect effective privileges. Scope includes all 10 canonical Inventory tables plus activity_logs. Production-only entries: 108 (95 Inventory + 13 audit); no Candidate-only entries. Of these, 75 are anon/authenticated and 33 service_role.

| Object | Role | Privilege | Candidate | Production | Source | App requirement |
|---|---|---|---|---|---|---|
| activity_logs | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| activity_logs | anon | INSERT | N | Y | B / C | No anonymous Inventory path |
| activity_logs | anon | UPDATE | N | Y | B / C | No anonymous Inventory path |
| activity_logs | anon | DELETE | N | Y | B / C | No anonymous Inventory path |
| activity_logs | anon | TRUNCATE | N | Y | B / C | No anonymous Inventory path |
| activity_logs | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| activity_logs | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| activity_logs | authenticated | SELECT | Y | Y | B / C | R; preserve |
| activity_logs | authenticated | INSERT | Y | Y | B / C | A; preserve |
| activity_logs | authenticated | UPDATE | N | N | B / C | No audit edit/delete path |
| activity_logs | authenticated | DELETE | N | N | B / C | No audit edit/delete path |
| activity_logs | authenticated | TRUNCATE | N | Y | B / C | No runtime path |
| activity_logs | authenticated | REFERENCES | N | Y | B | No runtime path |
| activity_logs | authenticated | TRIGGER | N | Y | B | No runtime path |
| activity_logs | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| activity_logs | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| activity_logs | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| activity_logs | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| activity_logs | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| activity_logs | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| activity_logs | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_batches | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_batches | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_batches | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_batches | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_batches | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_batches | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_batches | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_batches | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_batches | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_batches | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_batches | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_batches | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_batches | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_batches | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_batches | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_batches | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_batches | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_batches | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_batches | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_batches | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_batches | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initialization_items | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_initialization_items | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_items | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_items | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_items | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_items | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_initialization_items | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_initialization_items | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_initialization_items | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_initialization_items | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_initialization_items | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_initialization_items | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_initialization_items | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_initialization_items | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_initialization_items | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_items | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_items | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_items | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_items | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initialization_items | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initialization_items | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initialization_serials | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_initialization_serials | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_serials | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_serials | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_serials | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_initialization_serials | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_initialization_serials | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_initialization_serials | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_initialization_serials | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_initialization_serials | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_initialization_serials | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_initialization_serials | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_initialization_serials | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_initialization_serials | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_initialization_serials | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_serials | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_serials | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_serials | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initialization_serials | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initialization_serials | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initialization_serials | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initializations | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_initializations | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_initializations | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_initializations | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_initializations | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_initializations | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_initializations | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_initializations | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_initializations | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_initializations | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_initializations | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_initializations | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_initializations | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_initializations | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_initializations | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initializations | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initializations | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initializations | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_initializations | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initializations | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_initializations | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_items | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_items | anon | INSERT | N | Y | B / C | No anonymous Inventory path |
| inventory_items | anon | UPDATE | N | Y | B / C | No anonymous Inventory path |
| inventory_items | anon | DELETE | N | Y | B / C | No anonymous Inventory path |
| inventory_items | anon | TRUNCATE | N | Y | B / C | No anonymous Inventory path |
| inventory_items | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_items | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_items | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_items | authenticated | INSERT | Y | Y | B / C | I; preserve |
| inventory_items | authenticated | UPDATE | Y | Y | B / C | I; preserve |
| inventory_items | authenticated | DELETE | Y | Y | B / C | I; preserve |
| inventory_items | authenticated | TRUNCATE | N | Y | B / C | No runtime path |
| inventory_items | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_items | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_items | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_items | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_items | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_items | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_items | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_items | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_items | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_monthly_closing_items | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closing_items | anon | INSERT | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closing_items | anon | UPDATE | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closing_items | anon | DELETE | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closing_items | anon | TRUNCATE | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closing_items | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_monthly_closing_items | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_monthly_closing_items | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_monthly_closing_items | authenticated | INSERT | Y | Y | B / C | M; preserve Candidate contract |
| inventory_monthly_closing_items | authenticated | UPDATE | Y | Y | B / C | M; preserve Candidate contract |
| inventory_monthly_closing_items | authenticated | DELETE | Y | Y | B / C | M; preserve Candidate contract |
| inventory_monthly_closing_items | authenticated | TRUNCATE | N | Y | B / C | No runtime path |
| inventory_monthly_closing_items | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_monthly_closing_items | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_monthly_closing_items | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closing_items | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closing_items | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closing_items | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closing_items | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_monthly_closing_items | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_monthly_closing_items | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_monthly_closings | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closings | anon | INSERT | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closings | anon | UPDATE | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closings | anon | DELETE | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closings | anon | TRUNCATE | N | Y | B / C | No anonymous Inventory path |
| inventory_monthly_closings | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_monthly_closings | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_monthly_closings | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_monthly_closings | authenticated | INSERT | Y | Y | B / C | M; preserve Candidate contract |
| inventory_monthly_closings | authenticated | UPDATE | Y | Y | B / C | M; preserve Candidate contract |
| inventory_monthly_closings | authenticated | DELETE | Y | Y | B / C | M; preserve Candidate contract |
| inventory_monthly_closings | authenticated | TRUNCATE | N | Y | B / C | No runtime path |
| inventory_monthly_closings | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_monthly_closings | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_monthly_closings | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closings | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closings | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closings | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_monthly_closings | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_monthly_closings | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_monthly_closings | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_serials | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_serials | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_serials | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_serials | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_serials | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_serials | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_serials | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_serials | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_serials | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_serials | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_serials | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_serials | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_serials | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_serials | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_serials | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_serials | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_serials | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_serials | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_serials | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_serials | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_serials | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_transaction_serials | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_transaction_serials | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_transaction_serials | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_transaction_serials | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_transaction_serials | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_transaction_serials | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_transaction_serials | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_transaction_serials | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_transaction_serials | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_transaction_serials | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_transaction_serials | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_transaction_serials | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_transaction_serials | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_transaction_serials | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_transaction_serials | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transaction_serials | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transaction_serials | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transaction_serials | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transaction_serials | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_transaction_serials | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_transaction_serials | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_transactions | anon | SELECT | N | Y | B / C | No anonymous Inventory path |
| inventory_transactions | anon | INSERT | N | N | B / C | No anonymous Inventory path |
| inventory_transactions | anon | UPDATE | N | N | B / C | No anonymous Inventory path |
| inventory_transactions | anon | DELETE | N | N | B / C | No anonymous Inventory path |
| inventory_transactions | anon | TRUNCATE | N | N | B / C | No anonymous Inventory path |
| inventory_transactions | anon | REFERENCES | N | Y | B | No anonymous Inventory path |
| inventory_transactions | anon | TRIGGER | N | Y | B | No anonymous Inventory path |
| inventory_transactions | authenticated | SELECT | Y | Y | B / C | R; preserve |
| inventory_transactions | authenticated | INSERT | N | N | B / C | C; RPC replaces client DML |
| inventory_transactions | authenticated | UPDATE | N | N | B / C | C; RPC replaces client DML |
| inventory_transactions | authenticated | DELETE | N | N | B / C | C; RPC replaces client DML |
| inventory_transactions | authenticated | TRUNCATE | N | N | B / C | No runtime path |
| inventory_transactions | authenticated | REFERENCES | N | Y | B | No runtime path |
| inventory_transactions | authenticated | TRIGGER | N | Y | B | No runtime path |
| inventory_transactions | service_role | SELECT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transactions | service_role | INSERT | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transactions | service_role | UPDATE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transactions | service_role | DELETE | Y | Y | B / C | Backend CRUD; preserve |
| inventory_transactions | service_role | TRUNCATE | N | Y | B / C | Untouched; DEFERRED SECURITY HARDENING |
| inventory_transactions | service_role | REFERENCES | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |
| inventory_transactions | service_role | TRIGGER | N | Y | B | Untouched; DEFERRED SECURITY HARDENING |

## Function EXECUTE matrix (before migration)

All listed function ACLs match. Existing helper exposure is recorded, not expanded or broadly cleaned up.

| Object | Role | Candidate | Production | Requirement |
|---|---|---|---|---|
| app_private.initialize_inventory(items jsonb) | PUBLIC | N | N | Canonical restricted entry/helper |
| app_private.initialize_inventory(items jsonb) | anon | N | N | Canonical restricted entry/helper |
| app_private.initialize_inventory(items jsonb) | authenticated | N | N | Canonical restricted entry/helper |
| app_private.initialize_inventory(items jsonb) | service_role | Y | Y | Canonical restricted entry/helper |
| app_private.protect_voided_inventory_serial_history() | PUBLIC | Y | Y | Existing read/helper contract; unchanged |
| app_private.protect_voided_inventory_serial_history() | anon | N | N | Existing read/helper contract; unchanged |
| app_private.protect_voided_inventory_serial_history() | authenticated | N | N | Existing read/helper contract; unchanged |
| app_private.protect_voided_inventory_serial_history() | service_role | N | N | Existing read/helper contract; unchanged |
| app_private.safely_void_inventory_in_transaction() | PUBLIC | Y | Y | Existing read/helper contract; unchanged |
| app_private.safely_void_inventory_in_transaction() | anon | N | N | Existing read/helper contract; unchanged |
| app_private.safely_void_inventory_in_transaction() | authenticated | N | N | Existing read/helper contract; unchanged |
| app_private.safely_void_inventory_in_transaction() | service_role | N | N | Existing read/helper contract; unchanged |
| public.classify_inventory_serial_format(p_serial text) | PUBLIC | Y | Y | Existing read/helper contract; unchanged |
| public.classify_inventory_serial_format(p_serial text) | anon | Y | Y | Existing read/helper contract; unchanged |
| public.classify_inventory_serial_format(p_serial text) | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.classify_inventory_serial_format(p_serial text) | service_role | Y | Y | Existing read/helper contract; unchanged |
| public.delete_unlinked_inventory_serial_atomic(p_serial_id uuid) | PUBLIC | N | N | Canonical restricted entry/helper |
| public.delete_unlinked_inventory_serial_atomic(p_serial_id uuid) | anon | N | N | Canonical restricted entry/helper |
| public.delete_unlinked_inventory_serial_atomic(p_serial_id uuid) | authenticated | Y | Y | Canonical restricted entry/helper |
| public.delete_unlinked_inventory_serial_atomic(p_serial_id uuid) | service_role | Y | Y | Canonical restricted entry/helper |
| public.derive_inventory_serial_short_key(p_serial text) | PUBLIC | Y | Y | Existing read/helper contract; unchanged |
| public.derive_inventory_serial_short_key(p_serial text) | anon | Y | Y | Existing read/helper contract; unchanged |
| public.derive_inventory_serial_short_key(p_serial text) | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.derive_inventory_serial_short_key(p_serial text) | service_role | Y | Y | Existing read/helper contract; unchanged |
| public.enforce_inventory_cutoff_guard() | PUBLIC | Y | Y | Existing read/helper contract; unchanged |
| public.enforce_inventory_cutoff_guard() | anon | Y | Y | Existing read/helper contract; unchanged |
| public.enforce_inventory_cutoff_guard() | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.enforce_inventory_cutoff_guard() | service_role | Y | Y | Existing read/helper contract; unchanged |
| public.initialize_inventory(items jsonb) | PUBLIC | N | N | Canonical restricted entry/helper |
| public.initialize_inventory(items jsonb) | anon | N | N | Canonical restricted entry/helper |
| public.initialize_inventory(items jsonb) | authenticated | Y | Y | Canonical restricted entry/helper |
| public.initialize_inventory(items jsonb) | service_role | Y | Y | Canonical restricted entry/helper |
| public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) | PUBLIC | N | N | Existing read/helper contract; unchanged |
| public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) | anon | N | N | Existing read/helper contract; unchanged |
| public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.lookup_inventory_serial(p_input text, p_item_id uuid, p_allowed_statuses text[]) | service_role | Y | Y | Existing read/helper contract; unchanged |
| public.normalize_inventory_serial(p_serial text) | PUBLIC | Y | Y | Existing read/helper contract; unchanged |
| public.normalize_inventory_serial(p_serial text) | anon | Y | Y | Existing read/helper contract; unchanged |
| public.normalize_inventory_serial(p_serial text) | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.normalize_inventory_serial(p_serial text) | service_role | Y | Y | Existing read/helper contract; unchanged |
| public.preview_inventory_initialization(items jsonb) | PUBLIC | N | N | Existing read/helper contract; unchanged |
| public.preview_inventory_initialization(items jsonb) | anon | N | N | Existing read/helper contract; unchanged |
| public.preview_inventory_initialization(items jsonb) | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.preview_inventory_initialization(items jsonb) | service_role | Y | Y | Existing read/helper contract; unchanged |
| public.register_inventory_serial_atomic(p_serial_no text, p_link_id uuid, p_batch_id uuid) | PUBLIC | N | N | Canonical restricted entry/helper |
| public.register_inventory_serial_atomic(p_serial_no text, p_link_id uuid, p_batch_id uuid) | anon | N | N | Canonical restricted entry/helper |
| public.register_inventory_serial_atomic(p_serial_no text, p_link_id uuid, p_batch_id uuid) | authenticated | Y | Y | Canonical restricted entry/helper |
| public.register_inventory_serial_atomic(p_serial_no text, p_link_id uuid, p_batch_id uuid) | service_role | Y | Y | Canonical restricted entry/helper |
| public.unseal_inventory_month(p_year text, p_month text) | PUBLIC | N | N | Existing read/helper contract; unchanged |
| public.unseal_inventory_month(p_year text, p_month text) | anon | N | N | Existing read/helper contract; unchanged |
| public.unseal_inventory_month(p_year text, p_month text) | authenticated | Y | Y | Existing read/helper contract; unchanged |
| public.unseal_inventory_month(p_year text, p_month text) | service_role | N | N | Existing read/helper contract; unchanged |
| public.write_inventory_transaction_atomic(p_action text, p_data jsonb, p_serials jsonb, p_transaction_id uuid, p_reason text, p_expected_updated_at timestamp with time zone) | PUBLIC | N | N | Canonical restricted entry/helper |
| public.write_inventory_transaction_atomic(p_action text, p_data jsonb, p_serials jsonb, p_transaction_id uuid, p_reason text, p_expected_updated_at timestamp with time zone) | anon | N | N | Canonical restricted entry/helper |
| public.write_inventory_transaction_atomic(p_action text, p_data jsonb, p_serials jsonb, p_transaction_id uuid, p_reason text, p_expected_updated_at timestamp with time zone) | authenticated | Y | Y | Canonical restricted entry/helper |
| public.write_inventory_transaction_atomic(p_action text, p_data jsonb, p_serials jsonb, p_transaction_id uuid, p_reason text, p_expected_updated_at timestamp with time zone) | service_role | Y | Y | Canonical restricted entry/helper |

## Approved scope and applied verification

The user approved client-only parity; service_role differences are retained as DEFERRED SECURITY HARDENING. No further scope decision is pending.

- Candidate: both migrations applied; canonical SQL/RLS and inventory-grants.sql PASS after both. OUT/ADJUST/Edit/Void/serial, Viewer denial, unsafe direct writes, item/monthly/audit operations and initialization reads tested with rolled-back fixtures.
- Production: same migrations applied after Candidate PASS; inventory-grants.sql PASS with rolled-back dedicated fixtures. Complete client table/function ACL comparison: zero differences.
- service_role table/function grants are byte-for-byte unchanged in each environment. Original 33 differences are retained.
- Full pg_class.relacl/aclexplode additionally revealed MAINTAIN, omitted by the previous information_schema.role_table_grants matrix. Before: 22 more client and 11 more service_role differences. Complete count is therefore 97 client + 44 service_role (original 33 plus 11 MAINTAIN). After: 0 client + 44 retained service_role differences. No service_role grants were changed or further investigated.
- MAINTAIN is database maintenance access (VACUUM/ANALYZE/REINDEX/CLUSTER); no App path requires it. [PostgreSQL 17 privilege reference](https://www.postgresql.org/docs/17/ddl-priv.html).
- 20260919162845_inventory_canonical_grant_convergence.sql is unchanged from the applied draft. Follow-up 20260920010142_inventory_client_maintenance_grants.sql explicitly revokes only PUBLIC/anon/authenticated MAINTAIN on the same 11 tables, preserving migration history and all service_role privileges.
- Production 11-table counts/fingerprints (10 Inventory + audit) unchanged; negative inventory 0, serial/item mismatch 0, initialization count 1.
- Node inventory-atomic.test.js 4/4 PASS; git diff --check and tsc --noEmit PASS. Prior full release gate remains valid; no production TS/TSX changed in this follow-up.
- Security advisors: existing set_updated_at mutable search path and disabled leaked-password protection remain outside this task. Authenticated SECURITY DEFINER warnings include intentionally gated canonical RPCs; Viewer/direct-write tests verify their authorization. No policy/function body was modified by these ACL migrations. [Search-path advisor](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [RPC advisor](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [password advisor](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Frontend release and Production UI/mutation smoke follow this DB gate and are reported separately.

## Supplemental MAINTAIN matrix (before convergence)

| Object | Role | Candidate | Production | Decision |
|---|---|---|---|---|
| activity_logs | anon | N | Y | Revoke; no App path |
| activity_logs | authenticated | N | Y | Revoke; no App path |
| activity_logs | service_role | N | Y | Untouched; deferred |
| inventory_batches | anon | N | Y | Revoke; no App path |
| inventory_batches | authenticated | N | Y | Revoke; no App path |
| inventory_batches | service_role | N | Y | Untouched; deferred |
| inventory_initialization_items | anon | N | Y | Revoke; no App path |
| inventory_initialization_items | authenticated | N | Y | Revoke; no App path |
| inventory_initialization_items | service_role | N | Y | Untouched; deferred |
| inventory_initialization_serials | anon | N | Y | Revoke; no App path |
| inventory_initialization_serials | authenticated | N | Y | Revoke; no App path |
| inventory_initialization_serials | service_role | N | Y | Untouched; deferred |
| inventory_initializations | anon | N | Y | Revoke; no App path |
| inventory_initializations | authenticated | N | Y | Revoke; no App path |
| inventory_initializations | service_role | N | Y | Untouched; deferred |
| inventory_items | anon | N | Y | Revoke; no App path |
| inventory_items | authenticated | N | Y | Revoke; no App path |
| inventory_items | service_role | N | Y | Untouched; deferred |
| inventory_monthly_closing_items | anon | N | Y | Revoke; no App path |
| inventory_monthly_closing_items | authenticated | N | Y | Revoke; no App path |
| inventory_monthly_closing_items | service_role | N | Y | Untouched; deferred |
| inventory_monthly_closings | anon | N | Y | Revoke; no App path |
| inventory_monthly_closings | authenticated | N | Y | Revoke; no App path |
| inventory_monthly_closings | service_role | N | Y | Untouched; deferred |
| inventory_serials | anon | N | Y | Revoke; no App path |
| inventory_serials | authenticated | N | Y | Revoke; no App path |
| inventory_serials | service_role | N | Y | Untouched; deferred |
| inventory_transaction_serials | anon | N | Y | Revoke; no App path |
| inventory_transaction_serials | authenticated | N | Y | Revoke; no App path |
| inventory_transaction_serials | service_role | N | Y | Untouched; deferred |
| inventory_transactions | anon | N | Y | Revoke; no App path |
| inventory_transactions | authenticated | N | Y | Revoke; no App path |
| inventory_transactions | service_role | N | Y | Untouched; deferred |
