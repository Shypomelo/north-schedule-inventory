"use client";

import React from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/SidebarV3';

export function LayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  return (
    <div className="flex w-full h-full">
      {!isLoginPage && <Sidebar />}
      <main className="flex-1 h-full overflow-auto custom-scrollbar relative">
        <div className="min-w-[1400px] h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
