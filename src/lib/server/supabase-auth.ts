import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

type ActiveMember = {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  is_active: boolean;
  deleted_at: string | null;
};

export type ActiveTeamMemberContext = {
  supabase: ReturnType<typeof createUserScopedSupabaseClient>;
  email: string;
  member: ActiveMember;
};

const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || '';

const jsonError = (message: string, status: number) => NextResponse.json(
  { success: false, error: message },
  { status },
);

const getBearerToken = (req: Request): string | null => {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

const createUserScopedSupabaseClient = (accessToken: string) => {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
};

export async function requireActiveTeamMember(
  req: Request,
): Promise<{ context: ActiveTeamMemberContext; error: null } | { context: null; error: NextResponse }> {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    return { context: null, error: jsonError('Missing authorization token', 401) };
  }

  let supabase;
  try {
    supabase = createUserScopedSupabaseClient(accessToken);
  } catch (error: any) {
    return { context: null, error: jsonError(error.message || 'Supabase is not configured', 500) };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !user?.email) {
    return { context: null, error: jsonError('Invalid authorization token', 401) };
  }

  const sessionEmail = normalizeEmail(user.email);
  const { data: members, error: memberError } = await supabase
    .from('team_members')
    .select('id, email, name, role, is_active, deleted_at')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (memberError) {
    return { context: null, error: jsonError('Failed to verify team member access', 500) };
  }

  const member = members?.find((candidate: ActiveMember) => normalizeEmail(candidate.email) === sessionEmail);

  if (!member) {
    return { context: null, error: jsonError('User is not an active team member', 403) };
  }

  return {
    context: {
      supabase,
      email: user.email,
      member: member as ActiveMember,
    },
    error: null,
  };
}

export async function requireAdminTeamMember(
  req: Request,
): Promise<{ context: ActiveTeamMemberContext; error: null } | { context: null; error: NextResponse }> {
  const result = await requireActiveTeamMember(req);
  if (result.error) return result;

  if (result.context.member.role?.toLowerCase() !== 'admin') {
    return { context: null, error: jsonError('Admin access is required', 403) };
  }

  return result;
}
