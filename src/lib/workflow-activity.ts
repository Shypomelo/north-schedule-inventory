import { dbAdapter } from './db';
import type { ActivityLog } from './db/types';

export async function logWorkflowActivitySafely(
  log: Omit<ActivityLog, 'id' | 'created_at'>,
): Promise<void> {
  try {
    await dbAdapter.logActivity(log);
  } catch (error) {
    console.error('Workflow activity log failed:', error);
  }
}
