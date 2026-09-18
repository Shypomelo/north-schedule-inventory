"use client";

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { useTheme } from '@/components/ThemeContext';
import { UserSelector } from '@/components/UserSelector';
import { Building2, Calendar, ChevronLeft, ChevronRight, Home, ListChecks, LogOut, Menu, Package, Palette, Settings, Truck, UserRound, Users, Wrench, X } from 'lucide-react';
import { isMobileNavigationEdgeSwipe, type SwipePoint } from '@/lib/mobile-navigation-gesture';
import { dbAdapter } from '@/lib/db';
import type { MemberPosition, Position } from '@/lib/db/types';
import { ROLE_LABELS, selectEngineeringMembers } from '@/lib/personnel-workspace';
import { buildMemberProjectsHref } from '@/lib/project-routes';

export function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const { currentUser, allUsers, logout } = useUser();
  const { theme, setTheme } = useTheme();
  const [positions, setPositions] = useState<Position[]>([]);
  const [memberPositions, setMemberPositions] = useState<MemberPosition[]>([]);
  const currentRole = currentUser?.role?.toLowerCase();
  const engineeringUsers = selectEngineeringMembers(allUsers, positions, memberPositions);
  const currentPositionNames = positions
    .filter(position => position.is_active && memberPositions.some(link => link.member_id === currentUser?.id && link.position_id === position.id))
    .sort((left, right) => left.sort_order - right.sort_order)
    .map(position => position.name);
  const isActive = (href: string, includeSubpaths = false) => pathname === href || (includeSubpaths && href !== '/' && pathname.startsWith(`${href}/`));
  const closeMobileSidebar = () => {
    setIsMobileOpen(false);
    setShowTheme(false);
    setShowAccount(false);
  };

  useEffect(() => {
    setIsMobileOpen(false);
    setShowTheme(false);
    setShowAccount(false);
  }, [pathname]);

  useEffect(() => {
    let live = true;
    Promise.all([dbAdapter.getPositions(), dbAdapter.getMemberPositions()])
      .then(([positionRows, membershipRows]) => {
        if (live) { setPositions(positionRows); setMemberPositions(membershipRows); }
      })
      .catch(error => console.error('Sidebar position assignments failed to load:', error));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!isMobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isMobileOpen]);

  useEffect(() => {
    if (isMobileOpen) return;
    let startPoint: SwipePoint | null = null;

    const handlePointerDown = (event: PointerEvent) => {
      if (window.innerWidth >= 768 || !event.isPrimary) return;
      startPoint = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!startPoint || !event.isPrimary) {
        startPoint = null;
        return;
      }
      const shouldOpen = isMobileNavigationEdgeSwipe(startPoint, { x: event.clientX, y: event.clientY });
      startPoint = null;
      if (shouldOpen) setIsMobileOpen(true);
    };

    window.addEventListener('pointerdown', handlePointerDown, { passive: true });
    window.addEventListener('pointerup', handlePointerUp, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isMobileOpen]);

  const navItem = (href: string, label: string, Icon: React.ElementType, collapsed: boolean, includeSubpaths = false) => (
    <a href={href} title={label} className={`flex min-h-11 items-center rounded-lg p-2 text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] ${isActive(href, includeSubpaths) ? 'bg-[var(--sidebar-active)]' : ''} ${collapsed ? 'justify-center' : ''}`}>
      <Icon size={18} className="shrink-0 text-[var(--text-secondary)]" />
      <span className={`ml-3 overflow-hidden whitespace-nowrap transition-all ${collapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>{label}</span>
    </a>
  );

  const panel = (collapsed: boolean, mobile = false) => (
    <>
      <div className={`shrink-0 overflow-hidden whitespace-nowrap font-bold text-[var(--sidebar-brand)] ${collapsed ? 'h-0 w-0 opacity-0' : 'text-xl'}`}>北部工程排程系統</div>
      <nav className="sidebar-scrollbar flex w-full flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden pb-6 pr-1">
        {navItem('/', '儀表板 (Dashboard)', Home, collapsed)}
        {navItem('/schedule', '排程管理', Calendar, collapsed, true)}
        <details className="group mt-2" open={!collapsed}>
          <summary className={`flex min-h-11 cursor-pointer list-none items-center rounded-lg p-2 text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] ${collapsed ? 'justify-center' : 'justify-between'}`}>
            <span className="flex items-center"><Building2 size={18} className={collapsed ? '' : 'hidden'} /><span className={collapsed ? 'hidden' : ''}>案場管理</span></span>{!collapsed && <span>▾</span>}
          </summary>
          {!collapsed && <div className="mt-1 flex flex-col gap-1 pl-2">
            <a href="/projects/active" className={`min-h-11 rounded p-2 text-sm text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] ${isActive('/projects/active', true) ? 'bg-[var(--sidebar-active)]' : ''}`}>進行中案場</a>
            {engineeringUsers.map(user => { const href = buildMemberProjectsHref(user.id); return <a key={user.id} href={href} className={`min-h-11 rounded p-2 text-sm text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] ${isActive(href, true) ? 'bg-[var(--sidebar-active)]' : ''}`}>{user.name}案場</a>; })}
            <a href="/projects" className={`min-h-11 rounded p-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] ${isActive('/projects') ? 'bg-[var(--sidebar-active)]' : ''}`}>所有案場</a>
          </div>}
        </details>
        {navItem('/inventory', '庫存管理', Package, collapsed, true)}
        {navItem('/se-supply', 'SE 供貨追蹤', Truck, collapsed, true)}
        {currentRole === 'admin' && (
          <details className="group mt-2" open={!collapsed}>
            <summary className={`flex min-h-11 cursor-pointer list-none items-center rounded-lg p-2 text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] ${collapsed ? 'justify-center' : 'justify-between'}`}>
              <span className="flex items-center"><Settings size={18} className={collapsed ? '' : 'hidden'} /><span className={collapsed ? 'hidden' : ''}>系統管理</span></span>{!collapsed && <span>▾</span>}
            </summary>
            {!collapsed && <div className="mt-1 flex flex-col gap-1 pl-2">
              {navItem('/admin/users', '人員管理', Users, false, true)}
              {navItem('/admin/contractors', '包商管理', Wrench, false, true)}
              {navItem('/admin/task-types', '任務類型管理', ListChecks, false, true)}
              {navItem('/admin/workflow-settings', '專案流程設定', ListChecks, false, true)}
              {navItem('/admin/materials', '常用物料管理', Package, false, true)}
            </div>}
          </details>
        )}
      </nav>
      {!collapsed && (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) && <div className="shrink-0"><UserSelector /></div>}
      {currentUser && <div className="relative shrink-0">
        {showAccount && !collapsed ? <div className="absolute inset-x-0 bottom-full z-50 mb-2 rounded-lg border border-[var(--sidebar-border)] bg-[var(--bg-sidebar)] p-3 text-xs shadow-xl">
          <div className="font-bold text-[var(--text-primary)]">{currentUser.name}</div>
          <div className="mt-2 text-[var(--text-secondary)]">權限：{ROLE_LABELS[currentUser.role]}</div>
          <div className="mt-1 text-[var(--text-secondary)]">職位：{currentPositionNames.join('、') || '未設定'}</div>
          {currentUser.email ? <div className="mt-1 break-all text-[var(--text-secondary)]">{currentUser.email}</div> : null}
        </div> : null}
        {showTheme && !collapsed ? <div className="theme-popover absolute right-0 bottom-full z-50 mb-2 flex min-w-32 flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xl [--text-primary:var(--modal-text)]">
          {(['dark', 'light', 'orange'] as const).map(value => <button type="button" key={value} onClick={() => { setTheme(value); setShowTheme(false); }} className={`rounded px-3 py-2 text-left text-sm ${theme === value ? 'bg-[var(--sidebar-hover)] font-medium text-[var(--accent)]' : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)]'}`}>{value === 'dark' ? '深色' : value === 'light' ? '淺色' : '橘色'}</button>)}
        </div> : null}
        <div className={`flex items-center rounded-lg border border-[var(--sidebar-border)] bg-[var(--sidebar-user-card)] p-1 ${collapsed?'flex-col gap-1':'gap-1'}`} aria-label="帳號列">
          <button type="button" title={currentUser.name} aria-expanded={showAccount} onClick={()=>{setShowAccount(value=>!value);setShowTheme(false);}} className={`flex min-h-9 min-w-0 items-center rounded px-2 text-sm font-bold text-[var(--text-primary)] hover:bg-[var(--sidebar-hover)] ${collapsed?'justify-center':'flex-1'}`}><UserRound size={16} className="shrink-0"/>{!collapsed?<span className="ml-2 truncate">{currentUser.name}</span>:null}</button>
          <button type="button" onClick={()=>{setShowTheme(value=>!value);setShowAccount(false);}} className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)]" aria-label="切換主題"><Palette size={16}/></button>
          <button type="button" onClick={logout} className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-[var(--sidebar-danger)] hover:bg-[var(--sidebar-logout-hover)]" aria-label="登出" title="登出"><LogOut size={16}/></button>
        </div>
      </div>}
      {mobile && <span className="sr-only">手機導覽</span>}
    </>
  );

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex h-[calc(2.5rem+env(safe-area-inset-top))] items-center justify-between border-b border-[var(--sidebar-border)] bg-[var(--bg-sidebar)] px-3 pt-[env(safe-area-inset-top)] text-[var(--sidebar-text)] md:hidden">
        <button type="button" onClick={() => setIsMobileOpen(true)} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[var(--sidebar-hover)]" aria-label="開啟導覽選單"><Menu size={20} /></button>
        <div className="truncate px-2 text-sm font-bold leading-none text-[var(--sidebar-brand)]">北部工程排程系統</div><div className="w-9" />
      </header>
      <aside className={`relative hidden h-[100dvh] shrink-0 flex-col gap-4 border-r border-[var(--sidebar-border)] bg-[var(--bg-sidebar)] transition-all [--text-primary:var(--sidebar-text)] [--text-secondary:var(--sidebar-muted)] md:flex ${isCollapsed ? 'w-16 items-center p-2' : 'w-64 p-4'}`}>
        <button type="button" onClick={() => setIsCollapsed(value => !value)} className="absolute -right-3 top-6 z-50 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)]" aria-label={isCollapsed ? '展開側欄' : '收合側欄'}>{isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</button>
        {panel(isCollapsed)}
      </aside>
      {isMobileOpen && (
        <div className="fixed inset-0 z-[80] md:hidden" role="dialog" aria-modal="true" aria-label="網站導覽">
          <button type="button" className="absolute inset-0 bg-black/60" onClick={closeMobileSidebar} aria-label="關閉導覽選單" />
          <aside className="relative flex h-[100dvh] w-[min(20rem,88vw)] flex-col gap-4 overflow-hidden border-r border-[var(--sidebar-border)] bg-[var(--bg-sidebar)] p-4 shadow-2xl [--text-primary:var(--sidebar-text)] [--text-secondary:var(--sidebar-muted)]">
            <div className="flex items-center justify-end"><button type="button" onClick={closeMobileSidebar} className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)]" aria-label="關閉導覽選單"><X size={22} /></button></div>
            {panel(false, true)}
          </aside>
        </div>
      )}
    </>
  );
}
