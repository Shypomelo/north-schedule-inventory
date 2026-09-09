import React from 'react';

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-page">
      <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-2 border-b border-theme-border bg-card px-3 py-3 sm:flex-row sm:items-center sm:gap-6 sm:px-6 lg:px-8 lg:py-4">
        <h1 className="text-xl font-bold text-emerald-400 sm:mr-4 sm:text-2xl">庫存管理</h1>
        <nav className="flex gap-1 overflow-x-auto sm:gap-4">
          <a href="/inventory" className="text-sm font-semibold text-secondary hover:text-primary px-3 py-2 rounded-md hover:bg-page transition">目前庫存</a>
          <a href="/inventory/transactions" className="text-sm font-semibold text-secondary hover:text-primary px-3 py-2 rounded-md hover:bg-page transition">庫存流水帳 (異動)</a>
          <a href="/inventory/monthly" className="text-sm font-semibold text-secondary hover:text-primary px-3 py-2 rounded-md hover:bg-page transition">月結報表</a>
        </nav>
      </div>
      <div className="min-w-0 flex-1 overflow-auto p-3 sm:p-5 lg:p-8">
        {children}
      </div>
    </div>
  );
}
