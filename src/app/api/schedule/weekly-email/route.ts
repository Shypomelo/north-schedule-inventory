import { handleWeeklyScheduleEmail } from '@/lib/server/weekly-schedule-email';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return handleWeeklyScheduleEmail(req);
}
