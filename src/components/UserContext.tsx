"use client";

import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { supabase } from '@/lib/db/supabaseClient';

interface UserContextType {
  currentUser: User | null;
  allUsers: User[];
  setCurrentUser: (user: User | null) => void;
  isLoading: boolean;
  authError: string | null;
  loginWithGoogle: (nextPath?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);
const DEFAULT_PRODUCTION_SITE_URL = 'https://north-schedule-inventory.vercel.app';
const INTENDED_PATH_STORAGE_KEY = 'north-schedule-intended-path';

const getSafeNextPath = (value?: string | null) => {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value === '/login' || value.startsWith('/login?')) return '/';
  return value;
};

const getCanonicalSiteOrigin = () => {
  const configuredSiteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_SITE_URL : '');

  if (!configuredSiteUrl) return null;

  try {
    return new URL(configuredSiteUrl).origin;
  } catch {
    return null;
  }
};

const shouldRedirectToCanonicalOrigin = (canonicalOrigin: string) => {
  if (typeof window === 'undefined') return false;
  if (window.location.origin === canonicalOrigin) return false;

  return (
    process.env.NODE_ENV === 'production' &&
    window.location.hostname.startsWith('north-schedule-inventory-') &&
    window.location.hostname.endsWith('.vercel.app')
  );
};

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const canonicalOrigin = getCanonicalSiteOrigin();
    if (canonicalOrigin && shouldRedirectToCanonicalOrigin(canonicalOrigin)) {
      window.location.replace(
        `${canonicalOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`
      );
      return;
    }

    let mounted = true;

    async function loadUsersAndHandleSession(session: any) {
      try {
        const users = await dbAdapter.getUsers();
        if (mounted) {
          setAllUsers(users);
          if (session?.user?.email) {
            const foundUser = users.find((u: User) => u.email === session.user.email);
            if (!foundUser) {
              setAuthError('此 Google 帳號尚未被授權，請聯絡管理者');
              setCurrentUser(null);
              supabase.auth.signOut();
            } else if (!foundUser.is_active) {
              setAuthError('此帳號已停用');
              setCurrentUser(null);
              supabase.auth.signOut();
            } else {
              setAuthError(null);
              setCurrentUser(foundUser);
            }
          } else {
            setCurrentUser(null);
          }
          setIsLoading(false);
        }
      } catch (error) {
        console.error("Auth init error:", error);
        if (mounted) setIsLoading(false);
      }
    }

    // Initial check
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (mounted) loadUsersAndHandleSession(session);
    }).catch((err) => {
      console.error("Auth init error:", err);
      if (mounted) setIsLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      
      if (event === 'SIGNED_IN') {
        setIsLoading(true);
        setTimeout(() => {
          if (mounted) loadUsersAndHandleSession(session);
        }, 0);
      } else if (event === 'SIGNED_OUT') {
        setCurrentUser(null);
        setAuthError(null);
        setIsLoading(false);
      }
    });

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only on mount

  const loginWithGoogle = async (nextPath?: string) => {
    setIsLoading(true);
    setAuthError(null);
    try {
      const redirectOrigin = getCanonicalSiteOrigin() || window.location.origin;
      const safeNextPath = getSafeNextPath(nextPath);
      sessionStorage.setItem(INTENDED_PATH_STORAGE_KEY, safeNextPath);
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${redirectOrigin}/login?next=${encodeURIComponent(safeNextPath)}`,
        },
      });
    } catch (error) {
      console.error('Login error:', error);
      setAuthError('登入過程發生錯誤');
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await supabase.auth.signOut();
      setCurrentUser(null);
      setAuthError(null);
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <UserContext.Provider value={{ 
      currentUser, 
      allUsers, 
      setCurrentUser, 
      isLoading,
      authError,
      loginWithGoogle,
      logout
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
