"use client";

import React, { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { Loader2 } from 'lucide-react';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { currentUser, isLoading } = useUser();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !currentUser && pathname !== '/login') {
      router.push('/login');
    }
  }, [isLoading, currentUser, pathname, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-slate-900 text-slate-50">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-slate-400">系統載入中...</p>
        </div>
      </div>
    );
  }

  // Only render children if user is logged in or if we are on the login page
  if (!currentUser && pathname !== '/login') {
    return null; // Will redirect in useEffect
  }

  return <>{children}</>;
}
