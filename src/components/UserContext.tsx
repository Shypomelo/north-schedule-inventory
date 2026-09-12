"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { User } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { supabase } from '@/lib/db/supabaseClient';
import {
  buildOAuthRedirectUrl,
  AUTH_INITIALIZATION_TIMEOUT_MS,
  getSafeNextPath,
  initializeAuth,
  resolveAuthStateChange,
  type AuthResolution,
  withAuthFailureTimeout,
} from '@/lib/auth-lifecycle';

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
const INTENDED_PATH_STORAGE_KEY = 'north-schedule-intended-path';

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const preserveNextSignOutError = useRef(false);

  useEffect(() => {
    let mounted = true;
    let operation = 0;

    const applyResolution = (resolution: AuthResolution, operationId: number) => {
      if (!mounted || operationId !== operation) return;
      setAllUsers(resolution.allUsers);
      setCurrentUser(resolution.currentUser);
      setAuthError(resolution.error);
      setIsLoading(false);
      if (resolution.shouldClearLocalSession) {
        preserveNextSignOutError.current = true;
        void supabase.auth.signOut({ scope: 'local' }).catch(error => {
          console.error('Local session cleanup error:', error);
        });
      }
    };

    const runResolution = (factory: () => Promise<AuthResolution>) => {
      const operationId = ++operation;
      void factory().then(resolution => applyResolution(resolution, operationId));
    };

    runResolution(() => initializeAuth(
      () => supabase.auth.getSession(),
      () => dbAdapter.getUsers(),
    ));

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

      if (event === 'SIGNED_IN') {
        setIsLoading(true);
        setTimeout(() => {
          if (mounted) runResolution(() => resolveAuthStateChange(event, session, () => dbAdapter.getUsers()).then(result => result!));
        }, 0);
      } else if (event === 'SIGNED_OUT') {
        operation += 1;
        const preserveError = preserveNextSignOutError.current;
        preserveNextSignOutError.current = false;
        setAllUsers([]);
        setCurrentUser(null);
        if (!preserveError) setAuthError(null);
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
      const safeNextPath = getSafeNextPath(nextPath);
      sessionStorage.setItem(INTENDED_PATH_STORAGE_KEY, safeNextPath);
      const redirectTo = buildOAuthRedirectUrl(window.location.origin, safeNextPath);
      const { error } = await withAuthFailureTimeout(
        supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo,
          },
        }),
        AUTH_INITIALIZATION_TIMEOUT_MS,
        '登入服務回應逾時',
      );
      if (error) throw error;
    } catch (error) {
      console.error('Login error:', error);
      setAuthError('登入過程發生錯誤');
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await withAuthFailureTimeout(
        supabase.auth.signOut(),
        AUTH_INITIALIZATION_TIMEOUT_MS,
        '登出服務回應逾時',
      );
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
