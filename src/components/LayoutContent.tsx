"use client";

import React from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { useUser } from '@/components/UserContext';
import { LogOut } from 'lucide-react';

export function LayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { currentUser, logout } = useUser();
  const isLoginPage = pathname === '/login';

  return (
    <div className="flex w-full h-full">
      {!isLoginPage && <Sidebar />}
      <main className="flex-1 h-full overflow-auto custom-scrollbar bg-slate-900 relative">
        {!isLoginPage && currentUser && (
          <div className="absolute top-4 right-8 z-50 flex items-center gap-3 bg-slate-800/80 backdrop-blur-md px-4 py-2 rounded-full border border-slate-700 shadow-sm">
            <span className="text-sm font-medium text-slate-200">
              {currentUser.name}
            </span>
            <span className="text-slate-500">|</span>
            <span className="text-sm text-slate-400">
              {currentUser.role}
            </span>
            <span className="text-slate-500">|</span>
            <button
              onClick={logout}
              className="flex items-center gap-1 text-sm text-red-400 hover:text-red-300 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              登出
            </button>
          </div>
        )}
        <div className="min-w-[1400px] h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
