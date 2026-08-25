CREATE UNIQUE INDEX schedule_tasks_google_calendar_event_unique_idx
ON public.schedule_tasks (google_calendar_id, google_event_id)
WHERE google_event_id IS NOT NULL;
