"use client";

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { LogIn, AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const { currentUser, loginWithGoogle, authError, isLoading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (currentUser && !isLoading) {
      router.push('/');
    }
  }, [currentUser, isLoading, router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-900 text-slate-50 w-full">
      <div className="w-full max-w-md p-8 bg-slate-800 rounded-xl shadow-lg border border-slate-700">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">北部工程排程與庫存管理系統</h1>
          <p className="text-slate-400">請登入以繼續使用系統</p>
        </div>

        {authError && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-500 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <p className="text-red-200 text-sm">{authError}</p>
          </div>
        )}

        <button
          onClick={loginWithGoogle}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-100 text-slate-900 font-medium py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          {isLoading ? '處理中...' : '使用 Google 帳號登入'}
        </button>
      </div>
    </div>
  );
}
