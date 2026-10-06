import { handleWeeklyScheduleEmailConfig } from '@/lib/server/weekly-schedule-email';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return handleWeeklyScheduleEmailConfig(req);
}
