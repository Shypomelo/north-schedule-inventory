# Candidate Review Environment

This directory is intentionally separate from `supabase/migrations`. It defines a repeatable review-only environment for project `fssogssryeunkjkdgewx` and must never be included in a Production `db push`.

## Guard model

Two independent guards are required before a mutation:

1. `scripts/candidate-review.mjs` rejects every project ref except `fssogssryeunkjkdgewx`, and explicitly rejects Production `dghozkqvxlwpjmgleekw`.
2. The remote database must contain the Candidate-only migration fingerprint `candidate_review_production_shape_baseline`. The schema bootstrap also creates `review_private.environment_guard`; fixture and cleanup scripts refuse to run without the exact Candidate ref stored there.

No SQL file contains an access token, database password, OAuth secret, Vault value, Google credential, or Production business row.

## Files

- `schema-bootstrap.sql`: idempotent Candidate schema alignment generated from the current Production catalog plus repo canonical definitions.
- `fixtures.sql`: deterministic `REVIEW_` / `CANDIDATE_` fixtures.
- `cleanup.sql`: removes only fixed review fixture IDs/prefixes. Do not run before manual review.
- `contract-snapshot.sql`: read-only machine snapshot used by parity comparison.
- `contract-verification.sql`: read-only required-object and fixture checks.
- `parity-report.json`: machine-readable initial drift audit.
- `parity-report.final.json`: post-bootstrap semantic parity result and documented security deltas.

## Run

Use a Supabase personal access token with the minimum required scope. The token is read only from the process environment.

```powershell
$env:SUPABASE_PROJECT_REF = 'fssogssryeunkjkdgewx'
$env:SUPABASE_ACCESS_TOKEN = '<temporary token>'

node scripts/candidate-review.mjs bootstrap
node scripts/candidate-review.mjs fixtures
node scripts/candidate-review.mjs verify
node scripts/schema-parity.mjs > supabase/review/parity-report.final.json
```

The `verify` and parity commands use the Management API read-only SQL endpoint. Production is accessed only by the parity command and only through that read-only endpoint.

Cleanup is explicit and separate:

```powershell
node scripts/candidate-review.mjs cleanup
```

## Idempotency

`bootstrap` uses `IF NOT EXISTS`, exact replacement of functions/policies/triggers, and deterministic grants. `fixtures` uses fixed UUIDs and upserts. Re-running either command converges on the same schema/data shape without duplicating fixtures.
