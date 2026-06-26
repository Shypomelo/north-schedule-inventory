"use client";

import React from 'react';
import Link from 'next/link';
import { Package, ArrowRight } from 'lucide-react';

export default function ItemsPage() {
  return (
    <div className="max-w-4xl mx-auto flex flex-col items-center justify-center h-full min-h-[60vh]">
      <div className="bg-slate-800/50 border border-slate-700 p-12 rounded-3xl flex flex-col items-center text-center shadow-2xl max-w-lg w-full">
        <div className="w-20 h-20 bg-indigo-500/20 text-indigo-400 flex items-center justify-center rounded-2xl mb-6">
          <Package size={40} />
        </div>
        <h2 className="text-3xl font-bold text-slate-100 mb-4">品項管理已全面升級</h2>
        <p className="text-slate-400 mb-8 text-lg">
          為了提供更直覺的操作體驗，所有的「品項管理」、「序號查詢」與「歷史異動」已經完全整合進「庫存總覽」畫面中。
          請直接在庫存總覽點擊任一品項即可開啟詳細管理彈窗！
        </p>
        <Link 
          href="/inventory"
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20 transition-all hover:scale-105"
        >
          前往庫存總覽 <ArrowRight size={20} />
        </Link>
      </div>
    </div>
  );
}
