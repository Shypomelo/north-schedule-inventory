export default function Home() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">儀表板 (Dashboard)</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-slate-800/80 p-6 rounded-lg border border-slate-700/50 backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-2">今日任務</h2>
          <p className="text-slate-400">目前尚無今日任務</p>
        </div>
        <div className="bg-slate-800/80 p-6 rounded-lg border border-slate-700/50 backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-2">待補序號提醒</h2>
          <p className="text-amber-400">0 筆待補序號</p>
        </div>
        <div className="bg-slate-800/80 p-6 rounded-lg border border-slate-700/50 backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-2">最近庫存異動</h2>
          <p className="text-slate-400">無近期異動</p>
        </div>
      </div>
    </div>
  );
}
