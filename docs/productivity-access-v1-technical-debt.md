# Productivity & Access V1 technical debt

## Corrected RCA: `tool_links` PGRST205 on Preview

- **False RCA:** the Candidate `public.tool_links` table was missing from the PostgREST schema cache. The previous note proposed a schema reload migration or release step on that basis.
- Candidate project `fssogssryeunkjkdgewx` has `public.tool_links`, and its PostgREST schema reload passed.
- The failing request actually went to Production project `dghozkqvxlwpjmgleekw`. Production does not have `tool_links`, so its PostgREST response was `PGRST205`.
- Root cause: a stale Preview deployment or Preview environment mismatch routed the request to Production.
- The `north-schedule-inventory` branch-specific Preview override remains cleanup debt. Review and remove that override after the Preview deployment and environment are confirmed to target Candidate.

The existing `supabase/migrations/20261004110000_productivity_tool_links.sql` must remain unchanged. No follow-up schema reload migration is needed for this incident.
