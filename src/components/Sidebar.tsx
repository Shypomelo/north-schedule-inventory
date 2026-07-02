"use client";

import React, { useState } from 'react';
import { UserSelector } from "@/components/UserSelector";
import { useUser } from "@/components/UserContext";
import { ChevronLeft, ChevronRight, Home, Calendar, Building2, Package, Truck, Settings, Users, Wrench } from "lucide-react";

export function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { currentUser, allUsers } = useUser();
  const engineeringUsers = allUsers.filter(u => u.is_active && u.category === 'ENGINEERING');

  return (
    <aside className={`border-r border-slate-800 bg-slate-900 shrink-0 flex flex-col gap-4 hidden md:flex transition-all duration-300 relative ${isCollapsed ? 'w-16 p-2 items-center' : 'w-64 p-4'}`}>
      <button 
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="absolute -right-3 top-6 bg-slate-800 border border-slate-700 rounded-full p-1 hover:bg-slate-700 text-slate-300 z-50 shadow-lg flex items-center justify-center w-6 h-6"
      >
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      <div className={`font-bold text-emerald-400 mb-2 transition-all duration-300 overflow-hidden whitespace-nowrap ${isCollapsed ? 'text-xs opacity-0 w-0 h-0 m-0' : 'text-lg opacity-100'}`}>
        北部工程
      </div>
      
      <div className={`transition-all duration-300 overflow-hidden ${isCollapsed ? 'w-0 h-0 opacity-0' : 'w-full opacity-100'}`}>
        <UserSelector />
        {currentUser && (
          <div className="mt-2 text-xs text-slate-400 px-1">
            目前使用者：{currentUser.name}｜{currentUser.role === 'ADMIN' ? 'Admin' : currentUser.role === 'ENGINEER' ? 'Engineer' : 'Viewer'}
          </div>
        )}
      </div>

      <nav className="flex flex-col gap-2 mt-4 w-full">
        <a href="/" className={`hover:bg-slate-800 rounded flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="儀表板">
          <Home size={18} className="shrink-0 text-slate-400" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>儀表板 (Dashboard)</span>
        </a>
        <a href="/schedule" className={`hover:bg-slate-800 rounded flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="排程管理">
          <Calendar size={18} className="shrink-0 text-slate-400" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>排程管理</span>
        </a>

        <details className="group mt-2" open={!isCollapsed}>
          <summary className={`text-slate-400 font-bold text-xs uppercase tracking-wider cursor-pointer hover:bg-slate-800 rounded flex items-center list-none outline-none ${isCollapsed ? 'p-2 justify-center' : 'p-2 justify-between'}`} title="案場管理">
            <div className="flex items-center">
              <Building2 size={18} className={`shrink-0 ${isCollapsed ? '' : 'hidden'}`} />
              <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'opacity-100'}`}>案場管理</span>
            </div>
            {!isCollapsed && <span className="transition group-open:rotate-180">▾</span>}
          </summary>
          <div className={`flex flex-col gap-1 mt-1 pl-2 transition-all duration-300 overflow-hidden ${isCollapsed ? 'hidden' : 'block'}`}>
            <a href="/projects/active" className="hover:bg-slate-800 p-2 rounded text-sm whitespace-nowrap">進行中案場</a>
            {engineeringUsers.map(u => (
              <a key={u.id} href={`/projects/${u.id}`} className="hover:bg-slate-800 p-2 rounded text-sm whitespace-nowrap">{u.name}案場</a>
            ))}
            <a href="/projects" className="hover:bg-slate-800 p-2 rounded text-sm text-slate-400 whitespace-nowrap">所有案場</a>
          </div>
        </details>

        <a href="/inventory" className={`hover:bg-slate-800 rounded mt-2 flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="庫存管理">
          <Package size={18} className="shrink-0 text-slate-400" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>庫存管理</span>
        </a>
        <a href="/se-supply" className={`hover:bg-slate-800 rounded mt-2 flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="SE 供貨追蹤">
          <Truck size={18} className="shrink-0 text-slate-400" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>SE 供貨追蹤</span>
        </a>

        {currentUser?.role === 'ADMIN' && (
          <details className="group mt-2" open={!isCollapsed}>
            <summary className={`text-slate-400 font-bold text-xs uppercase tracking-wider cursor-pointer hover:bg-slate-800 rounded flex items-center list-none outline-none ${isCollapsed ? 'p-2 justify-center' : 'p-2 justify-between'}`} title="系統管理">
              <div className="flex items-center">
                <Settings size={18} className={`shrink-0 ${isCollapsed ? '' : 'hidden'}`} />
                <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'opacity-100'}`}>系統管理</span>
              </div>
              {!isCollapsed && <span className="transition group-open:rotate-180">▾</span>}
            </summary>
            <div className={`flex flex-col gap-1 mt-1 pl-2 transition-all duration-300 overflow-hidden ${isCollapsed ? 'hidden' : 'block'}`}>
              <a href="/admin/users" className="hover:bg-slate-800 p-2 rounded text-sm whitespace-nowrap flex items-center gap-2">
                <Users size={14} />
                人員管理
              </a>
              <a href="/admin/contractors" className="hover:bg-slate-800 p-2 rounded text-sm whitespace-nowrap flex items-center gap-2">
                <Wrench size={14} />
                包商管理
              </a>
            </div>
          </details>
        )}
      </nav>
    </aside>
  );
}
