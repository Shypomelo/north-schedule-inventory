import React from 'react';

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full bg-slate-900">
      <div className="border-b border-slate-800 bg-slate-900/50 sticky top-0 z-10 px-8 py-4 flex items-center gap-6">
        <h1 className="text-2xl font-bold text-emerald-400 mr-4">庫存管理</h1>
        <nav className="flex gap-4">
          <a href="/inventory" className="text-sm font-semibold text-slate-300 hover:text-white px-3 py-2 rounded-md hover:bg-slate-800 transition">目前庫存</a>
          <a href="/inventory/transactions" className="text-sm font-semibold text-slate-300 hover:text-white px-3 py-2 rounded-md hover:bg-slate-800 transition">庫存流水帳 (異動)</a>
          <a href="/inventory/monthly" className="text-sm font-semibold text-slate-300 hover:text-white px-3 py-2 rounded-md hover:bg-slate-800 transition">月結報表</a>
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-8">
        {children}
      </div>
    </div>
  );
}
