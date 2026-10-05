"use client";

import type { ReactNode } from 'react';
import { deploymentSafetyState } from '@/lib/deployment-safety';

export function DeploymentSafetyGate({ children }: { children: ReactNode }) {
  const state = deploymentSafetyState(
    process.env.NEXT_PUBLIC_DEPLOYMENT_ENV,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );

  if (state === 'blocked') {
    return (
      <main role="alert" className="flex min-h-screen w-full items-center justify-center bg-page p-6 text-center text-primary">
        <div className="max-w-md rounded-2xl border border-theme-border bg-card p-8 shadow-sm">
          <h1 className="text-xl font-bold">環境設定錯誤</h1>
          <p className="mt-3 text-secondary">Preview 不可連線正式資料庫</p>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
