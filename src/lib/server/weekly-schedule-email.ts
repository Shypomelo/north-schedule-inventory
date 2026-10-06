import { requireActiveTeamMember } from '@/lib/server/supabase-auth';

export const MAX_WEEKLY_PNG_BYTES = 4 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_WEEKLY_PNG_BYTES + 128 * 1024;
const PRODUCTION_SUPABASE_URL = 'https://dghozkqvxlwpjmgleekw.supabase.co';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

type Environment = Record<string, string | undefined>;
type Dependencies = {
  requireMember?: typeof requireActiveTeamMember;
  send?: typeof fetch;
  env?: Environment;
};

export async function handleWeeklyScheduleEmailConfig(req: Request, deps: Pick<Dependencies, 'requireMember' | 'env'> = {}): Promise<Response> {
  const { context, error } = await (deps.requireMember ?? requireActiveTeamMember)(req);
  if (error) return failure(error.status === 401 ? 'UNAUTHORIZED' : error.status === 403 ? 'FORBIDDEN' : 'AUTH_CHECK_FAILED', error.status);
  if (!context || !['ADMIN', 'ENGINEER', 'VIEWER'].includes(context.member.role?.toUpperCase() || '')) return failure('FORBIDDEN', 403);

  const defaultRecipient = (deps.env ?? process.env).WEEKLY_EMAIL_DEFAULT_TO?.trim() || '';
  if (defaultRecipient && !isValidWeeklyRecipient(defaultRecipient)) return failure('INVALID_DEFAULT_RECIPIENT', 503);
  return Response.json({ defaultRecipient });
}

const failure = (code: string, status: number) => Response.json({ success: false, error: code }, { status });

export function isValidWeeklyRecipient(value: string): boolean {
  return value.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
}

export function parseWeekStart(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime())
    && date.toISOString().slice(0, 10) === value
    && date.getUTCDay() === 1 ? date : null;
}

export function weeklyEmailContent(weekStart: Date) {
  const end = new Date(weekStart);
  end.setUTCDate(end.getUTCDate() + 5);
  const isoStart = weekStart.toISOString().slice(0, 10);
  const isoEnd = end.toISOString().slice(0, 10);
  return {
    subject: `北部工程週排程｜${isoStart.replaceAll('-', '/')} - ${isoEnd.replaceAll('-', '/')}`,
    text: '附件為本週工程排程，請查收。',
    filename: `北部工程週排程_${isoStart}.png`,
  };
}

export async function handleWeeklyScheduleEmail(req: Request, deps: Dependencies = {}): Promise<Response> {
  const requireMember = deps.requireMember ?? requireActiveTeamMember;
  const { context, error: authResponse } = await requireMember(req);
  if (authResponse) return failure(
    authResponse.status === 401 ? 'UNAUTHORIZED' : authResponse.status === 403 ? 'FORBIDDEN' : 'AUTH_CHECK_FAILED',
    authResponse.status,
  );
  if (!context) return failure('UNAUTHORIZED', 401);

  const role = context.member.role?.toUpperCase();
  if (role !== 'ADMIN' && role !== 'ENGINEER' && role !== 'VIEWER') return failure('FORBIDDEN', 403);

  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) return failure('IMAGE_TOO_LARGE', 413);
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return failure('INVALID_IMAGE', 400);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return failure('INVALID_REQUEST', 400);
  }

  const recipientValue = form.get('recipient');
  const weekStartValue = form.get('weekStart');
  const workGroupValue = form.get('workGroupId');
  const image = form.get('image');
  const env = deps.env ?? process.env;
  const recipient = typeof recipientValue === 'string' ? recipientValue.trim() : (env.WEEKLY_EMAIL_DEFAULT_TO?.trim() || '');
  const weekStart = typeof weekStartValue === 'string' ? parseWeekStart(weekStartValue) : null;
  if (!isValidWeeklyRecipient(recipient)) return failure('INVALID_EMAIL', 400);
  if (!weekStart) return failure('INVALID_WEEK_START', 400);
  if (workGroupValue !== null && (typeof workGroupValue !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workGroupValue))) {
    return failure('FORBIDDEN', 403);
  }
  if (!(image instanceof File) || image.type !== 'image/png') return failure('INVALID_IMAGE', 400);
  if (image.size > MAX_WEEKLY_PNG_BYTES) return failure('IMAGE_TOO_LARGE', 413);
  if (image.size < PNG_SIGNATURE.length) return failure('INVALID_IMAGE', 400);

  const bytes = Buffer.from(await image.arrayBuffer());
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return failure('INVALID_IMAGE', 400);

  if (typeof workGroupValue === 'string') {
    const { data: group, error: groupError } = await context.supabase
      .from('work_groups').select('id').eq('id', workGroupValue).eq('is_active', true).maybeSingle();
    if (groupError || !group) return failure('FORBIDDEN', 403);
    if (role !== 'ADMIN') {
      const { data: membership, error: membershipError } = await context.supabase
        .from('member_work_groups').select('work_group_id')
        .eq('member_id', context.member.id).eq('work_group_id', workGroupValue).maybeSingle();
      if (membershipError || !membership) return failure('FORBIDDEN', 403);
    }
  }

  const content = weeklyEmailContent(weekStart);
  const payload = {
    from: env.WEEKLY_EMAIL_FROM || '',
    to: recipient,
    subject: content.subject,
    text: content.text,
    attachments: [{ filename: content.filename, content: bytes.toString('base64'), content_type: 'image/png' }],
  };
  const explicitlyDisabled = /^(1|true|yes|on)$/i.test(env.DISABLE_EXTERNAL_SIDE_EFFECTS?.trim() || '');
  if (env.VERCEL_ENV !== 'production' || env.NEXT_PUBLIC_SUPABASE_URL !== PRODUCTION_SUPABASE_URL || explicitlyDisabled) {
    return Response.json({ success: true, dryRun: true });
  }
  if (env.WEEKLY_EMAIL_ENABLED !== 'true') return failure('EMAIL_DISABLED', 503);
  if (!env.RESEND_API_KEY || !env.WEEKLY_EMAIL_FROM) return failure('EMAIL_NOT_CONFIGURED', 503);

  try {
    const response = await (deps.send ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return failure('EMAIL_PROVIDER_FAILED', 502);
    return Response.json({ success: true, dryRun: false });
  } catch {
    return failure('EMAIL_PROVIDER_FAILED', 502);
  }
}
