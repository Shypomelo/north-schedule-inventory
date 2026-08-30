"use client";

import { useUser } from "./UserContext";

export function UserSelector() {
  const { currentUser, allUsers, setCurrentUser, isLoading } = useUser();

  if (isLoading) return <div className="text-sm text-[var(--sidebar-muted)]">載入中...</div>;

  return (
    <div className="flex flex-col gap-1 text-sm bg-[var(--sidebar-hover)] p-3 rounded-lg border border-[var(--sidebar-border)]">
      <label className="text-xs text-[var(--sidebar-muted)] font-semibold mb-1">模擬登入身份</label>
      <select 
        className="bg-[var(--input-bg)] border border-[var(--input-border)] rounded p-1 text-[var(--input-text)] outline-none focus:border-[var(--accent)]"
        value={currentUser?.id || ''}
        onChange={(e) => {
          const user = allUsers.find(u => u.id === e.target.value);
          if (user) setCurrentUser(user);
        }}
      >
        {allUsers.map(user => (
          <option key={user.id} value={user.id}>
            {user.short_name} ({user.role})
          </option>
        ))}
      </select>
    </div>
  );
}
