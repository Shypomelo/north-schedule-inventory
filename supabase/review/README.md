# Candidate Production-like Review Environment

This directory is intentionally separate from `supabase/migrations`. It refreshes only project `fssogssryeunkjkdgewx` from a read-only business-data snapshot of Production `dghozkqvxlwpjmgleekw`. It must never be included in a Production `db push`.

## Safety model

- `scripts/candidate-review.mjs` rejects every mutation target except Candidate and explicitly rejects Production.
- Every Production SQL request uses the Management API `/database/query/read-only` endpoint.
- Candidate mutations additionally require both the `candidate_review_production_shape_baseline` migration fingerprint and `review_private.environment_guard`.
- Snapshot data exists only in process memory. It is never written to the repo, logs, or a reusable dump file.
- The allowlist contains only `public` App business/configuration tables. `auth`, Storage, Vault, secrets, logs, and platform configuration are never exported.
- Refresh is one Candidate transaction. It uses `DELETE`, not `TRUNCATE`, and rolls back fully on failure. Triggers are disabled only for that transaction; FK/data equality is verified afterward.
- Candidate safety overrides require zero active database cron jobs, disable Google-enabled work groups, and fail if an App-owned database routine can invoke an external network function. `pg_net` stays installed for schema parity but is outside the App's exposed API schemas.
- App server routes independently deny external mutation unless their Supabase URL resolves to the exact Production project ref. Candidate and unknown environments fail closed.

## Files

- `schema-bootstrap.sql`: previously verified Candidate schema parity baseline. Do not rerun unless a schema audit explicitly requires it.
- `cleanup.sql`: legacy, narrowly-scoped removal of the old deterministic fixtures.
- `candidate-safety-overrides.sql`: Candidate-only database external-side-effect controls embedded in every refresh transaction.
- `contract-snapshot.sql`: read-only schema snapshot used by parity comparison.
- `contract-verification.sql`: read-only Candidate object, safety, Auth-link, and baseline checks.
- `parity-report.final.json`: last schema-parity result, with documented intentional security deltas.

The former fixture installer was removed. Production-like review data now comes only from the allowlisted Production snapshot.

## Refresh

Use a short-lived Supabase personal access token with the minimum required scope. The token is read only from the process environment.

```powershell
$env:SUPABASE_PROJECT_REF = 'fssogssryeunkjkdgewx'
$env:SUPABASE_ACCESS_TOKEN = '<temporary token>'

node scripts/candidate-review.mjs refresh
node scripts/candidate-review.mjs verify
node scripts/candidate-review.mjs verify-data
node scripts/schema-parity.mjs
```

`refresh` performs these phases:

1. Verify source/target constants and Candidate fingerprints.
2. Compare allowlisted table metadata with Production.
3. Read Production rows only through the read-only endpoint.
4. Capture a Candidate `auth.users` ID fingerprint without exporting Auth data.
5. Replace Candidate business rows in one rollback-safe transaction.
6. Apply Candidate safety overrides.
7. Re-read both databases and require exact row equality after the documented Google-sync override.
8. Require Candidate Auth to be unchanged and all old fixture IDs to be absent.

The copied UUIDs and relationship columns are preserved verbatim. Candidate Google OAuth remains independent; application identity is matched to `team_members` through normalized email.

## Local Candidate setting

The project-ref guard is sufficient by itself. For defense in depth, local and hosted Candidate environments should also define:

```text
DISABLE_EXTERNAL_SIDE_EFFECTS=true
```

Do not set Production connection strings, service-role secrets, OAuth client secrets, webhook secrets, or external API secrets in this directory.
