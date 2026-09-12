import type { User } from './db/types';

export const AUTH_INITIALIZATION_TIMEOUT_MS = 12_000;

export interface AuthSessionLike {
  user?: { email?: string | null } | null;
}

export interface AuthSessionResult {
  data: { session: AuthSessionLike | null };
  error?: unknown;
}

export type AuthResolution = {
  status: 'authenticated';
  currentUser: User;
  allUsers: User[];
  error: null;
  shouldClearLocalSession: false;
} | {
  status: 'logged-out';
  currentUser: null;
  allUsers: User[];
  error: null;
  shouldClearLocalSession: false;
} | {
  status: 'error';
  currentUser: null;
  allUsers: User[];
  error: string;
  shouldClearLocalSession: boolean;
};

const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || '';

const errorText = (error: unknown) => {
  if (!error || typeof error !== 'object') return String(error || '');
  const record = error as Record<string, unknown>;
  return [record.name, record.code, record.message].filter(Boolean).join(' ').toLowerCase();
};

export const isInvalidStoredSessionError = (error: unknown) => {
  const text = errorText(error);
  return text.includes('refresh_token_not_found')
    || text.includes('invalid refresh token')
    || text.includes('refresh token not found')
    || text.includes('invalid jwt')
    || text.includes('jwt expired');
};

export function withAuthFailureTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function resolveAuthSession(
  session: AuthSessionLike | null,
  loadUsers: () => Promise<User[]>,
  timeoutMs = AUTH_INITIALIZATION_TIMEOUT_MS,
): Promise<AuthResolution> {
  if (!session) {
    return { status: 'logged-out', currentUser: null, allUsers: [], error: null, shouldClearLocalSession: false };
  }

  const sessionEmail = normalizeEmail(session.user?.email);
  if (!sessionEmail) {
    return {
      status: 'error',
      currentUser: null,
      allUsers: [],
      error: '登入狀態無效，請重新登入',
      shouldClearLocalSession: true,
    };
  }

  try {
    const users = await withAuthFailureTimeout(loadUsers(), timeoutMs, '成員資料驗證逾時');
    const foundUser = users.find(user => normalizeEmail(user.email) === sessionEmail);
    if (!foundUser) {
      return {
        status: 'error',
        currentUser: null,
        allUsers: users,
        error: '此 Google 帳號尚未被授權，請聯絡管理者',
        shouldClearLocalSession: true,
      };
    }
    if (!foundUser.is_active) {
      return {
        status: 'error',
        currentUser: null,
        allUsers: users,
        error: '此帳號已停用',
        shouldClearLocalSession: true,
      };
    }
    return {
      status: 'authenticated',
      currentUser: foundUser,
      allUsers: users,
      error: null,
      shouldClearLocalSession: false,
    };
  } catch (error) {
    console.error('Member lookup error:', error);
    return {
      status: 'error',
      currentUser: null,
      allUsers: [],
      error: errorText(error).includes('逾時') ? '登入身分驗證逾時，請檢查網路後重試' : '無法驗證登入身分，請稍後重試',
      shouldClearLocalSession: false,
    };
  }
}

export async function initializeAuth(
  getSession: () => Promise<AuthSessionResult>,
  loadUsers: () => Promise<User[]>,
  timeoutMs = AUTH_INITIALIZATION_TIMEOUT_MS,
): Promise<AuthResolution> {
  try {
    const result = await withAuthFailureTimeout(getSession(), timeoutMs, '登入狀態初始化逾時');
    if (result.error) {
      const invalid = isInvalidStoredSessionError(result.error);
      return {
        status: 'error',
        currentUser: null,
        allUsers: [],
        error: invalid ? '登入狀態已失效，請重新登入' : '無法讀取登入狀態，請稍後重試',
        shouldClearLocalSession: invalid,
      };
    }
    return resolveAuthSession(result.data.session, loadUsers, timeoutMs);
  } catch (error) {
    console.error('Auth initialization error:', error);
    return {
      status: 'error',
      currentUser: null,
      allUsers: [],
      error: errorText(error).includes('逾時') ? '登入狀態初始化逾時，請檢查網路後重試' : '無法讀取登入狀態，請稍後重試',
      shouldClearLocalSession: isInvalidStoredSessionError(error),
    };
  }
}

export async function resolveAuthStateChange(
  event: string,
  session: AuthSessionLike | null,
  loadUsers: () => Promise<User[]>,
  timeoutMs = AUTH_INITIALIZATION_TIMEOUT_MS,
): Promise<AuthResolution | null> {
  if (event === 'SIGNED_OUT') {
    return { status: 'logged-out', currentUser: null, allUsers: [], error: null, shouldClearLocalSession: false };
  }
  if (event === 'SIGNED_IN') return resolveAuthSession(session, loadUsers, timeoutMs);
  return null;
}

export function getSafeNextPath(value?: string | null) {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value === '/login' || value.startsWith('/login?')) return '/';
  return value;
}

export function selectLoginNextPath(queryNext?: string | null, storedNext?: string | null) {
  const safeQuery = getSafeNextPath(queryNext);
  return safeQuery !== '/' ? safeQuery : getSafeNextPath(storedNext);
}

export function buildOAuthRedirectUrl(origin: string, nextPath?: string | null) {
  return `${origin}/login?next=${encodeURIComponent(getSafeNextPath(nextPath))}`;
}
