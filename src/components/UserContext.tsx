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
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
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
        loadUsersAndHandleSession(session);
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

  const loginWithGoogle = async () => {
    setIsLoading(true);
    setAuthError(null);
    try {
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/`,
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
