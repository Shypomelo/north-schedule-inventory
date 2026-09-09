"use client";

import React from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/SidebarV3';

export function LayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  return (
    <div className="flex h-full min-w-0 w-full">
      {!isLoginPage && <Sidebar />}
      <main className={`relative h-full min-w-0 flex-1 overflow-auto custom-scrollbar ${isLoginPage ? '' : 'pt-14 md:pt-0'}`}>
        <div className="h-full min-w-0">
          {children}
        </div>
      </main>
    </div>
  );
}
