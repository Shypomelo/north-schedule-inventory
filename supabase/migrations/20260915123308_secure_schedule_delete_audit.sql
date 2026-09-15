-- Schedule history reuses the existing activity_logs.changes. Only ADMIN may read deletion
-- snapshots, and audit rows are append-only for authenticated application users.

DROP POLICY IF EXISTS "Enable read access for active members" ON public.activity_logs;

CREATE POLICY "Enable read access for active members"
ON public.activity_logs
FOR SELECT
TO authenticated
USING (
  app_private.is_active_member()
  AND (
    app_private.is_admin_member()
    OR NOT (
      target_type = 'ScheduleTask'
      AND COALESCE(action_type, action) = 'DELETE_TASK'
    )
  )
);

DROP POLICY IF EXISTS "Enable update access for editor members" ON public.activity_logs;
DROP POLICY IF EXISTS "Enable delete access for editor members" ON public.activity_logs;

REVOKE UPDATE, DELETE ON public.activity_logs FROM authenticated;

COMMENT ON POLICY "Enable read access for active members" ON public.activity_logs IS
  'Active members can read activity except Schedule DELETE_TASK snapshots, which are ADMIN-only.';

NOTIFY pgrst, 'reload schema';
