-- Add Google Calendar Sync Columns to schedule_tasks
-- These columns match the TypeScript definitions in src/lib/db/types.ts

ALTER TABLE public.schedule_tasks
  ADD COLUMN IF NOT EXISTS google_calendar_id text,
  ADD COLUMN IF NOT EXISTS google_event_id text,
  ADD COLUMN IF NOT EXISTS google_sync_status text CHECK (google_sync_status IN ('pending', 'synced', 'failed')),
  ADD COLUMN IF NOT EXISTS google_sync_error text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

-- Notify PostgREST to reload the schema cache so the API can see the new columns immediately
NOTIFY pgrst, 'reload schema';
