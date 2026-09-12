"use client";

import React from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/SidebarV3';
import { useUser } from '@/components/UserContext';
import { useDashboardView } from '@/components/DashboardViewContext';
import { useWorkGroups } from '@/hooks/useWorkGroups';

function WorkspaceContent({ children }: { children: React.ReactNode }) {
  const { currentUser } = useUser();
  const perspectives = useDashboardView();
  const workGroups = useWorkGroups();
  if (!currentUser || currentUser.role === 'ADMIN') return <>{children}</>;
  if (perspectives.error || workGroups.error) {
    return <div role="alert" className="m-auto max-w-xl p-8 text-center text-danger">{perspectives.error || workGroups.error}</div>;
  }
  if (perspectives.loading || !workGroups.ready) {
    return <div className="m-auto p-8 text-center text-secondary">工作區設定載入中...</div>;
  }
  if (perspectives.allowed.length === 0 || workGroups.configurationRequired) {
    return <section className="m-auto max-w-xl rounded-2xl border border-theme-border bg-card p-8 text-center shadow-sm">
      <h1 className="text-xl font-bold text-primary">尚未完成工作區設定</h1>
      <p className="mt-3 text-secondary">請聯絡系統管理員設定工作群組與工作視角後再使用工作內容。</p>
    </section>;
  }
  return <>{children}</>;
}

export function LayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  return (
    <div className="flex h-full min-w-0 w-full">
      {!isLoginPage && <Sidebar />}
      <main className={`relative h-full min-w-0 flex-1 overflow-auto custom-scrollbar ${isLoginPage ? '' : 'pt-14 md:pt-0'}`}>
        <div className="h-full min-w-0">
          {isLoginPage ? children : <WorkspaceContent>{children}</WorkspaceContent>}
        </div>
      </main>
    </div>
  );
}
