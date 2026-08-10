"use client";

import React, { useState, useEffect } from 'react';
import { useUser } from '@/components/UserContext';
import { dbAdapter } from '@/lib/db';
import { Project, Contractor } from '@/lib/db/types';
import { AlertTriangle, Check, Info, Server, SkipForward, HardDrive, RefreshCw } from 'lucide-react';

interface MigrationPreviewItem<T> {
  local: T;
  supabaseMatch?: T | null;
  status: 'NEW' | 'DUPLICATE' | 'ERROR';
  reason?: string;
  action: 'SKIP' | 'INSERT';
}

export default function MigrationPage() {
  const { currentUser, isLoading: userLoading } = useUser();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [contractorPreviews, setContractorPreviews] = useState<MigrationPreviewItem<Contractor>[]>([]);
  const [projectPreviews, setProjectPreviews] = useState<MigrationPreviewItem<Project>[]>([]);

  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<any>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    if (userLoading) return;
    if (currentUser?.role?.toLowerCase() !== 'admin') {
      setLoading(false);
      return;
    }
    loadPreview();
  }, [userLoading, currentUser]);

  const loadPreview = async () => {
    try {
      setLoading(true);
      setError(null);

      // 1. Read localStorage
      const saved = localStorage.getItem('schedule-inventory-mock-db-v7') || localStorage.getItem('schedule-inventory-db');
      if (!saved) {
        throw new Error('找不到 localStorage 中的舊資料 (schedule-inventory-mock-db-v7 / schedule-inventory-db)');
      }
      
      const localDb = JSON.parse(saved);
      const localProjects: Project[] = localDb.projects || [];
      const localContractors: Contractor[] = localDb.contractors || [];

      // 2. Read Supabase current state
      // (dbAdapter points to Supabase if env is set, which it should be here)
      const supaProjects = await dbAdapter.getProjects();
      const supaContractors = await dbAdapter.getContractors();

      // 3. Match Contractors
      const cPreviews: MigrationPreviewItem<Contractor>[] = localContractors.map(lc => {
        const match = supaContractors.find(sc => sc.name === lc.name);
        if (match) {
          return { local: lc, supabaseMatch: match, status: 'DUPLICATE', reason: `名稱 "${lc.name}" 已存在`, action: 'SKIP' };
        }
        return { local: lc, supabaseMatch: null, status: 'NEW', action: 'SKIP' }; // Default to skip, user can select INSERT
      });

      // 4. Match Projects
      const pPreviews: MigrationPreviewItem<Project>[] = localProjects.map(lp => {
        const match = supaProjects.find(sp => 
          (lp.project_code && lp.project_code === sp.project_code) ||
          (lp.name && lp.name === sp.name) ||
          (lp.short_name && lp.short_name === sp.short_name)
        );

        if (match) {
          const reason = [];
          if (lp.project_code === match.project_code) reason.push('案場代碼相同');
          if (lp.name === match.name) reason.push('全名相同');
          if (lp.short_name === match.short_name) reason.push('簡稱相同');
          return { local: lp, supabaseMatch: match, status: 'DUPLICATE', reason: reason.join(' / '), action: 'SKIP' };
        }
        return { local: lp, supabaseMatch: null, status: 'NEW', action: 'SKIP' };
      });

      setContractorPreviews(cPreviews);
      setProjectPreviews(pPreviews);
    } catch (err: any) {
      console.error(err);
      setError(err.message || '預覽載入失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleContractorAction = (idx: number, action: 'SKIP' | 'INSERT') => {
    const next = [...contractorPreviews];
    next[idx].action = action;
    setContractorPreviews(next);
  };

  const handleProjectAction = (idx: number, action: 'SKIP' | 'INSERT') => {
    const next = [...projectPreviews];
    next[idx].action = action;
    setProjectPreviews(next);
  };

  const executeMigration = async () => {
    try {
      setShowConfirm(false);
      setMigrating(true);
      setError(null);

      const result = {
        contractorsAdded: 0,
        contractorsSkipped: 0,
        projectsAdded: 0,
        projectsSkipped: 0,
        progressAdded: 0,
        errors: 0,
        errorMsgs: [] as string[]
      };

      // 1. Insert Contractors
      const contractorIdMap = new Map<string, string>(); // Map old ID to new ID
      for (const cp of contractorPreviews) {
        if (cp.action === 'INSERT') {
          try {
            const newC = await dbAdapter.createContractor({
              name: cp.local.name,
              contractor_type: cp.local.contractor_type,
              contact_person: cp.local.contact_person,
              phone: cp.local.phone,
              notes: cp.local.notes,
              is_active: cp.local.is_active
            });
            contractorIdMap.set(cp.local.id, newC.id);
            result.contractorsAdded++;
          } catch (err: any) {
            result.errors++;
            result.errorMsgs.push(`包商 ${cp.local.name} 失敗: ${err.message}`);
          }
        } else {
          result.contractorsSkipped++;
          // If duplicate, try to map to existing Supabase ID so projects can use it
          if (cp.supabaseMatch) {
             contractorIdMap.set(cp.local.id, cp.supabaseMatch.id);
          }
        }
      }

      // 2. Insert Projects & Progress
      for (const pp of projectPreviews) {
        if (pp.action === 'INSERT') {
          try {
            const lp = pp.local;
            
            // Map the expected dates and contractor names/ids for progress
            const workTypes = ['racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other'];
            const mappedProject: Partial<Project> = {
              name: lp.name,
              short_name: lp.short_name,
              project_code: lp.project_code,
              capacity: lp.capacity,
              address: lp.address,
              region: lp.region,
              manager: lp.manager,
              status: lp.status,
              meter_expected_date: lp.meter_expected_date,
              notes: lp.notes,
            };

            // Process progress fields
            let hasProgress = false;
            for (const t of workTypes) {
              const cidKey = `${t}_contractor_id` as keyof Project;
              const sDateKey = `${t}_expected_start_date` as keyof Project;
              const eDateKey = `${t}_completion_date` as keyof Project;
              const statusKey = `${t}_status` as keyof Project;
              const notesKey = `${t}_notes` as keyof Project;
              // New field for historical cache
              const cNameKey = `${t}_contractor_name` as keyof Project;

              const oldCid = lp[cidKey] as string;
              if (oldCid || lp[sDateKey] || lp[eDateKey] || lp[statusKey] || lp[notesKey]) {
                hasProgress = true;
                
                // Try to find the new ID
                let newCid = oldCid ? contractorIdMap.get(oldCid) : null;
                // Try to find the old name directly from local preview if not in map
                let oldName = lp[cNameKey] as string | null;
                if (!oldName && oldCid) {
                   const oldC = contractorPreviews.find(c => c.local.id === oldCid);
                   if (oldC) oldName = oldC.local.name;
                }

                (mappedProject as any)[cidKey] = newCid || null;
                (mappedProject as any)[cNameKey] = oldName || null;
                (mappedProject as any)[sDateKey] = lp[sDateKey] || null;
                (mappedProject as any)[eDateKey] = lp[eDateKey] || null;
                (mappedProject as any)[statusKey] = lp[statusKey] || null;
                (mappedProject as any)[notesKey] = lp[notesKey] || null;
              }
            }

            await dbAdapter.createProject(mappedProject as any);
            result.projectsAdded++;
            if (hasProgress) {
              result.progressAdded++; // roughly counting 1 per project that had progress
            }
          } catch (err: any) {
            result.errors++;
            result.errorMsgs.push(`案場 ${pp.local.name} 失敗: ${err.message}`);
          }
        } else {
          result.projectsSkipped++;
        }
      }

      setMigrationResult(result);
      
      // Refresh previews after migration
      await loadPreview();
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || '匯入發生錯誤');
    } finally {
      setMigrating(false);
    }
  };

  if (userLoading || loading) {
    return <div className="p-8 text-white">載入中...</div>;
  }

  if (currentUser?.role?.toLowerCase() !== 'admin') {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-full text-slate-400">
        <AlertTriangle size={48} className="text-orange-500 mb-4" />
        <h2 className="text-2xl font-bold text-white mb-2">權限不足</h2>
        <p>只有系統管理員可以執行舊資料遷移。</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto text-slate-200">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2 flex items-center gap-3">
          <HardDrive className="text-blue-400" />
          舊資料匯入與遷移工具
        </h1>
        <p className="text-slate-400">從本機 localStorage (`schedule-inventory-db`) 安全匯入資料至 Supabase。</p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-4 rounded-xl mb-6 flex items-start gap-3">
          <AlertTriangle className="shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {migrationResult && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 p-6 rounded-xl mb-8">
          <h3 className="text-emerald-400 font-bold text-xl mb-4 flex items-center gap-2">
            <Check /> 匯入報告
          </h3>
          <ul className="space-y-2 text-slate-300">
            <li>✅ 成功新增包商：{migrationResult.contractorsAdded} 筆</li>
            <li>⏭️ 略過包商：{migrationResult.contractorsSkipped} 筆</li>
            <li>✅ 成功新增案場：{migrationResult.projectsAdded} 筆</li>
            <li>⏭️ 略過案場：{migrationResult.projectsSkipped} 筆</li>
            <li>✅ 成功寫入施工進度 (案場數)：{migrationResult.progressAdded} 筆</li>
            {migrationResult.errors > 0 && (
              <li className="text-rose-400 font-bold mt-4">
                ❌ 錯誤：{migrationResult.errors} 筆
                <ul className="text-sm font-normal mt-2 ml-4 list-disc space-y-1">
                  {migrationResult.errorMsgs.map((msg: string, i: number) => <li key={i}>{msg}</li>)}
                </ul>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Action Bar */}
      <div className="flex justify-between items-center mb-6 bg-slate-800 p-4 rounded-xl shadow-lg border border-slate-700">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
            <span className="text-sm">新資料</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-orange-500"></span>
            <span className="text-sm">疑似重複</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={loadPreview}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition-colors flex items-center gap-2"
          >
            <RefreshCw size={16} /> 重新掃描
          </button>
          <button 
            onClick={() => setShowConfirm(true)}
            disabled={migrating || (contractorPreviews.every(c => c.action === 'SKIP') && projectPreviews.every(p => p.action === 'SKIP'))}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg font-bold transition-colors shadow-lg shadow-blue-500/20"
          >
            確認並匯入所選資料
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        {/* Contractors */}
        <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 overflow-hidden flex flex-col h-[600px]">
          <div className="p-4 bg-slate-800/80 border-b border-slate-700/50 font-bold flex justify-between items-center">
            <span>包商預覽 ({contractorPreviews.length} 筆)</span>
            <button 
              onClick={() => {
                const next = contractorPreviews.map(c => ({...c, action: c.status === 'NEW' ? 'INSERT' : 'SKIP'} as const));
                setContractorPreviews(next);
              }}
              className="text-xs px-2 py-1 bg-slate-700 rounded hover:bg-slate-600"
            >
              全選新資料
            </button>
          </div>
          <div className="overflow-y-auto flex-1 p-2">
            {contractorPreviews.length === 0 ? (
              <div className="p-8 text-center text-slate-500">無舊資料</div>
            ) : (
              <div className="flex flex-col gap-2">
                {contractorPreviews.map((cp, i) => (
                  <div key={i} className={`p-3 rounded-lg border ${cp.status === 'DUPLICATE' ? 'bg-orange-500/10 border-orange-500/30' : 'bg-slate-800 border-slate-700'} flex items-center justify-between`}>
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="font-bold truncate text-white">{cp.local.name}</div>
                      <div className="text-xs text-slate-400 mt-1 flex gap-2">
                        <span className="bg-slate-700 px-1.5 py-0.5 rounded">{cp.local.contractor_type}</span>
                        {cp.reason && <span className="text-orange-400">⚠️ {cp.reason}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center">
                      <select 
                        value={cp.action} 
                        onChange={(e) => handleContractorAction(i, e.target.value as 'SKIP' | 'INSERT')}
                        className={`text-sm rounded border-none py-1 pl-2 pr-6 outline-none focus:ring-2 focus:ring-blue-500 ${cp.action === 'INSERT' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                      >
                        <option value="SKIP">⏭️ 略過</option>
                        <option value="INSERT">✅ 新增</option>
                        <option value="UPDATE" disabled>🔄 覆蓋 (不支援)</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Projects */}
        <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 overflow-hidden flex flex-col h-[600px]">
          <div className="p-4 bg-slate-800/80 border-b border-slate-700/50 font-bold flex justify-between items-center">
            <span>案場預覽 ({projectPreviews.length} 筆)</span>
            <button 
              onClick={() => {
                const next = projectPreviews.map(p => ({...p, action: p.status === 'NEW' ? 'INSERT' : 'SKIP'} as const));
                setProjectPreviews(next);
              }}
              className="text-xs px-2 py-1 bg-slate-700 rounded hover:bg-slate-600"
            >
              全選新資料
            </button>
          </div>
          <div className="overflow-y-auto flex-1 p-2">
            {projectPreviews.length === 0 ? (
              <div className="p-8 text-center text-slate-500">無舊資料</div>
            ) : (
              <div className="flex flex-col gap-2">
                {projectPreviews.map((pp, i) => (
                  <div key={i} className={`p-3 rounded-lg border ${pp.status === 'DUPLICATE' ? 'bg-orange-500/10 border-orange-500/30' : 'bg-slate-800 border-slate-700'} flex items-center justify-between`}>
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="font-bold truncate text-white">{pp.local.name}</div>
                      <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-2">
                        {pp.local.project_code && <span className="bg-slate-700 px-1.5 py-0.5 rounded">{pp.local.project_code}</span>}
                        <span className={`px-1.5 py-0.5 rounded ${pp.local.status === '已結案' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {pp.local.status || '未知狀態'}
                        </span>
                        {pp.reason && <span className="text-orange-400 truncate">⚠️ {pp.reason}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center">
                      <select 
                        value={pp.action} 
                        onChange={(e) => handleProjectAction(i, e.target.value as 'SKIP' | 'INSERT')}
                        className={`text-sm rounded border-none py-1 pl-2 pr-6 outline-none focus:ring-2 focus:ring-blue-500 ${pp.action === 'INSERT' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                      >
                        <option value="SKIP">⏭️ 略過</option>
                        <option value="INSERT">✅ 新增</option>
                        <option value="UPDATE" disabled>🔄 覆蓋 (不支援)</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <h3 className="text-2xl font-bold text-white mb-4 flex items-center gap-3">
              <Server className="text-blue-500" /> 二次確認
            </h3>
            <p className="text-slate-300 mb-6">
              您即將將所選資料寫入 Supabase 資料庫。<br/><br/>
              - 選擇新增的包商：<strong className="text-white">{contractorPreviews.filter(c => c.action === 'INSERT').length}</strong> 筆<br/>
              - 選擇新增的案場：<strong className="text-white">{projectPreviews.filter(p => p.action === 'INSERT').length}</strong> 筆<br/><br/>
              <span className="text-orange-400 flex items-center gap-2 text-sm"><AlertTriangle size={16}/> 既有資料不會被覆蓋，硬刪除功能未啟用。</span>
            </p>
            <div className="flex gap-4 justify-end">
              <button 
                onClick={() => setShowConfirm(false)}
                disabled={migrating}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white font-medium"
              >
                取消
              </button>
              <button 
                onClick={executeMigration}
                disabled={migrating}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white font-bold flex items-center gap-2"
              >
                {migrating ? '匯入中...' : '確認執行匯入'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
