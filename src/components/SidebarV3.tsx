"use client";

import React, { useState, useRef, useEffect } from 'react';
import { UserSelector } from "@/components/UserSelector";
import { useUser } from "@/components/UserContext";
import { useTheme } from "@/components/ThemeContext";
import { ChevronLeft, ChevronRight, Home, Calendar, Building2, Package, Truck, Settings, Users, Wrench, ListChecks, Palette } from "lucide-react";

export function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showThemePopover, setShowThemePopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { currentUser, allUsers, logout } = useUser();
  const { theme, setTheme } = useTheme();

  const currentRole = currentUser?.role?.toLowerCase();
  const engineeringUsers = allUsers.filter(u => u.is_active && u.category === 'ENGINEERING');

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setShowThemePopover(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  return (
    <aside className={`h-[100dvh] bg-[var(--bg-sidebar)] border-r border-[var(--border)] shrink-0 flex flex-col gap-4 hidden md:flex transition-all duration-300 relative ${isCollapsed ? 'w-16 p-2 items-center' : 'w-64 p-4'}`}>
      <button 
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="absolute -right-3 top-6 bg-[var(--bg-card)] border border-[var(--border)] rounded-full p-1 hover:bg-[var(--sidebar-hover)] text-[var(--text-secondary)] z-50 shadow-lg flex items-center justify-center w-6 h-6"
      >
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      <div className={`font-bold text-[var(--accent)] transition-all duration-300 overflow-hidden whitespace-nowrap flex-shrink-0 ${isCollapsed ? 'text-xs opacity-0 w-0 h-0 m-0' : 'text-xl opacity-100'}`}>
        北部工程排程系統
      </div>
      
      <div className={`transition-all duration-300 flex-shrink-0 relative ${isCollapsed ? 'w-0 h-0 opacity-0 overflow-hidden' : 'w-full opacity-100 overflow-visible'}`}>
        {(!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) && (
          <div className="mb-4">
            <UserSelector />
          </div>
        )}
        {currentUser && (
          <div className="bg-[var(--sidebar-hover)] p-3 rounded-lg border border-[var(--border)] relative">
            <div className="flex justify-between items-start">
              <div className="text-sm font-bold text-[var(--text-primary)]">{currentUser.name}</div>

              <div className="relative" ref={popoverRef}>
                <button
                  onClick={() => setShowThemePopover(!showThemePopover)}
                  className="p-1 rounded hover:bg-[var(--sidebar-hover)] text-[var(--text-secondary)] transition-colors"
                  title="切換主題"
                >
                  <Palette size={14} />
                </button>

                {showThemePopover && (
                  <div className="absolute right-0 top-full mt-1 bg-[var(--bg-card)] border border-[var(--border)] shadow-xl rounded-lg p-2 z-50 min-w-[120px] flex flex-col gap-1">
                    <div className="text-[10px] text-[var(--text-secondary)] font-bold mb-1 uppercase tracking-wider px-2">主題 Theme</div>
                    <button
                      onClick={() => { setTheme('dark'); setShowThemePopover(false); }}
                      className={`text-left px-2 py-1.5 text-sm rounded transition-colors ${theme === 'dark' ? 'bg-[var(--sidebar-hover)] text-[var(--accent)] font-medium' : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)]'}`}
                    >
                      深色
                    </button>
                    <button
                      onClick={() => { setTheme('light'); setShowThemePopover(false); }}
                      className={`text-left px-2 py-1.5 text-sm rounded transition-colors ${theme === 'light' ? 'bg-[var(--sidebar-hover)] text-[var(--accent)] font-medium' : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)]'}`}
                    >
                      淺色
                    </button>
                    <button
                      onClick={() => { setTheme('orange'); setShowThemePopover(false); }}
                      className={`text-left px-2 py-1.5 text-sm rounded transition-colors ${theme === 'orange' ? 'bg-[var(--sidebar-hover)] text-[var(--accent)] font-medium' : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)]'}`}
                    >
                      橘色
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="text-xs text-[var(--text-secondary)] mt-1 mb-2">
              角色: {currentRole === 'admin' ? 'Admin' : currentUser.role === 'ENGINEER' ? 'Engineer' : 'Viewer'}
            </div>
            {process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && (
              <button 
                onClick={logout}
                className="text-xs w-full py-1.5 bg-[var(--danger)] bg-opacity-10 text-[var(--danger)] hover:bg-opacity-20 rounded transition-colors"
              >
                登出
              </button>
            )}
          </div>
        )}
      </div>

      <nav className="flex-1 flex flex-col gap-2 w-full overflow-y-auto overflow-x-hidden sidebar-scrollbar pb-6 pr-1">
        <a href="/" className={`hover:bg-[var(--sidebar-hover)] rounded flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="儀表板">
          <Home size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden text-[var(--text-primary)] transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>儀表板 (Dashboard)</span>
        </a>
        <a href="/schedule" className={`hover:bg-[var(--sidebar-hover)] rounded flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="排程管理">
          <Calendar size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden text-[var(--text-primary)] transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>排程管理</span>
        </a>

        <details className="group mt-2" open={!isCollapsed}>
          <summary className={`text-[var(--text-secondary)] font-bold text-xs uppercase tracking-wider cursor-pointer hover:bg-[var(--sidebar-hover)] rounded flex items-center list-none outline-none ${isCollapsed ? 'p-2 justify-center' : 'p-2 justify-between'}`} title="案場管理">
            <div className="flex items-center">
              <Building2 size={18} className={`shrink-0 ${isCollapsed ? '' : 'hidden'}`} />
              <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'opacity-100'}`}>案場管理</span>
            </div>
            {!isCollapsed && <span className="transition group-open:rotate-180">▾</span>}
          </summary>
          <div className={`flex flex-col gap-1 mt-1 pl-2 transition-all duration-300 overflow-hidden ${isCollapsed ? 'hidden' : 'block'}`}>
            <a href="/projects/active" className="text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] p-2 rounded text-sm whitespace-nowrap">進行中案場</a>
            {engineeringUsers.map(u => (
              <a key={u.id} href={`/projects/${u.id}`} className="text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] p-2 rounded text-sm whitespace-nowrap">{u.name}案場</a>
            ))}
            <a href="/projects" className="text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] p-2 rounded text-sm whitespace-nowrap">所有案場</a>
          </div>
        </details>

        <a href="/inventory" className={`hover:bg-[var(--sidebar-hover)] rounded mt-2 flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="庫存管理">
          <Package size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden text-[var(--text-primary)] transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>庫存管理</span>
        </a>
        <a href="/se-supply" className={`hover:bg-[var(--sidebar-hover)] rounded mt-2 flex items-center ${isCollapsed ? 'justify-center p-2' : 'p-2'}`} title="SE 供貨追蹤">
          <Truck size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <span className={`ml-3 whitespace-nowrap overflow-hidden text-[var(--text-primary)] transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>SE 供貨追蹤</span>
        </a>

        {currentRole === 'admin' && (
          <details className="group mt-2" open={!isCollapsed}>
            <summary className={`text-[var(--text-secondary)] font-bold text-xs uppercase tracking-wider cursor-pointer hover:bg-[var(--sidebar-hover)] rounded flex items-center list-none outline-none ${isCollapsed ? 'p-2 justify-center' : 'p-2 justify-between'}`} title="系統管理">
              <div className="flex items-center">
                <Settings size={18} className={`shrink-0 ${isCollapsed ? '' : 'hidden'}`} />
                <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'opacity-100'}`}>系統管理</span>
              </div>
              {!isCollapsed && <span className="transition group-open:rotate-180">▾</span>}
            </summary>
            <div className={`flex flex-col gap-1 mt-1 pl-2 transition-all duration-300 overflow-hidden ${isCollapsed ? 'hidden' : 'block'}`}>
              <a href="/admin/users" className="text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] p-2 rounded text-sm whitespace-nowrap flex items-center gap-2">
                <Users size={14} />
                人員管理
              </a>
              <a href="/admin/contractors" className="text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] p-2 rounded text-sm whitespace-nowrap flex items-center gap-2">
                <Wrench size={14} />
                包商管理
              </a>
              <a href="/admin/task-types" className="text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] p-2 rounded text-sm whitespace-nowrap flex items-center gap-2">
                <ListChecks size={14} />
                任務類型管理
              </a>
            </div>
          </details>
        )}
      </nav>
    </aside>
  );
}
