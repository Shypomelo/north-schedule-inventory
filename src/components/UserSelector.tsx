"use client";

import { useUser } from "./UserContext";

export function UserSelector() {
  const { currentUser, allUsers, setCurrentUser, isLoading } = useUser();

  if (isLoading) return <div className="text-sm text-slate-500">載入中...</div>;

  return (
    <div className="flex flex-col gap-1 text-sm bg-slate-800 p-3 rounded-lg border border-slate-700">
      <label className="text-xs text-slate-400 font-semibold mb-1">模擬登入身份</label>
      <select 
        className="bg-slate-900 border border-slate-600 rounded p-1 text-slate-200 outline-none focus:border-emerald-500"
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
